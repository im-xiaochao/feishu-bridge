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
  directChatIds: z.array(z.string()).default([]).volatile()
    .description('要监听的飞书私聊 chat_id 列表（oc_ 开头）。飞书的会话列表接口不返回私聊，所以每个私聊都得写在这里'),
  secretName: z.string().default('FEISHU_APP_SECRET').volatile()
    .description('存放 App Secret 的凭据条目名（不是环境变量名）'),
  pollSeconds: z.number().default(10).volatile()
    .description('轮询间隔秒数，最小 2 秒'),
  picDir: z.string().default(join(HOME, 'Pic')).volatile()
    .description('群图片归档目录：每张图片写到这里，且只写这里'),
  botStatePath: z.string().default(join(HOME, 'bot', 'state.json')),
  cursorPath: z.string().default(join(HOME, 'bot', 'feishu-bridge-cursor.json')),
  batchMax: z.number().default(10),
  // The mark a group message carries. Kept configurable for older installs that already
  // filter on it; a direct message gets `directPrefix` instead, so the Bot can tell the two
  // apart at a glance. Both must start with a non-empty bracket so the delivered turn is
  // still recognised as coming from Feishu (see onSessionEvent).
  prefix: z.string().default('[飞书群消息]'),
  directPrefix: z.string().default('[飞书私聊消息]'),
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
  'directChatIds',
  'secretName',
  'botStatePath',
  'cursorPath',
  'pollSeconds',
  'picDir',
  'batchMax',
  'prefix',
  'directPrefix',
]

// Fallbacks used when a key is absent from the resolved config — e.g. a profile that
// still points at an older patch, or a direct `apply()` call with no config at all. The
// schema's own `.default()` is what the loader normally supplies; these keep the plugin
// behaving exactly as before if it is not applied through the loader.
const FALLBACKS = {
  appId: '',
  chatId: '',
  directChatIds: [],
  secretName: 'FEISHU_APP_SECRET',
  botStatePath: join(HOME, 'bot', 'state.json'),
  cursorPath: join(HOME, 'bot', 'feishu-bridge-cursor.json'),
  pollSeconds: 10,
  picDir: join(HOME, 'Pic'),
  batchMax: 10,
  prefix: '[飞书群消息]',
  directPrefix: '[飞书私聊消息]',
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
  // 私聊列表可以走环境变量（逗号分隔），方便本机配置不进仓库。
  if ((!Array.isArray(options.directChatIds) || options.directChatIds.length === 0)
    && typeof process.env.FEISHU_BRIDGE_DIRECT_CHAT_IDS === 'string'
    && process.env.FEISHU_BRIDGE_DIRECT_CHAT_IDS !== '') {
    options.directChatIds = process.env.FEISHU_BRIDGE_DIRECT_CHAT_IDS.split(',').map(s => s.trim()).filter(Boolean)
  }
  if (!Array.isArray(options.directChatIds)) options.directChatIds = []
  const log = (level, message) => {
    try { ctx?.logger?.[level]?.(`feishu-bridge: ${message}`) } catch { /* logging must never break the host */ }
  }
  // The mark a delivered message carries, so the Bot (and the user reading the DSH chat)
  // can tell a group message from a direct one at a glance. Both marks are recognised as
  // coming from Feishu, which is what routes the reply back — see isFromFeishu().
  const markOf = (from) => (from === 'direct' ? options.directPrefix : options.prefix)
  // Every mark the bridge may deliver with. A delivered turn is recognised by any of them.
  const feishuMarks = () => [options.prefix, options.directPrefix].filter(m => typeof m === 'string' && m !== '')
  const isFromFeishu = (text) => feishuMarks().some(mark => text.startsWith(mark))
  // Where unsolicited output goes — a DSH turn mirrored out, or a reply whose own
  // The direct chat the whole conversation is copied to: every turn — one opened in DSH,
  // one opened in the group, one opened in a direct chat — leaves a copy here, so the
  // phone shows one continuous record. Undefined when no direct chat is configured.
  const privateChat = () => (Array.isArray(options.directChatIds) && options.directChatIds.length > 0
    ? options.directChatIds[0]
    : undefined)
  // Where unsolicited output goes — a turn the user opened in DSH has no Feishu message
  // behind it. The private chat when there is one, the group otherwise.
  const mirrorTo = () => privateChat() ?? options.chatId
  // Where the answer to one delivered message goes: back to the conversation that asked.
  // A question written in the group is answered in the group; a private one privately.
  // The copy in the private chat is sendPrivateCopy()'s job, not this one's.
  const replyTarget = (record) => (record.from === 'direct' ? record.chatId : options.chatId)
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
  // Where the answer to the Feishu message that opened the current turn belongs. A direct
  // chat stays direct: answering it into the group would publish a private word.
  let replyTo
  let replyFrom = 'group'
  // What the user wrote in the message that opened this turn, so the private copy can show
  // the question next to the answer.
  let turnAsked = ''

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

  // One cursor per conversation. The group keeps the key the file has always used, so an
  // existing install carries on from where it was; each direct chat gets its own entry.
  async function loadCursor(chatId = options.chatId) {
    if (chatId === options.chatId && cursor !== null) return cursor
    const saved = await readJson(options.cursorPath, null)
    const value = chatId === options.chatId
      ? (typeof saved?.lastCreateTime === 'number' ? saved.lastCreateTime : null)
      : (typeof saved?.direct?.[chatId] === 'number' ? saved.direct[chatId] : null)
    if (chatId === options.chatId) cursor = value
    return value
  }

  async function saveCursor(chatId, value) {
    const saved = await readJson(options.cursorPath, null)
    const direct = { ...(saved?.direct ?? {}) }
    if (chatId === options.chatId) {
      cursor = value
      await writeJson(options.cursorPath, { ...(saved ?? {}), lastCreateTime: value, chatId: options.chatId, direct })
      return
    }
    direct[chatId] = value
    await writeJson(options.cursorPath, { ...(saved ?? {}), direct })
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

  // The Bot's direct chats. Feishu's chat list only returns the groups a Bot belongs to,
  // never its one-to-one chats, so they cannot be discovered — each must be configured.
  // The list is read here and folded into openDirectChats() below.
  async function directChats() {
    const configured = Array.isArray(options.directChatIds)
      ? options.directChatIds.filter(id => typeof id === 'string' && id !== '')
      : []
    if (configured.length > 0) return configured.map(chatId => ({ chat_id: chatId }))
    // Fallback: try the chat list anyway, in case a later Feishu version includes them.
    try {
      const url = `${API}/im/v1/chats?page_size=50`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json().catch(() => ({}))
      if (body?.code !== 0) return []
      const items = Array.isArray(body?.data?.items) ? body.data.items : []
      return items.filter(item => item?.chat_mode === 'p2p' && typeof item?.chat_id === 'string')
    } catch {
      return []
    }
  }

  // Messages in one conversation, group or direct. The endpoint is the same; only the
  // container differs, and the caller decides what to do with what comes back.
  async function messagesIn(chatId) {
    const url = `${API}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}`
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

  // Feishu's card markdown does not render pipe tables: it shows the pipes as typed. So a
  // table is lifted out of the reply and posted as the card's own table element, and the
  // prose around it stays in markdown elements. Everything the Bot writes keeps looking as
  // it should, and a reply with no table is unchanged.
  //
  // A table is a header row, a delimiter row of dashes, and its body rows, all starting and
  // ending with a pipe. Only that shape is taken; anything looser is left as markdown.
  const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split('|').map(cell => cell.trim())
  }
  // One cell's markdown, flattened for the table element, which takes plain text.
  function cellText(markdown) {
    return markdown
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/^_+|_+$/g, '')
      .trim()
  }
  function tableElement(header, rows) {
    return {
      tag: 'table',
      page_size: Math.max(5, rows.length),
      row_height: 'low',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        bold: true,
        lines: 1,
      },
      columns: header.map((name, index) => ({
        name: `c${index}`,
        display_name: cellText(name) || `列${index + 1}`,
        data_type: 'text',
        horizontal_align: 'left',
        width: 'auto',
      })),
      rows: rows.map(cells => Object.fromEntries(
        header.map((_, index) => [`c${index}`, cellText(cells[index] ?? '')]),
      )),
    }
  }
  // The reply as card elements: prose runs as markdown, each table as a table element.
  function cardElements(text) {
    const lines = text.split('\n')
    const elements = []
    let prose = []
    const flushProse = () => {
      const joined = prose.join('\n').trim()
      if (joined !== '') elements.push({ tag: 'markdown', content: joined })
      prose = []
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const next = lines[index + 1]
      const isTable = line.trim().startsWith('|') && typeof next === 'string' && TABLE_DELIMITER.test(next)
      if (!isTable) {
        prose.push(line)
        continue
      }
      // Collect the body: every following line that still opens or closes with a pipe.
      const header = splitTableRow(line)
      const rows = []
      let cursor = index + 2
      for (; cursor < lines.length; cursor++) {
        const row = lines[cursor]
        if (!row.trim().startsWith('|')) break
        rows.push(splitTableRow(row))
      }
      // A header with no body is not a table worth rendering — leave it as written.
      if (rows.length === 0) {
        prose.push(line)
        continue
      }
      flushProse()
      elements.push(tableElement(header, rows))
      index = cursor - 1
    }
    flushProse()
    return elements.length > 0 ? elements : [{ tag: 'markdown', content: text }]
  }

  // Post one reply back to the conversation the question came from — the group for a group
  // message, the direct chat for a direct one — so a private word never lands in the group.
  // A card with a markdown element renders the reply's own formatting (bold, lists, links,
  // code), which a plain text message would show as literal asterisks and pipes; a table is
  // posted as the card's own table element, see cardElements().
  async function send(text, to = options.chatId) {
    // Split on size first, so a very long reply still arrives in card-sized parts, then turn
    // each part's tables into elements.
    for (const part of chunk(text)) {
      const card = {
        config: { wide_screen_mode: true },
        elements: cardElements(part),
      }
      const response = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: to,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json().catch(() => ({}))
      if (body?.code !== 0) throw new Error(`send refused (code ${body?.code ?? '?'})`)
    }
  }

  // Copy one finished turn into the private chat, so the phone keeps a single record of the
  // whole conversation: what was said in a group, what the Bot answered there, and what was
  // said at the desk. The copy names the conversation it came from, and is skipped when the
  // turn happened in the private chat itself — it is already there.
  //
  // `asked` is what the user wrote (undefined when the turn has no user line of its own);
  // `answer` is the Bot's reply. Either may be empty. Nothing is copied when both are.
  async function sendPrivateCopy(from, asked, answer) {
    const to = privateChat()
    if (to === undefined || to === from) return
    const where = from === options.chatId ? '群聊' : '私聊'
    const lines = []
    if (typeof asked === 'string' && asked.trim() !== '') lines.push(`**你（在${where}）：**\n${asked.trim()}`)
    if (typeof answer === 'string' && answer.trim() !== '') lines.push(`**我：**\n${answer.trim()}`)
    if (lines.length === 0) return
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'grey', title: { tag: 'plain_text', content: `聊天记录同步（来自${where}）` } },
      elements: lines.map(content => ({ tag: 'markdown', content })),
    }
    const response = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ receive_id: to, msg_type: 'interactive', content: JSON.stringify(card) }),
      signal: AbortSignal.timeout(20_000),
    })
    const sent = await response.json().catch(() => ({}))
    if (sent?.code !== 0) throw new Error(`private copy refused (code ${sent?.code ?? '?'})`)
  }

  // Mirror one message the user typed in DSH into the group, so the phone sees both halves
  // of the conversation. It goes as its own card marked as coming from DSH, which keeps it
  // apart from the Bot's replies (those have no such header) and from anything the user
  // writes in Feishu itself (delivered the other way, never echoed back).
  //
  // A message is skipped when it is DSH's own synthetic clock, or when it is the bridge's
  // prefixed delivery coming back around: that one already exists in the group.
  // DSH injects system messages into a Session as if they were user messages: a running
  // clock, a changed skill catalogue, a snapshot of the runtime context. None of them is
  // something the user typed, and mirroring one puts build noise in the user's phone. They
  // are told apart by how the line opens, which the plugins write in a fixed shape.
  //
  // Cut such notices off a message, keeping what the user typed. They are appended as whole
  // lines, so the cut is made at the first line that opens one — and a user's own words
  // never start that way.
  const NOTICE_LINE = /^(<system-reminder>|current runtime context\.|time sampled while preparing|the available skill catalog changed|instructions from:|\[?(current time|当前时间))/i
  const stripSynthetic = (text) => {
    const lines = text.split('\n')
    const cut = lines.findIndex(line => NOTICE_LINE.test(line.trim()))
    return (cut === -1 ? text : lines.slice(0, cut).join('\n')).trim()
  }

  async function sendUserMirror(text) {
    // Either mark means this already exists in Feishu — never echo it back.
    if (isFromFeishu(text.trim())) return
    // Keep only what the user typed: injected notices are cut off, and a message that was
    // nothing but notices leaves nothing to send.
    const body = stripSynthetic(text)
    if (body === '') return
    const parts = chunk(body)
    for (let index = 0; index < parts.length; index++) {
      // The header marks the card as the user's own words, which is what tells it apart
      // from the Bot's replies; a long message numbers its parts instead of repeating it.
      const title = parts.length === 1
        ? '我在 DSH 里说'
        : `我在 DSH 里说（${index + 1}/${parts.length}）`
      const card = {
        config: { wide_screen_mode: true },
        header: { template: 'grey', title: { tag: 'plain_text', content: title } },
        elements: [{ tag: 'markdown', content: parts[index] }],
      }
      const response = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: mirrorTo(),
          msg_type: 'interactive',
          content: JSON.stringify(card),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const sent = await response.json().catch(() => ({}))
      if (sent?.code !== 0) throw new Error(`mirror refused (code ${sent?.code ?? '?'})`)
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
    // The answer goes back to the conversation that asked. The private chat additionally
    // keeps a copy of every turn — that is sendPrivateCopy()'s job at turn/end.
    replyTo = replyTarget(record)
    replyFrom = record.from ?? 'group'
    turnAsked = record.text ?? ''
    await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: deliveryMode(),
      content: [{ type: 'text', text: `${markOf(record.from)} ${record.text}` }],
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
    // Same routing as a text message: the answer goes back to the conversation that asked.
    replyTo = replyTarget(record)
    replyFrom = record.from ?? 'group'
    turnAsked = '[图片]'
    await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: deliveryMode(),
      content: [
        { type: 'text', text: `${markOf(record.from)} [图片] 已保存：${saved.path}` },
        { type: 'image', mediaType: saved.format.mediaType, data: record.bytes.toString('base64'), name: saved.name },
      ],
    }, AbortSignal.timeout(30_000))
    return true
  }

  // Drain one conversation — the group or one direct chat — into the Main Bot's own chat.
  // Returns the highest create_time it has finished with, so each conversation advances its
  // own cursor: a picture that cannot be read in a direct chat must not hold the group's
  // messages back, and the other way round.
  async function drain(chatId, from) {
    const items = await messagesIn(chatId)
    const known = await loadCursor(chatId)
    if (known === null) {
      // First run for this conversation: adopt the newest message so history is not replayed.
      const newest = items.reduce((max, item) => Math.max(max, Number(item?.create_time) || 0), 0)
      await saveCursor(chatId, newest)
      log('info', `cursor initialised for ${from} ${chatId} at ${newest}`)
      return
    }
    let cursor = known

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
          const ok = await deliverImage({ bytes, time, id, chatId, from, archiveKey: `${id}/${fileKey}` })
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
              await deliverImage({ bytes, time, id, chatId, from, archiveKey: `${id}/${key}` })
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
      const ok = await deliver({ text, time, id, chatId, from })
      if (!ok) break
      cursor = time
      if (id !== '') seen.add(id)
    }
    if (cursor !== known) await saveCursor(chatId, cursor)
  }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      await refreshMainSession()
      await drain(options.chatId, 'group')
      // Direct chats are polled too, so a word sent to the Bot one-to-one is heard like one
      // sent in the group. Each answers back into its own chat — see deliver()/send().
      let chats = []
      try {
        chats = await directChats()
      } catch (error) {
        // A refused chat list must never stop the group from being read.
        log('warn', `direct chat list failed: ${error?.message ?? error}`)
      }
      for (const chat of chats) {
        if (stopped) break
        try {
          await drain(chat.chat_id, 'direct')
        } catch (error) {
          log('warn', `direct chat ${chat.chat_id} failed: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log('warn', `poll failed: ${error?.message ?? error}`)
    } finally {
      ticking = false
    }
  }

  // Both directions of the Main Bot's own chat reach the group: a turn opened by a Feishu
  // message is answered there (as before), and a turn the user opened in DSH is mirrored to
  // the group too, so the phone never misses what was said at the desk. Group chats the Bot
  // takes part in are still not forwarded: their members talk among themselves, and that
  // traffic has no place in this group.
  //
  // A turn receives more than one user/message: DSH's time-context plugin injects a
  // synthetic clock message right after the real one, and a message queued while a turn
  // runs lands after that turn's end. So only the bridge's own prefix may raise the flag,
  // and nothing but turn/end may clear it — clearing it on any user/message is what
  // silently swallowed every reply.
  function onSessionEvent(session, event) {
    const id = session?.id
    if (typeof id !== 'string') return
    // Only the Main Bot's own chat is answered. `mainSession` comes from state.json, the
    // one authoritative source: guessing it from whichever session speaks first would let a
    // group's first turn be taken for the private chat and mirrored into the group. So a
    // turn is ignored until that id is known, and the poll that fills it runs at apply.
    const isMain = mainSession !== undefined && id === mainSession
    // Either mark counts: a group delivery and a direct one both come from the bridge, and
    // the reply is routed back by the conversation recorded when it was delivered.
    const isPrefixed = event?.type === 'user/message'
      && isFromFeishu(blocksToText(event.data?.content))
    // A prefixed message is proof enough before the id is known: nothing else delivers it.
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
        } else {
          // The user typed in DSH: mirrored to the group as well, so the phone sees it,
          // and the reply that closes this turn is mirrored too.
          feishuPending = true
          turnAsked = ''
          const typed = blocksToText(event.data?.content)
          if (typed.trim() !== '') {
            void sendUserMirror(typed).catch(error => log('warn', `mirror send failed: ${error?.message ?? error}`))
          }
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
        // The conversation to answer: whichever one opened this turn. A turn the user
        // opened in DSH has no Feishu message behind it, so it goes to mirrorTo() — the
        // private chat when one is configured, the group otherwise.
        const target = replyTo ?? mirrorTo()
        const source = replyFrom ?? 'group'
        const asked = turnAsked
        turnTexts = []
        turnAsked = ''
        feishuPending = false
        turnRunning = false
        turnOwner = undefined
        replyTo = undefined
        replyFrom = 'group'
        if (owed && text !== '') {
          void send(text, target).catch(error => log('warn', `reply send failed: ${error?.message ?? error}`))
        }
        // Every turn also leaves a copy in the private chat, so the phone keeps one record
        // of the whole conversation — a group exchange included. A turn that happened in
        // the private chat is already there, and sendPrivateCopy() skips it.
        if (owed) {
          void sendPrivateCopy(target, asked, text)
            .catch(error => log('warn', `private copy failed: ${error?.message ?? error}`))
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
