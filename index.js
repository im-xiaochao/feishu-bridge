// feishu-bridge — bridge one Feishu group chat and the Main Bot's own chat, both ways:
// a message sent in the group reaches the Bot like one typed in DSH, and the reply to
// that message goes back to the group.
//
// It runs in-process: the timer and the session listener start when the plugin applies
// and are disposed when DSH disposes the plugin, so closing DSH ends the polling and
// leaves nothing behind — no helper process, no scheduled task, no port.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'feishu-bridge'

const API = 'https://open.feishu.cn/open-apis'
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
// A card's markdown element is happier with a few thousand characters; longer replies are
// posted as several cards rather than truncated.
const CHUNK_MAX = 3500
// How many polls a failing picture may hold the cursor before it is passed over. Bounded
// so one unreadable image can never freeze every later message.
const IMAGE_MAX_ATTEMPTS = 3
// How many archived pictures are remembered for idempotent retries. See the note on the
// `archived` map for why this is a cap rather than unbounded.
const IMAGE_ARCHIVE_MEMORY = 500
// The Feishu resource download endpoint speaks these; the file signature decides the
// extension, since a message only carries an opaque image_key.
const IMAGE_EXTENSIONS = [
  { ext: '.png', mediaType: 'image/png', matches: bytes => bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { ext: '.jpg', mediaType: 'image/jpeg', matches: bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { ext: '.gif', mediaType: 'image/gif', matches: bytes => bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 },
  { ext: '.webp', mediaType: 'image/webp', matches: bytes => bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 },
]

// The plugin's own config schema. `appId` / `chatId` / `secretName` / `pollSeconds` are
// marked `.volatile()` so they appear in the settings form and can be edited there;
// without the marker the settings write gate rejects the edit (it looks like it saved,
// then silently reverts). Volatile fields need a fixed object path — none may sit inside
// another volatile. The remaining paths are host-internal and deliberately not editable.
export const Config = z.object({
  appId: z.string().default('').volatile()
    .description('飞书自建应用 App ID（cli_ 开头），留空则不启动桥接'),
  chatId: z.string().default('').volatile()
    .description('飞书群 chat_id（oc_ 开头），留空则不启动桥接'),
  secretName: z.string().default('FEISHU_APP_SECRET').volatile()
    .description('存放 App Secret 的凭据条目名（不是环境变量名）'),
  pollSeconds: z.number().default(10).volatile()
    .description('轮询间隔秒数，最小 2 秒'),
  picDir: z.string().default(join(HOME, 'Pic')).volatile()
    .description('群图片归档目录：每张图片写到这里，且只写这里'),
  botStatePath: z.string().default(join(HOME, 'bot', 'state.json')),
  cursorPath: z.string().default(join(HOME, 'bot', 'feishu-bridge-cursor.json')),
  batchMax: z.number().default(10),
  prefix: z.string().default('[飞书群消息]'),
})

// Where the pre-credentials secret store lives. Kept as a module constant rather than a
// config field: it is a fixed legacy location, not something a user configures. Only the
// fallback path reads it, for installs that stored the secret before the credentials seam.
const LEGACY_SECRETS_PATH = join(HOME, 'bot', 'secrets.json')

// The config keys this plugin reads, in one place. Kept explicit rather than derived from
// the schema's internals: the schema above must stay in step with this list.
const CONFIG_KEYS = [
  'appId',
  'chatId',
  'secretName',
  'botStatePath',
  'cursorPath',
  'pollSeconds',
  'picDir',
  'batchMax',
  'prefix',
]

// Fallbacks used when a key is absent from the resolved config — e.g. a profile that
// still points at an older patch, or a direct `apply()` call with no config at all. The
// schema's own `.default()` is what the loader normally supplies; these keep the plugin
// behaving exactly as before if it is not applied through the loader.
const FALLBACKS = {
  appId: '',
  chatId: '',
  secretName: 'FEISHU_APP_SECRET',
  botStatePath: join(HOME, 'bot', 'state.json'),
  cursorPath: join(HOME, 'bot', 'feishu-bridge-cursor.json'),
  pollSeconds: 10,
  picDir: join(HOME, 'Pic'),
  batchMax: 10,
  prefix: '[飞书群消息]',
}

// A volatile field resolves to a wrapper; read it with `.get()` where it is one, and
// take the plain value otherwise, so the rest of the plugin keeps reading plain fields.
const valueOf = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function'
  ? value.get()
  : value)


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

// The image_key inside an image message, or '' when the message is not one. An image
// message carries `{"image_key":"img_xxx"}`; anything else parses to ''.
function imageKeyOf(message) {
  const raw = message?.body?.content
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.image_key === 'string' ? parsed.image_key : ''
  } catch {
    return ''
  }
}

// A person's picture, and only that: the Bot's own echo, a system notice and a card are
// all excluded the same way text messages are. Kept separate from isUserText so the text
// path keeps its exact meaning.
function isUserImage(message) {
  if (message?.sender?.sender_type !== 'user') return false
  if (message?.msg_type !== 'image') return false
  return imageKeyOf(message) !== ''
}

// A rich-text ("post") message embeds its images as image_key tags inside the post body.
// Walk the parsed JSON for any image_key so a picture posted with text is still archived;
// a shape we do not recognise simply yields none, and the message is left alone.
function postImageKeys(message) {
  const raw = message?.body?.content
  if (typeof raw !== 'string') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const keys = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node.image_key === 'string' && node.image_key !== '') keys.push(node.image_key)
    for (const value of Object.values(node)) walk(value)
  }
  walk(parsed)
  return keys
}

// The extension and media type a downloaded body actually is, decided by its own bytes:
// the download endpoint does not tell us, and an image_key carries no extension.
function imageFormatOf(bytes) {
  return IMAGE_EXTENSIONS.find(format => format.matches(bytes))
}

// Local date and time, with milliseconds so two pictures in the same second never collide.
// Example: 20261014-181530-482.
function imageFileName(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`
}

// Whether an image failure will never resolve on its own. A recalled or expired picture
// must be skipped rather than retried forever, because the cursor only advances past it
// when the message is given up on; a transient failure is retried on the next poll.
function isPermanentImageError(error) {
  return error?.imagePermanent === true
}

function permanentImageError(message) {
  const error = new Error(message)
  error.imagePermanent = true
  return error
}

function transientImageError(message) {
  const error = new Error(message)
  error.imagePermanent = false
  return error
}

// The text of a message's content blocks (an assistant message or a user message).
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('')
}

// A long reply is split on line boundaries into card-sized parts, so nothing is lost and
// no part is cut mid-sentence where it can be helped.
function chunk(text, limit = CHUNK_MAX) {
  if (text.length <= limit) return [text]
  const parts = []
  let current = ''
  for (const line of text.split('\n')) {
    // A single line longer than the limit is cut hard; nothing else can fit it.
    if (line.length > limit) {
      if (current !== '') { parts.push(current); current = '' }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit))
      continue
    }
    if (current !== '' && current.length + line.length + 1 > limit) {
      parts.push(current)
      current = line
    } else {
      current = current === '' ? line : `${current}\n${line}`
    }
  }
  if (current !== '') parts.push(current)
  return parts
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
  // The loader hands us the resolved config; volatile fields arrive as wrappers and are
  // unwrapped here once, so everything below reads plain values. Any key the resolved
  // config does not carry falls back to FALLBACKS, keeping the pre-schema behaviour.
  const options = {}
  for (const key of CONFIG_KEYS) {
    const value = valueOf(config?.[key])
    options[key] = value === undefined ? FALLBACKS[key] : value
  }
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
  // Consecutive failures per picture message id, so a permanently unreadable image is
  // eventually skipped rather than holding the cursor forever.
  const imageFailures = new Map()
  // Archive result per picture (message id plus image_key), so retrying a delivery that
  // failed after the write reuses the file already in picDir instead of writing a
  // second one under a fresh timestamp.
  //
  // Bounded to IMAGE_ARCHIVE_MEMORY entries, oldest first. Evicting an entry only forgets
  // that the file exists: a retry arriving after eviction writes a fresh copy under a new
  // timestamp. That is the deliberate trade — the window covers any realistic retry
  // (IMAGE_MAX_ATTEMPTS polls), and an unbounded map would grow for the life of the
  // process. A duplicate here is preferable to a leak; it is not a bug to be "fixed" by
  // removing the cap.
  const archived = new Map()

  // The Main Bot's own chat, and the turn currently being answered.
  let mainSession
  let turnTexts = []
  // True once a message the bridge delivered has opened a turn, until that turn ends.
  // Recognising the message by the delivered prefix keeps a conversation typed in DSH
  // from being echoed to the group, and makes each Feishu message answered by its own turn.
  let feishuPending = false
  // Whether the Main Bot's own chat is inside a turn right now, and who opened it:
  // 'feishu' when the bridge's own prefixed message did, 'dsh' when the user typed in
  // DSH. This decides how a new Feishu message is delivered — see deliveryMode().
  let turnRunning = false
  let turnOwner

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

  // App Secret 先走 DSH 官方凭据 seam（ctx.credentials.resolve，键名由 secretName 指定），
  // 取不到再回退读老的 ~/.dsh/bot/secrets.json，兼容改造前已存好的密钥，避免要求用户重填。
  // 官方 seam 的查找优先级由 provider 决定（启动环境 > 存储文件 > .env 兜底）。
  async function secret() {
    const fromSeam = await secretFromCredentials()
    if (fromSeam !== undefined) return fromSeam
    return secretFromLegacyStore()
  }

  async function secretFromCredentials() {
    const svc = credentials()
    if (typeof svc?.resolve !== 'function') return undefined
    const name = options.secretName
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      // 名字不符合凭据引用语法（REF_PATTERN）时不能硬转，当作「此处没有」交给回退路径。
      log('warn', `secretName "${name}" is not a valid credential reference; using the legacy store`)
      return undefined
    }
    try {
      // credentialRef() 只是「校验 REF_PATTERN + 原样返回字符串」（brandString 是恒等函数），
      // 这里内联等价逻辑，避免为一个纯校验多引一个包。上面已先做过同样的正则校验。
      const hit = await svc.resolve(name)
      return typeof hit?.value === 'string' && hit.value !== '' ? hit.value : undefined
    } catch (error) {
      log('warn', `credential lookup failed, falling back to the legacy store: ${error?.message ?? error}`)
      return undefined
    }
  }

  async function secretFromLegacyStore() {
    try {
      const store = await readJson(LEGACY_SECRETS_PATH, null)
      const entry = store?.secrets?.find?.(item => item?.name === options.secretName)
      return typeof entry?.value === 'string' && entry.value !== '' ? entry.value : undefined
    } catch (error) {
      log('warn', `legacy secret store unreadable: ${error?.message ?? error}`)
      return undefined
    }
  }

  // 取凭据服务；插件在没有该服务的 composition 里仍要能工作（返回 undefined 即走回退）。
  function credentials() {
    try {
      if (typeof ctx.inject === 'function') {
        const sub = ctx.get?.('credentials')
        if (sub !== undefined) return sub
      }
      return ctx.get?.('credentials') ?? ctx.credentials
    } catch {
      return undefined
    }
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

  // Fetch one image's bytes from the group. The endpoint returns the raw body, not JSON,
  // so a refusal is read from the status line and the body is taken verbatim otherwise.
  //
  // A 4xx means this particular picture will never be readable (it was recalled, its
  // resource expired, or the key is stale): retrying it forever would freeze the cursor
  // and block every later message, so it is marked permanent and the caller skips it.
  // Everything else (network trouble, 5xx, a timeout) is transient and worth retrying.
  async function downloadImage(messageId, fileKey) {
    const url = `${API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=image`
    let response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw transientImageError(`image download failed: ${error?.message ?? error}`)
    }
    if (!response.ok) {
      const detail = `image download refused (HTTP ${response.status})`
      if (response.status >= 400 && response.status < 500) throw permanentImageError(detail)
      throw transientImageError(detail)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw transientImageError('image download returned no bytes')
    return bytes
  }

  // Write one image into options.picDir and nowhere else. The bytes land in a `.part` file
  // inside the same directory first, then get renamed into place, so a half-written file
  // never appears under the final name; the temporary is removed in every outcome.
  async function saveImageFile(bytes) {
    const format = imageFormatOf(bytes)
    if (format === undefined) throw new Error('downloaded bytes are not a recognised image format')
    await mkdir(options.picDir, { recursive: true })
    const name = `${imageFileName()}${format.ext}`
    const target = join(options.picDir, name)
    const temporary = `${target}.part`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, target)
    } catch (error) {
      // Nothing half-written may survive a failure, including the rename itself.
      await unlink(temporary).catch(() => {})
      throw error
    }
    return { path: target, name, format, bytes: bytes.length }
  }

  // Post one reply into the group. A card with a markdown element renders the reply's
  // own formatting (bold, lists, links, code), which a plain text message would show as
  // literal asterisks and pipes.
  async function send(text) {
    for (const part of chunk(text)) {
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: part }],
      }
      const response = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: options.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json().catch(() => ({}))
      if (body?.code !== 0) throw new Error(`send refused (code ${body?.code ?? '?'})`)
    }
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
      feishuPending = false
    }
    return mainSession
  }

  // How a Feishu message is handed to the Main Bot's own chat.
  //
  // `steer` cuts into a running turn at its next step and starts a turn at once when the
  // chat is idle, so a message the user sends in the group is seen immediately instead of
  // waiting behind whatever is running — that is the whole point of this choice.
  //
  // But steering into a turn that the *user* opened in DSH would make the group answer a
  // DSH conversation: the reply that turn ends with is posted to the group, and the group
  // has no business seeing it. So a turn opened in DSH keeps the queueing behaviour, and
  // only an idle chat, or a turn the bridge itself opened, is steered into.
  function deliveryMode() {
    if (!turnRunning) return 'steer'
    return turnOwner === 'feishu' ? 'steer' : 'queue'
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
      mode: deliveryMode(),
      content: [{ type: 'text', text: `${options.prefix} ${record.text}` }],
    }, AbortSignal.timeout(30_000))
    return true
  }

  // A picture is archived to picDir and handed to the Bot in the same prompt: the
  // image block carries the bytes as base64, so the Bot sees the picture itself, and the
  // text block carries the absolute path so it also knows where the archive copy lives.
  //
  // The prefix must stay at the very start of the text block: the reply routing
  // recognises a delivered turn by `blocksToText(...).startsWith(prefix)`.
  //
  // `session/prompt` accepts an image block as `{ type, mediaType, data }` with base64
  // bytes — no receipt is involved (only a `file` block needs one). The Host admits the
  // bytes itself through the attachment service, which is what stores the framework's
  // internal read-only copy.
  //
  // Archiving is idempotent per `archiveKey`: the bytes are written once and the same
  // path is reused when a later attempt retries the prompt. A retry after a prompt
  // failure must never leave a second copy in picDir — the folder holds one file per
  // message, and the timestamped name would otherwise differ on every attempt.
  async function deliverImage(record) {
    if (sessionController === undefined) return false
    const sessionId = await refreshMainSession()
    if (sessionId === undefined) {
      log('warn', 'no Main Bot chat to deliver to')
      return false
    }
    const key = record.archiveKey
    let saved = key === undefined ? undefined : archived.get(key)
    if (saved === undefined) {
      saved = await saveImageFile(record.bytes)
      log('info', `image saved to ${saved.path} (${saved.bytes} bytes)`)
      if (key !== undefined) {
        archived.set(key, saved)
        // Map iterates in insertion order, so the first key is the oldest.
        while (archived.size > IMAGE_ARCHIVE_MEMORY) archived.delete(archived.keys().next().value)
      }
    } else {
      log('info', `image already archived at ${saved.path}, retrying delivery only`)
    }
    await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: deliveryMode(),
      content: [
        { type: 'text', text: `${options.prefix} [图片] 已保存：${saved.path}` },
        { type: 'image', mediaType: saved.format.mediaType, data: record.bytes.toString('base64'), name: saved.name },
      ],
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
        // A person's picture is archived and announced; the cursor only advances once it
        // has been. A failure is classified so one bad picture can never freeze the rest:
        //   - permanent (4xx: recalled, expired, stale key) → warn and skip, cursor moves on
        //   - transient (network, 5xx) → stop this batch and retry on the next poll
        //   - repeated transient → after IMAGE_MAX_ATTEMPTS, give up and move on
        // Either way the text path is untouched, and the next message is never blocked.
        if (isUserImage(item)) {
          try {
            const fileKey = imageKeyOf(item)
            const bytes = await downloadImage(id, fileKey)
            const ok = await deliverImage({ bytes, time, id, archiveKey: `${id}/${fileKey}` })
            if (!ok) break
            cursor = time
            if (id !== '') { seen.add(id); imageFailures.delete(id) }
          } catch (error) {
            const reason = error?.message ?? error
            const attempts = (imageFailures.get(id) ?? 0) + 1
            const giveUp = isPermanentImageError(error) || attempts >= IMAGE_MAX_ATTEMPTS
            if (!giveUp) {
              imageFailures.set(id, attempts)
              log('warn', `image from ${id || '(unknown id)'} not archived (attempt ${attempts}/${IMAGE_MAX_ATTEMPTS}, will retry): ${reason}`)
              break
            }
            log('warn', `image from ${id || '(unknown id)'} skipped after ${attempts} attempt(s): ${reason}`)
            cursor = time
            if (id !== '') { seen.add(id); imageFailures.delete(id) }
          }
          continue
        }
        // A rich-text message may embed pictures. They are archived like a plain image
        // message; a post with no image, or one whose shape we do not recognise, falls
        // through to the text path unchanged.
        if (item?.sender?.sender_type === 'user' && item?.msg_type === 'post') {
          const keys = postImageKeys(item)
          if (keys.length > 0) {
            try {
              for (const key of keys) {
                const bytes = await downloadImage(id, key)
                await deliverImage({ bytes, time, id, archiveKey: `${id}/${key}` })
              }
              cursor = time
              if (id !== '') { seen.add(id); imageFailures.delete(id) }
            } catch (error) {
              const reason = error?.message ?? error
              const attempts = (imageFailures.get(id) ?? 0) + 1
              const giveUp = isPermanentImageError(error) || attempts >= IMAGE_MAX_ATTEMPTS
              if (!giveUp) {
                imageFailures.set(id, attempts)
                log('warn', `post images from ${id || '(unknown id)'} not archived (attempt ${attempts}/${IMAGE_MAX_ATTEMPTS}, will retry): ${reason}`)
                break
              }
              log('warn', `post images from ${id || '(unknown id)'} skipped after ${attempts} attempt(s): ${reason}`)
              cursor = time
              if (id !== '') { seen.add(id); imageFailures.delete(id) }
            }
            continue
          }
        }
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
  //
  // A turn receives more than one user/message: DSH's time-context plugin injects a
  // synthetic clock message right after the real one, and a message queued while a turn
  // runs lands after that turn's end. So only the bridge's own prefix may raise the flag,
  // and nothing but turn/end may clear it — clearing it on any user/message is what
  // silently swallowed every reply.
  function onSessionEvent(session, event) {
    const id = session?.id
    if (typeof id !== 'string') return
    // Only the Main Bot's own chat is answered. Before the first poll has resolved which
    // Session that is, a message carrying the bridge's prefix is proof enough — nothing
    // else delivers it — so a message arriving in that first moment is not dropped.
    const isMain = mainSession !== undefined && id === mainSession
    const isPrefixed = event?.type === 'user/message'
      && blocksToText(event.data?.content).startsWith(options.prefix)
    if (!isMain && !(isPrefixed && mainSession === undefined)) return
    if (!isMain) mainSession = id
    switch (event?.type) {
      case 'turn/start':
        turnTexts = []
        // The turn's owner is decided by what opened it. A DSH-typed message is any
        // user/message that is not the bridge's own prefix; the bridge only ever opens a
        // turn with that prefix, so this cannot misread its own delivery.
        turnRunning = true
        turnOwner = 'dsh'
        break
      case 'user/message': {
        if (isPrefixed) {
          feishuPending = true
          // A steered or queued Feishu message is what opened this turn.
          turnOwner = 'feishu'
        }
        break
      }
      case 'assistant/message': {
        // Only the last assistant text is the turn's reply; earlier ones are the
        // running commentary of its steps and would be noise in the group.
        const text = blocksToText(event.data?.message?.content).trim()
        if (text !== '') turnTexts = [text]
        break
      }
      case 'turn/end': {
        const owed = feishuPending
        const text = turnTexts.join('\n\n').trim()
        turnTexts = []
        feishuPending = false
        turnRunning = false
        turnOwner = undefined
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
