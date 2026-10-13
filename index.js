// feishu-bridge — bridge one Feishu group chat and the Main Bot's own chat, both ways:
// a message sent in the group reaches the Bot like one typed in DSH, and the reply to
// that message goes back to the group.
//
// It runs in-process: the timer and the session listener start when the plugin applies
// and are disposed when DSH disposes the plugin, so closing DSH ends the polling and
// leaves nothing behind — no helper process, no scheduled task, no port.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'feishu-bridge'

const API = 'https://open.feishu.cn/open-apis'
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REPLY_MAX = 4000
const DEFAULTS = {
  appId: '',
  chatId: '',
  secretName: 'FEISHU_APP_SECRET',
  secretsPath: join(HOME, 'bot', 'secrets.json'),
  botStatePath: join(HOME, 'bot', 'state.json'),
  cursorPath: join(HOME, 'bot', 'feishu-bridge-cursor.json'),
  pollSeconds: 10,
  batchMax: 10,
  prefix: '[飞书群消息]',
}

// Plain text only. A system notice (a rename, a photo change, a join) also arrives as a
// "text" message, but its content is a JSON object of template fields, so anything that
// parses to an object without a `text` string is not something to act on.
function textOf(message) {
  const raw = message?.body?.content
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return raw
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    // Not JSON: some message types carry plain text.
  }
  return raw
}

// A mention renders as "@_user_1"; the Bot already knows the message is for it.
const clean = text => text.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim()

// Only a person's own words: not the Bot, not a system notice, not a card or a file.
function isUserText(message) {
  if (message?.sender?.sender_type !== 'user') return false
  if (message?.msg_type !== 'text') return false
  const text = clean(textOf(message))
  return text !== '' && !text.startsWith('{"template"')
}

// The text of a message's content blocks (an assistant message or a user message).
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('')
}

export function apply(ctx, config = {}) {
  // A bridge must never keep DSH from starting: any setup failure turns the bridge off
  // and is logged, while the rest of the host comes up as usual.
  try {
    install(ctx, config)
  } catch (error) {
    try { ctx?.logger?.warn?.(`feishu-bridge: install failed, bridge stays off: ${error?.message ?? error}`) } catch { /* ignore */ }
  }
}

function install(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  // 明文 appId/chatId 不进仓库：bundle 层只放占位符，真实值优先由 profile 的 patch 层
  // 覆盖（config 里已给真值时不读环境变量），否则退回环境变量。
  if (options.appId === '' || options.appId === undefined) {
    options.appId = process.env.FEISHU_BRIDGE_APP_ID ?? options.appId
  }
  if (options.chatId === '' || options.chatId === undefined) {
    options.chatId = process.env.FEISHU_BRIDGE_CHAT_ID ?? options.chatId
  }
  const log = (level, message) => {
    try { ctx?.logger?.[level]?.(`feishu-bridge: ${message}`) } catch { /* logging must never break the host */ }
  }
  if (typeof options.appId !== 'string' || options.appId === ''
    || typeof options.chatId !== 'string' || options.chatId === '') {
    log('warn', 'appId and chatId are required; the bridge stays off')
    return
  }

  let sessionController
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionController'], (sub) => {
      sessionController = sub.sessionController
      if (typeof sub.effect === 'function') {
        sub.effect(() => () => {
          if (sessionController === sub.sessionController) sessionController = undefined
        }, 'feishu-bridge: session controller')
      }
    })
  } else {
    sessionController = ctx.get?.('sessionController') ?? ctx.sessionController
  }

  const effect = (execute, label) => {
    if (typeof ctx.effect === 'function') ctx.effect(execute, label)
    else execute()
  }

  let stopped = false
  let ticking = false
  let token
  let tokenUntil = 0
  let cursor = null
  const seen = new Set()

  // The Main Bot's own chat, and the turn currently being answered.
  let mainSession
  let turnTexts = []
  // True while the running turn was started by a message the bridge delivered. Recognising
  // it by the delivered prefix keeps a conversation typed in DSH from being echoed to the
  // group, and makes each Feishu message answered by its own turn.
  let answeringFeishu = false

  async function readJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(value), 'utf8')
    await rename(temporary, path)
  }

  async function loadCursor() {
    if (cursor !== null) return cursor
    const saved = await readJson(options.cursorPath, null)
    cursor = typeof saved?.lastCreateTime === 'number' ? saved.lastCreateTime : null
    return cursor
  }

  async function secret() {
    const store = await readJson(options.secretsPath, null)
    const entry = store?.secrets?.find?.(item => item?.name === options.secretName)
    return typeof entry?.value === 'string' && entry.value !== '' ? entry.value : undefined
  }

  async function accessToken() {
    if (typeof token === 'string' && Date.now() < tokenUntil) return token
    const appSecret = await secret()
    if (appSecret === undefined) throw new Error(`secret ${options.secretName} is not saved`)
    const response = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => ({}))
    if (body?.code !== 0 || typeof body?.tenant_access_token !== 'string') {
      throw new Error(`token request refused (code ${body?.code ?? '?'})`)
    }
    token = body.tenant_access_token
    // Refresh well before the two-hour expiry.
    tokenUntil = Date.now() + Math.max(60_000, (Number(body.expire) || 7200) * 1000 - 300_000)
    return token
  }

  async function messages() {
    const url = `${API}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(options.chatId)}`
      + '&sort_type=ByCreateTimeDesc&page_size=20'
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => ({}))
    if (body?.code !== 0) throw new Error(`message list refused (code ${body?.code ?? '?'})`)
    return Array.isArray(body?.data?.items) ? body.data.items : []
  }

  // Post one text message into the group.
  async function send(text) {
    const trimmed = text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\n…（回复过长，已截断）` : text
    const response = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: options.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: trimmed }),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => ({}))
    if (body?.code !== 0) throw new Error(`send refused (code ${body?.code ?? '?'})`)
  }

  // The Main Bot's current own chat, read fresh so a fresh chat part is followed.
  async function refreshMainSession() {
    const state = await readJson(options.botStatePath, null)
    const id = state?.mainBotIds?.[0]
    if (typeof id !== 'string') return undefined
    const bot = state?.bots?.[id]
    const next = typeof bot?.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : id
    // A fresh chat part is a different Session; drop any half-collected turn.
    if (next !== mainSession) {
      mainSession = next
      turnTexts = []
      answeringFeishu = false
    }
    return mainSession
  }

  async function deliver(record) {
    if (sessionController === undefined) return false
    const sessionId = await refreshMainSession()
    if (sessionId === undefined) {
      log('warn', 'no Main Bot chat to deliver to')
      return false
    }
    await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `${options.prefix} ${record.text}` }],
    }, AbortSignal.timeout(30_000))
    return true
  }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      const items = await messages()
      await refreshMainSession()
      const known = await loadCursor()
      if (known === null) {
        // First run: adopt the newest message so history is not replayed.
        const newest = items.reduce((max, item) => Math.max(max, Number(item?.create_time) || 0), 0)
        cursor = newest
        await writeJson(options.cursorPath, { lastCreateTime: newest, chatId: options.chatId })
        log('info', `cursor initialised at ${newest}`)
        return
      }

      const fresh = items
        .filter(item => {
          const time = Number(item?.create_time) || 0
          if (time <= cursor) return false
          const id = item?.message_id
          if (typeof id === 'string' && seen.has(id)) return false
          return true
        })
        .sort((a, b) => (Number(a?.create_time) || 0) - (Number(b?.create_time) || 0))
        .slice(0, options.batchMax)

      for (const item of fresh) {
        const id = String(item?.message_id ?? '')
        const time = Number(item?.create_time) || 0
        // Anything that is not the user's own text (a system notice, a card, the Bot's
        // own echo) advances the cursor without being delivered.
        if (!isUserText(item)) {
          cursor = time
          if (id !== '') seen.add(id)
          continue
        }
        const text = clean(textOf(item))
        const ok = await deliver({ text, time, id })
        if (!ok) break
        cursor = time
        if (id !== '') seen.add(id)
      }
      await writeJson(options.cursorPath, { lastCreateTime: cursor, chatId: options.chatId })
    } catch (error) {
      log('warn', `poll failed: ${error?.message ?? error}`)
    } finally {
      ticking = false
    }
  }

  // The reply to a Feishu message goes back to the group. A turn is forwarded only when
  // the message that opened it was one the bridge delivered, so a conversation typed in
  // DSH stays in DSH.
  function onSessionEvent(session, event) {
    if (mainSession === undefined || session?.id !== mainSession) return
    switch (event?.type) {
      case 'user/message': {
        // The turn this message opens is a Feishu turn when the message carries the
        // bridge's own prefix.
        const text = blocksToText(event.data?.content)
        answeringFeishu = text.startsWith(options.prefix)
        break
      }
      case 'turn/start':
        turnTexts = []
        break
      case 'assistant/message': {
        const text = blocksToText(event.data?.message?.content).trim()
        if (text !== '') turnTexts.push(text)
        break
      }
      case 'turn/end': {
        const owed = answeringFeishu
        const text = turnTexts.join('\n\n').trim()
        turnTexts = []
        answeringFeishu = false
        if (owed && text !== '') {
          void send(text).catch(error => log('warn', `reply send failed: ${error?.message ?? error}`))
        }
        break
      }
    }
  }

  effect(() => {
    stopped = false
    void tick()
    const timer = setInterval(() => { void tick() }, Math.max(2, Number(options.pollSeconds) || 10) * 1000)
    timer.unref?.()
    const off = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : undefined
    return () => {
      stopped = true
      clearInterval(timer)
      if (typeof off === 'function') off()
    }
  }, 'feishu-bridge: poll')
}
