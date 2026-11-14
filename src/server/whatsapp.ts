import { sharedWhatsAppSocket, logoutSharedGateway } from './whatsapp-gateway.ts'
import { clearWhatsAppSession } from './whatsapp-session.ts'
import { stopWhatsAppVoiceCalls } from './whatsapp-voice.ts'
import { logoutLegacyWhatsApp } from './wa-auth.ts'
import QRCode from 'qrcode'
import { getSetting, hasReplied, listHistoryAnchors, listUnanswered, markReplied, saveText, setChatName, setSetting, userRepliedAfter } from './db.ts'
import { extractText, messageTimeIso } from './logic.ts'
import { draftReply, learnReplyPattern } from './reply.ts'
import { handleOrderMessage } from './orders.ts'
import { store } from './store.ts'
import type { ManualAttachment } from './manual-message.ts'
import { jidNormalizedUser } from 'baileys'
import { createHash } from 'node:crypto'

export type WaStatus = {
  connection: 'starting' | 'qr' | 'open' | 'close' | 'error' | 'paused'
  qrDataUrl: string | null
  error: string | null
}

type Listener = (status: WaStatus) => void

const listeners = new Set<Listener>()
let status: WaStatus = { connection: 'starting', qrDataUrl: null, error: null }
let socket: any = null
let restartTimer: NodeJS.Timeout | null = null
let connecting = false
let learnTimer: NodeJS.Timeout | null = null
let catchUpTimer: NodeJS.Timeout | null = null
let handshakeTimer: NodeJS.Timeout | null = null
let pairingRequired = false
let generation = 0
const replying = new Set<string>()
const autoIds = new Set<string>()
const autoBodies = new Map<string, { body: string, until: number }>()
const avatars = new Map<string, { data: Buffer | null; mimetype: string; until: number }>()
const pending = new Set<Promise<unknown>>()
let loggingOut: Promise<WaStatus> | null = null
function tracked<T>(task: Promise<T>) {
  pending.add(task)
  task.finally(() => pending.delete(task)).catch(() => undefined)
  return task
}

export async function whatsAppAvatar(jid: string) {
  const attempt = generation
  const cached = avatars.get(jid)
  if (cached && cached.until > Date.now()) return cached
  let data: Buffer | null = null, mimetype = ''
  try {
    const url = new URL(await socket?.profilePictureUrl?.(jid, 'preview', 3000))
    if (url.protocol !== 'https:' || !['whatsapp.net', 'fbcdn.net'].some(domain => url.hostname.endsWith('.' + domain))) throw new Error()
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000) })
    mimetype = response.headers.get('content-type')?.split(';')[0] || ''
    if (!response.ok || !response.body || !['image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) throw new Error()
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 256 * 1024) throw new Error()
        chunks.push(chunk.value)
      }
      if (size) data = Buffer.concat(chunks)
    } finally { await reader.cancel() }
  } catch { data = null }
  if (attempt !== generation) return { data: null, mimetype: '', until: 0 }
  const result = { data, mimetype, until: Date.now() + 5 * 60 * 1000 }
  if (avatars.size >= 64) avatars.delete(avatars.keys().next().value!)
  avatars.set(jid, result)
  return result
}

export function whatsAppStatus() {
  return status
}

export function subscribeWhatsApp(listener: Listener) {
  listeners.add(listener)
  listener(status)
  return () => listeners.delete(listener)
}

const pausedSetting = 'wa_connection_paused'

export async function startWhatsApp() {
  if (await getSetting(pausedSetting) === 'true') stopWhatsApp('paused')
  else connectWhatsApp()
}

export async function resumeWhatsApp() {
  if (loggingOut) await loggingOut
  if (status.connection === 'paused') await setSetting(pausedSetting, 'false')
  return connectWhatsApp()
}

export function disconnectWhatsApp() {
  if (loggingOut) return loggingOut
  loggingOut = (async () => {
    await setSetting(pausedSetting, 'true')
    const previous = socket
    stopWhatsApp('paused')
    pairingRequired = true
    stopWhatsAppVoiceCalls()
    let error: string | null = null
    try {
      const result = await whatsAppTransport.logout(previous)
      if (result?.remoteLogout === false) error = 'Local session removed. WhatsApp could not confirm remote logout; remove Desk from Linked devices on your phone.'
    } catch { error = 'WhatsApp could not confirm device logout. Local chats were cleared; remove Desk from Linked devices on your phone before reconnecting.' }
    await Promise.allSettled([...pending, ...[...manualSends.values()].map(send => send.promise)])
    await clearWhatsAppSession()
    autoIds.clear(); autoBodies.clear(); replying.clear()
    publish({ connection: 'paused', qrDataUrl: null, error }, { type: 'logout' })
    return whatsAppStatus()
  })().finally(() => { loggingOut = null })
  return loggingOut
}

export function connectWhatsApp() {
  if (loggingOut) return whatsAppStatus()
  if (!connecting && !socket) {
    if (restartTimer) clearTimeout(restartTimer)
    void connect()
  }
  return whatsAppStatus()
}

export function stopWhatsApp(connection: 'close' | 'paused' = 'close') {
  avatars.clear()
  generation++
  for (const timer of [restartTimer, handshakeTimer, learnTimer, catchUpTimer]) if (timer) clearTimeout(timer)
  restartTimer = handshakeTimer = learnTimer = catchUpTimer = null
  const previous = socket
  socket = null
  connecting = false
  if (connection === 'close') pairingRequired = false
  previous?.end(new Error('WhatsApp connection stopped.'))
  publish({ connection, qrDataUrl: null, error: null })
}

function publish(next: WaStatus, extra?: { type: string }) {
  status = next
  const event = extra ? { ...next, ...extra } : next
  for (const listener of listeners) listener(event as WaStatus)
}

export const whatsAppTransport = {
  create: sharedWhatsAppSocket,
  async logout(source: any) {
    if (source && !source.shared && source.logout) await source.logout()
    const result = await logoutSharedGateway()
    const legacy = await logoutLegacyWhatsApp()
    return { ...result, remoteLogout: result.remoteLogout !== false && legacy }
  },
}

async function connect() {
  if (connecting || socket) return
  connecting = true
  const attempt = ++generation
  publish({ connection: 'starting', qrDataUrl: null, error: null })
  handshakeTimer = setTimeout(() => {
    if (attempt !== generation) return
    generation++
    const previous = socket
    socket = null; connecting = false
    previous?.end(new Error('WhatsApp connection timed out.'))
    publish({ connection: 'error', qrDataUrl: null, error: 'WhatsApp connection timed out. Click Connect to WhatsApp to retry.' })
  }, 45000)
  handshakeTimer.unref()
  try {
    const { sock, saveCreds } = await whatsAppTransport.create(pairingRequired)
    if (attempt !== generation) { sock.end(new Error('WhatsApp connection attempt expired.')); return }
    pairingRequired = false
    socket = sock
    sock.ev.on('creds.update', () => { if (socket === sock) void tracked(saveCreds()).catch(reportError) })
    sock.ev.on('connection.update', (update: { connection?: string, qr?: string, lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
      if (socket === sock) void onConnection(update, sock).catch(reportError)
    })
    sock.ev.on('messages.upsert', (upsert: { type?: string, messages?: IncomingMessage[] }) => { if (socket === sock) void tracked(onMessages(upsert, sock)).catch(reportError) })
    sock.ev.on('messaging-history.set', async (history: { messages?: IncomingMessage[] }) => {
      if (socket !== sock) return
      try { await tracked(onMessages({ type: 'append', messages: history.messages }, sock)) } catch (error) { reportError(error); return }
      scheduleLearn()
      scheduleCatchUp()
    })
    sock.ev.on('chats.upsert', (chats: { id?: string | null, name?: string | null }[]) => { if (socket === sock) void tracked(onChats(chats)).catch(reportError) })
    sock.ev.on('chats.update', (chats: { id?: string | null, name?: string | null }[]) => { if (socket === sock) void tracked(onChats(chats)).catch(reportError) })
  } catch (error) {
    if (attempt !== generation) return
    if (handshakeTimer) clearTimeout(handshakeTimer)
    publish({
      connection: 'error',
      qrDataUrl: null,
      error: error instanceof Error ? error.message : 'WhatsApp failed to start.',
    })
  } finally {
    if (attempt === generation) connecting = false
  }
}

async function onConnection(update: { connection?: string, qr?: string, needsPairing?: boolean, lastDisconnect?: { error?: { output?: { statusCode?: number } } } }, source: unknown) {
  if (update.qr) {
    const qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 })
    if (source !== socket || status.connection === 'open') return
    if (handshakeTimer) clearTimeout(handshakeTimer)
    publish({ connection: 'qr', qrDataUrl, error: null })
  }
  if (update.connection === 'open') {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    publish({ connection: 'open', qrDataUrl: null, error: null })
    void pullHistory().catch(reportError)
    scheduleCatchUp()
  }
  if (update.connection !== 'close') return
  if (handshakeTimer) clearTimeout(handshakeTimer)
  const code = update.lastDisconnect?.error?.output?.statusCode
  if (update.needsPairing) pairingRequired = true
  socket = null
  if (code === 401) {
    await disconnectWhatsApp()
    if (socket || connecting) return
    pairingRequired = true
    publish({
      connection: 'close',
      qrDataUrl: null,
      error: 'WhatsApp logged this device out. Click Connect to WhatsApp to generate a new link code.',
    })
    return
  }
  publish({ connection: 'close', qrDataUrl: null, error: 'WhatsApp disconnected. Reconnecting.' })
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    void connect()
  }, 2000)
}

async function onMessages(upsert: { type?: string, messages?: IncomingMessage[] }, sourceSocket = socket) {
  if (upsert.type !== 'notify' && upsert.type !== 'append') return
  let saved = false
  for (const message of upsert.messages ?? []) {
    if (sourceSocket !== socket) return
    const jid = message.key?.remoteJid
    const id = message.key?.id
    if (!jid || !id || jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue
    const text = extractText(message.message)
    if (!text) continue
    const fromMe = Boolean(message.key?.fromMe)
    const source = fromMe && isAutomatic(jid, id, text) ? 'auto' : 'user'
    const timestamp = messageTimeIso(message.messageTimestamp)
    const inserted = await saveText({
      waMessageId: id,
      chatJid: jid,
      sender: fromMe ? 'me' : message.key?.participant || jid,
      pushName: fromMe ? null : message.pushName ?? null,
      body: text,
      timestamp,
      displayName: fromMe || jid.endsWith('@g.us') ? null : message.pushName ?? null,
      fromMe,
      source,
    })
    if (sourceSocket !== socket) return
    // Process order commands again on redelivery; their own durable event key prevents repeats.
    const age = Date.now() - Date.parse(timestamp)
    const fresh = !fromMe && upsert.type === 'notify' && !jid.endsWith('@g.us') && age >= 0 && age < 2 * 60 * 1000
    const phoneJid = [jid, message.key?.remoteJidAlt].find(value => value?.endsWith('@s.whatsapp.net'))
    if (fresh && phoneJid && await handleOrderMessage({ id, phone: `+${phoneJid.split('@')[0]}`, body: text, channel: 'whatsapp', jid })) {
      await markReplied(id)
      saved = true
      continue
    }
    if (!inserted) continue
    saved = true
    if (fromMe && source === 'user') scheduleLearn()
    if (fresh) {
      scheduleAutoReply(jid, id, text, timestamp)
    }
  }
  if (saved) publish(status, { type: 'message' })
}

function scheduleLearn() {
  if (learnTimer) clearTimeout(learnTimer)
  learnTimer = setTimeout(() => {
    tracked(learnReplyPattern()).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }, 4000)
}

function scheduleCatchUp() {
  if (catchUpTimer) clearTimeout(catchUpTimer)
  catchUpTimer = setTimeout(() => {
    void tracked(catchUp()).catch(reportError)
  }, 3000)
}

async function catchUp() {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  for (const message of await listUnanswered(since)) {
    void tracked(sendAutoReply(message.chat_jid, message.wa_message_id, message.body, message.timestamp))
  }
}

async function pullHistory() {
  if (!socket?.fetchMessageHistory) return
  for (const anchor of await listHistoryAnchors()) {
    try {
      await socket.fetchMessageHistory(40, {
        remoteJid: anchor.chat_jid,
        id: anchor.wa_message_id,
        fromMe: anchor.from_me === 1,
      }, Date.parse(anchor.timestamp))
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    }
  }
}

function scheduleAutoReply(jid: string, inboundId: string, text: string, timestamp: string) {
  const source = socket
  setTimeout(() => {
    if (source === socket) void tracked(sendAutoReply(jid, inboundId, text, timestamp))
  }, 8000)
}

async function sendAutoReply(jid: string, inboundId: string, text: string, timestamp: string) {
  const source = socket
  if (!source || status.connection !== 'open' || replying.has(inboundId)) return
  replying.add(inboundId)
  try {
    if (await hasReplied(inboundId) || await userRepliedAfter(jid, timestamp)) return
    const reply = await draftReply(jid, text)
    if (!reply || await hasReplied(inboundId) || await userRepliedAfter(jid, timestamp)) return
    if (source !== socket) return
    const sent = await source.sendMessage(jid, { text: reply })
    const sentId = sent?.key?.id
    if (sentId) autoIds.add(String(sentId))
    autoBodies.set(jid, { body: reply, until: Date.now() + 30_000 })
    await markReplied(inboundId)
    if (sentId) {
      await saveText({ waMessageId: String(sentId), chatJid: jid, sender: 'me', pushName: null, body: reply, timestamp: new Date().toISOString(), displayName: null, fromMe: true, source: 'auto' })
      publish(status, { type: 'message' })
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  } finally {
    replying.delete(inboundId)
  }
}

function isAutomatic(jid: string, id: string, body: string) {
  if (autoIds.delete(id)) return true
  const recent = autoBodies.get(jid)
  if (recent && recent.body === body && recent.until > Date.now()) {
    autoBodies.delete(jid)
    return true
  }
  return false
}

export function sendOrderWhatsApp(jid: string, text: string) { return tracked(deliverOrderWhatsApp(jid, text)) }
async function deliverOrderWhatsApp(jid: string, text: string) {
  if (!socket || status.connection !== 'open') throw new Error('WhatsApp is disconnected. Reconnect it before sending order messages.')
  const sent = await socket.sendMessage(jid, { text })
  if (!sent?.key?.id) throw new Error('WhatsApp did not acknowledge the order message. Review the chat before retrying.')
  autoIds.add(String(sent.key.id))
  autoBodies.set(jid, { body: text, until: Date.now() + 30000 })
  await saveText({ waMessageId: String(sent.key.id), chatJid: jid, sender: 'me', pushName: null, body: text, timestamp: new Date().toISOString(), displayName: null, fromMe: true, source: 'auto' })
  publish(status, { type: 'message' })
}

export function whatsAppCallTarget(jid: string) {
  const normalized = jidNormalizedUser(jid)
  if (!/^(?:[1-9][0-9]{7,14}@s\.whatsapp\.net|[0-9]{1,20}@lid)$/.test(normalized)) {
    throw Object.assign(new Error('Personal calls support individual WhatsApp contacts only.'), { statusCode: 400 })
  }
  return normalized
}

const manualSends = new Map<string, { fingerprint: string; promise: Promise<{ ok: boolean; duplicate?: boolean }> }>()

export async function sendManualWhatsApp(jid: string, text: string, attachment?: ManualAttachment, requestId?: string) {
  const fingerprint = createHash('sha256').update(JSON.stringify([jid, text, attachment?.kind, attachment?.name])).update(attachment?.data ?? Buffer.alloc(0)).digest('hex')
  if (!requestId) return tracked(deliverManualWhatsApp(jid, text, attachment))
  const pending = manualSends.get(requestId)
  if (pending) {
    if (pending.fingerprint !== fingerprint) throw Object.assign(new Error('This send ID belongs to a different message.'), { statusCode: 409 })
    return pending.promise
  }
  const promise = tracked(deliverManualWhatsApp(jid, text, attachment, requestId, fingerprint)).finally(() => manualSends.delete(requestId))
  manualSends.set(requestId, { fingerprint, promise })
  return promise
}

async function deliverManualWhatsApp(jid: string, text: string, attachment?: ManualAttachment, requestId?: string, fingerprint?: string) {
  if (requestId) {
    const saved = await store.collection('wa_messages').findOne({ client_request_id: requestId })
    if (saved) {
      if (saved.client_request_hash !== fingerprint) throw Object.assign(new Error('This send ID belongs to a different message.'), { statusCode: 409 })
      return { ok: true, duplicate: true }
    }
  }
  const source = socket
  if (!source || status.connection !== 'open') throw Object.assign(new Error('Reconnect WhatsApp before sending a message.'), { statusCode: 409 })
  const content = !attachment ? { text }
    : attachment.kind === 'sticker' ? { sticker: attachment.data }
    : attachment.kind === 'image' ? { image: attachment.data, caption: text, mimetype: attachment.mimetype }
    : { document: attachment.data, fileName: attachment.name, mimetype: attachment.mimetype, caption: text }
  let sent: any
  try { sent = await source.sendMessage(jid, content, { mediaUploadTimeoutMs: 60000 }) }
  catch { throw Object.assign(new Error('WhatsApp did not confirm the message. Check the conversation before retrying.'), { statusCode: 502 }) }
  const id = sent?.key?.id
  if (!id) throw Object.assign(new Error('WhatsApp did not confirm the message. Check the conversation before retrying.'), { statusCode: 502 })
  const body = attachment ? `[${attachment.kind === 'sticker' ? 'Sticker' : 'Attachment'}: ${attachment.name}]${text ? '\n' + text : ''}` : text
  try {
    await saveText({ waMessageId: String(id), chatJid: jid, sender: 'me', pushName: null, body, timestamp: new Date().toISOString(), displayName: null, fromMe: true, source: 'user' })
    if (attachment || requestId) await store.collection('wa_messages').updateOne({ wa_message_id: String(id) }, { $set: { body, ...(attachment ? { media: attachment } : {}), ...(requestId ? { client_request_id: requestId, client_request_hash: fingerprint } : {}), source: 'user', from_me: 1 } })
  } catch { throw Object.assign(new Error('WhatsApp accepted the message, but its local record could not be saved. Check WhatsApp before retrying.'), { statusCode: 502 }) }
  scheduleLearn()
  publish(status, { type: 'message' })
  return { ok: true }
}

async function onChats(chats: { id?: string | null, name?: string | null }[]) {
  for (const chat of chats ?? []) {
    if (chat.id && chat.name) await setChatName(chat.id, chat.name)
  }
}

type IncomingMessage = {
  key?: { fromMe?: boolean, remoteJid?: string | null, remoteJidAlt?: string | null, id?: string | null, participant?: string | null }
  pushName?: string | null
  message?: unknown
  messageTimestamp?: unknown
}

function reportError(error: unknown) { console.error(error instanceof Error ? error.message : error) }
