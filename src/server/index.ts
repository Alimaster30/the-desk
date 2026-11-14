import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import Fastify from 'fastify'
import { getCall, listCalls, listChats, listMessages, upsertCall } from './db.ts'
import { client, store, connectDatabase, ensureIndexes } from './store.ts'
import { loadEnv } from './env.ts'
import { chatSummary } from './chat-summary.ts'
import { applyWebhook, checkWebhook, loginToken, refreshCallCost } from './telnyx.ts'
import { replyState, setAutoReply } from './reply.ts'
import { startWhatsApp, resumeWhatsApp, disconnectWhatsApp, stopWhatsApp, subscribeWhatsApp, whatsAppStatus, sendOrderWhatsApp, sendManualWhatsApp, whatsAppCallTarget, whatsAppAvatar } from './whatsapp.ts'
import { createOrder, listOrders, requestOrderAction, orderActions, orderSetup, orderAudioFile, handleOrderWebhook, startOrderWorker } from './orders.ts'
import { listOrderStaff, login, logout, publicUser, readSession, sessionCookie, setOrderAccess, signup, userFromToken, type AuthUser } from './auth.ts'
import { balanceOf, buyNumber, dashboardFor, decideCredit, gallery, listCredits, myNumbers, requestCredit } from './accounts.ts'
import { attachTelnyxVoice } from './telnyx-voice.ts'
import { stopWhatsAppVoiceCalls, whatsAppVoiceStatus, setWhatsAppVoiceEnabled, manualWhatsAppCallTicket, attachManualWhatsAppCalls } from './whatsapp-voice.ts'
import { organizationAnalytics } from './analytics.ts'
import { stopVoiceGateway } from './voice-gateway.ts'
import { manualMessage } from './manual-message.ts'
import { restoreOrderControls, updateOrderControls } from './order-controls.ts'
import { Binary } from 'mongodb'
import { smsLines, smsConversations, smsMessages, sendSms, recordSms, smsSummary, smsMedia } from './sms.ts'

loadEnv()

export const app = Fastify({ logger: process.env.APP_TEST !== '1' })
const closeTelnyxVoice = attachTelnyxVoice(app.server)
const closeManualCalls = attachManualWhatsAppCalls(app.server)
app.addHook('preClose', async () => { closeManualCalls(); closeTelnyxVoice(); stopWhatsAppVoiceCalls(); await stopVoiceGateway() })

app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  const raw = body.toString('utf8')
  try {
    done(null, { raw, json: raw ? JSON.parse(raw) : {} })
  } catch (error) {
    ;(error as { statusCode?: number }).statusCode = 400
    done(error as Error, undefined)
  }
})

app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  const statusCode = error.statusCode ?? 500
  reply.code(statusCode).send({ error: error.message || 'Request failed' })
})

const actors = new WeakMap<object, AuthUser>()

app.addHook('onRequest', async (request, reply) => {
  const url = request.url.split('?')[0]
  if (!url.startsWith('/api/') || url === '/api/health' || url === '/api/telnyx/webhook' || /^\/api\/telnyx-media\/[a-f0-9]{64}$/.test(url) || /^\/api\/order-audio\/(en|ur)\.wav$/.test(url) || url.startsWith('/api/auth/')) return
  const user = await userFromToken(readSession(request.headers.cookie))
  if (!user) return reply.code(401).send({ error: 'Sign in required.' })
  if (url.startsWith('/api/whatsapp') && user.role !== 'admin') {
    return reply.code(403).send({ error: 'WhatsApp is limited to the admin account.' })
  }
  if (url.startsWith('/api/orders') && !user.orderAccess) return reply.code(403).send({ error: 'Ask an admin for order access.' })
  if (url.startsWith('/api/admin/') && user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required.' })
  actors.set(request, user)
})

function actor(request: object) {
  const user = actors.get(request)
  if (!user) {
    const error = new Error('Sign in required.') as Error & { statusCode?: number }
    error.statusCode = 401
    throw error
  }
  return user
}

app.get('/api/health', async () => { await store.command({ ping: 1 }); return { ok: true, database: 'mongodb' } })
app.post('/api/admin/order-controls', async request => {
  await updateOrderControls(jsonBody(request))
  return ordersSetup()
})

app.get('/api/admin/order-staff', async () => listOrderStaff())
app.get<{ Querystring: { days?: string } }>('/api/admin/analytics', async (request, reply) => {
  const days = request.query.days ?? '7'
  if (days !== '7' && days !== '30') return reply.code(400).send({ error: 'Choose 7 or 30 days.' })
  return reply.header('Cache-Control', 'no-store').send(await organizationAnalytics(days === '7' ? 7 : 30))
})
app.put('/api/admin/order-staff', async request => {
  const { email, allowed } = jsonBody(request)
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof allowed !== 'boolean') {
    throw Object.assign(new Error('Enter an account email and a valid access choice.'), { statusCode: 400 })
  }
  await setOrderAccess(email, allowed)
  return { ok: true }
})

async function ordersSetup() {
  const setup = orderSetup()
  return { ...setup, whatsAppReady: setup.voice.ready && (await whatsAppVoiceStatus()).state === 'ready' }
}
app.get('/api/orders/setup', ordersSetup)
app.get<{ Querystring: { order?: string } }>('/api/orders', async request => {
  const { id, role } = actor(request)
  const selected = request.query.order
  if (selected !== undefined && (typeof selected !== 'string' || !/^[a-f0-9-]{36}$/i.test(selected))) {
    throw Object.assign(new Error('Invalid order id.'), { statusCode: 400 })
  }
  return listOrders(id, role === 'admin', selected)
})
app.post('/api/orders', async (request, reply) => {
  const body = jsonBody(request)
  const order = await createOrder(actor(request).id, body, body.startConfirmation === true)
  return reply.code(201).send(order)
})
app.get<{ Params: { id: string } }>('/api/orders/:id/actions', async request => {
  const { id, role } = actor(request)
  return orderActions(id, request.params.id, role === 'admin')
})
app.post<{ Params: { id: string } }>('/api/orders/:id/invite', async request => {
  const { id, role } = actor(request)
  return requestOrderAction(id, request.params.id, 'invite', false, 'ivr', role)
})
app.post<{ Params: { id: string } }>('/api/orders/:id/call', async request => {
  const body = jsonBody(request)
  const { id, role } = actor(request)
  return requestOrderAction(id, request.params.id, 'call', body.customerRequestedCall === true, body.mode, role)
})
app.get<{ Params: { language: string } }>('/api/order-audio/:language.wav', async (request, reply) => {
  const language = request.params.language
  if (language !== 'en' && language !== 'ur') return reply.callNotFound()
  const file = orderAudioFile(language)
  if (!existsSync(file)) return reply.code(404).send({ error: 'IVR audio is not prepared.' })
  return reply.type('audio/wav').header('Cache-Control', 'public, max-age=3600').send(createReadStream(file))
})

app.post('/api/auth/signup', async (request, reply) => {
  const body = jsonBody(request)
  const session = await signup({
    email: text(body.email) || '',
    name: text(body.name) || '',
    password: typeof body.password === 'string' ? body.password : '',
  })
  reply.header('set-cookie', sessionCookie(session.token))
  return publicUser(session.user)
})

app.post('/api/auth/login', async (request, reply) => {
  const body = jsonBody(request)
  const session = await login(text(body.email) || '', typeof body.password === 'string' ? body.password : '')
  reply.header('set-cookie', sessionCookie(session.token))
  return publicUser(session.user)
})

app.post('/api/auth/logout', async (request, reply) => {
  await logout(readSession(request.headers.cookie))
  reply.header('set-cookie', sessionCookie('', 0))
  return { ok: true }
})

app.get('/api/auth/me', async (request) => {
  const user = await userFromToken(readSession(request.headers.cookie))
  if (!user) {
    const error = new Error('Sign in required.') as Error & { statusCode?: number }
    error.statusCode = 401
    throw error
  }
  return publicUser(user)
})

app.get('/api/dashboard', async (request) => dashboardFor(actor(request).id))

app.get('/api/sms/setup', async request => ({ lines: await smsLines(actor(request)), configured: Boolean(process.env.TELNYX_API_KEY?.trim()), automation: orderSetup() }))
app.get('/api/sms/conversations', async request => smsConversations(actor(request)))
app.get<{ Params: { id: string } }>('/api/sms/conversations/:id/messages', async request => smsMessages(actor(request), request.params.id))
app.post<{ Params: { id: string } }>('/api/sms/conversations/:id/send', { bodyLimit: 2 * 1024 * 1024 }, async request => sendSms(actor(request), request.params.id, jsonBody(request)))
app.post<{ Params: { id: string } }>('/api/sms/conversations/:id/summary', async request => smsSummary(actor(request), request.params.id))
app.get<{ Params: { token: string } }>('/api/telnyx-media/:token', async (request, reply) => {
  const media = await smsMedia(request.params.token)
  return reply.type(media.mimetype).header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').send(Buffer.from((media.data as Binary).buffer))
})
app.get<{ Params: { token: string } }>('/api/sms/media/:token', async (request, reply) => {
  const media = await smsMedia(request.params.token, actor(request))
  return reply.type(media.mimetype).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(Buffer.from((media.data as Binary).buffer))
})

app.get('/api/numbers/available', async (request) => {
  const query = request.query as { country?: string, area?: string, contains?: string }
  return gallery(query)
})

app.get('/api/numbers', async (request) => myNumbers(actor(request).id))

app.post('/api/numbers/order', async (request) => {
  const body = jsonBody(request)
  return buyNumber(actor(request), text(body.phoneNumber) || '', text(body.country) || '')
})

app.get('/api/billing/requests', async (request) => listCredits(actor(request)))

app.post('/api/billing/requests', async (request) => {
  const body = jsonBody(request)
  return requestCredit(actor(request).id, text(body.amount) || '', text(body.note) || '')
})

app.post<{ Params: { id: string } }>('/api/billing/requests/:id/approve', async (request) => {
  const user = actor(request)
  if (user.role !== 'admin') {
    const error = new Error('Only an admin can approve credit.') as Error & { statusCode?: number }
    error.statusCode = 403
    throw error
  }
  return decideCredit(user.id, Number(request.params.id), true)
})

app.post<{ Params: { id: string } }>('/api/billing/requests/:id/reject', async (request) => {
  const user = actor(request)
  if (user.role !== 'admin') {
    const error = new Error('Only an admin can reject credit.') as Error & { statusCode?: number }
    error.statusCode = 403
    throw error
  }
  return decideCredit(user.id, Number(request.params.id), false)
})

app.post('/api/telephony/token', async (request) => {
  const user = actor(request)
  if (await balanceOf(user.id) <= 0) {
    const error = new Error('Request credit and wait for approval before placing a call.') as Error & { statusCode?: number }
    error.statusCode = 402
    throw error
  }
  return loginToken()
})
app.get('/api/telephony/token', async (request) => {
  const user = actor(request)
  if (await balanceOf(user.id) <= 0) {
    const error = new Error('Request credit and wait for approval before placing a call.') as Error & { statusCode?: number }
    error.statusCode = 402
    throw error
  }
  return loginToken()
})

app.get('/api/calls', async (request) => listCalls(actor(request).id))

app.get<{ Params: { id: string } }>('/api/calls/:id', async (request, reply) => {
  const found = await getCall(Number(request.params.id))
  const user = actor(request)
  if (!found || found.row.user_id !== user.id) return reply.code(404).send({ error: 'No call with that id.' })
  return found.json
})

app.post<{ Params: { id: string } }>('/api/calls/:id/refresh-cost', async (request, reply) => {
  const found = await getCall(Number(request.params.id))
  const user = actor(request)
  if (!found || found.row.user_id !== user.id) return reply.code(404).send({ error: 'No call with that id.' })
  return refreshCallCost(Number(request.params.id))
})

app.post('/api/calls/sync', async (request) => {
  const body = (request.body as { json?: Record<string, unknown> }).json ?? {}
  const status = text(body.status)
  if (!status) {
    const error = new Error('Call status is required.') as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
  return (await upsertCall({
    clientCallId: text(body.clientCallId),
    callSessionId: text(body.callSessionId),
    callLegId: text(body.callLegId),
    callControlId: text(body.callControlId),
    direction: text(body.direction) || 'outbound',
    from: text(body.from),
    to: text(body.to),
    status,
    startedAt: text(body.startedAt),
    answeredAt: text(body.answeredAt),
    endedAt: text(body.endedAt),
    hangupCause: text(body.hangupCause),
  }, actor(request).id)).json
})

app.post('/api/telnyx/webhook', async (request, reply) => {
  const body = request.body as { raw: string, json: { data?: { id?: string, event_type?: string, payload?: Record<string, unknown> }, id?: string, event_type?: string, payload?: Record<string, unknown> } }
  const ok = checkWebhook(
    body.raw,
    request.headers['telnyx-timestamp'] as string | undefined,
    request.headers['telnyx-signature-ed25519'] as string | undefined,
  )
  if (!ok) return reply.code(401).send({ error: 'Telnyx signature was rejected.' })
  const eventType = body.json.data?.event_type || body.json.event_type
  const payload = body.json.data?.payload || body.json.payload
  if (typeof eventType === 'string' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const eventId = body.json.data?.id || body.json.id || ''
    await recordSms(eventType, payload)
    const handled = await handleOrderWebhook(eventType, typeof eventId === 'string' ? eventId : '', payload)
    if (!handled && eventType.startsWith('call.')) await applyWebhook(eventType, payload)
  }
  return { ok: true }
})

app.get('/api/whatsapp/status', async () => whatsAppStatus())
app.get('/api/whatsapp/voice-status', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(await whatsAppVoiceStatus()))
app.post('/api/whatsapp/voice', async request => {
  const { enabled } = jsonBody(request)
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false.'), { statusCode: 400 })
  return setWhatsAppVoiceEnabled(enabled)
})
app.post('/api/whatsapp/connect', async () => resumeWhatsApp())
app.post('/api/whatsapp/disconnect', async () => disconnectWhatsApp())

app.get('/api/whatsapp/events', async (request, reply) => {
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (event: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const unsubscribe = subscribeWhatsApp(send)
  const timer = setInterval(() => reply.raw.write(': ping\n\n'), 15000)
  request.raw.on('close', () => {
    clearInterval(timer)
    unsubscribe()
  })
})

app.get('/api/whatsapp/chats', async () => ['paused', 'qr'].includes(whatsAppStatus().connection) ? [] : listChats())

app.get('/api/whatsapp/reply', async () => replyState())

app.post('/api/whatsapp/reply', async (request) => {
  const enabled = (request.body as { json?: { enabled?: unknown } }).json?.enabled
  if (typeof enabled !== 'boolean') {
    const error = new Error('enabled must be true or false.') as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
  return setAutoReply(enabled)
})

app.get<{ Params: { jid: string } }>('/api/whatsapp/chats/:jid/messages', async (request) => {
  if (['paused', 'qr'].includes(whatsAppStatus().connection)) return []
  return listMessages(decodeURIComponent(request.params.jid))
})

app.get<{ Params: { jid: string } }>('/api/whatsapp/chats/:jid/avatar', async (request, reply) => {
  const jid = request.params.jid
  if (!await store.collection('wa_chats').findOne({ jid })) return reply.code(404).send()
  const avatar = await whatsAppAvatar(jid)
  if (!avatar.data) return reply.code(404).send()
  return reply.header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff').type(avatar.mimetype).send(avatar.data)
})

app.post<{ Params: { jid: string } }>('/api/whatsapp/chats/:jid/send', { bodyLimit: 8 * 1024 * 1024 }, async request => {
  const jid = request.params.jid
  if (!await store.collection('wa_chats').findOne({ jid })) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 })
  const { text, attachment, requestId } = manualMessage(jsonBody(request))
  return sendManualWhatsApp(jid, text, attachment, requestId)
})

app.post<{ Params: { jid: string } }>('/api/whatsapp/chats/:jid/call', async request => {
  const jid = request.params.jid
  if (!await store.collection('wa_chats').findOne({ jid })) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 })
  return manualWhatsAppCallTicket(actor(request).id, whatsAppCallTarget(jid))
})

app.get<{ Params: { id: string } }>('/api/whatsapp/messages/:id/attachment', async (request, reply) => {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('Invalid message.'), { statusCode: 400 })
  const row = await store.collection('wa_messages').findOne({ id })
  const media = row?.media
  if (!media?.data) return reply.code(404).send({ error: 'Attachment not found.' })
  const image = ['image/png', 'image/jpeg', 'image/webp'].includes(media.mimetype)
  return reply.header('Cache-Control', 'private, max-age=60').header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(media.name)}`)
    .type(image ? media.mimetype : 'application/octet-stream')
    .send(Buffer.from(media.data instanceof Binary ? media.data.value() : media.data))
})

app.post<{ Params: { jid: string } }>('/api/whatsapp/chats/:jid/summary', async request => {
  return chatSummary(decodeURIComponent(request.params.jid))
})

const webRoot = resolve('web/dist')
if (existsSync(webRoot)) {
  app.get('/*', async (request, reply) => {
    const url = request.url.split('?')[0] || '/'
    if (url.startsWith('/api')) return reply.callNotFound()
    const requested = url === '/' ? 'index.html' : url.slice(1)
    const candidate = normalize(join(webRoot, requested))
    const file = candidate.startsWith(webRoot) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(webRoot, 'index.html')
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    }
    return reply.type(types[extname(file)] || 'application/octet-stream').send(createReadStream(file))
  })
}

let stopOrders: (() => Promise<void>) | undefined
app.addHook('onClose', async () => { await stopOrders?.(); stopWhatsApp(); await client.close() })
if (process.env.APP_TEST !== '1') {
  try {
    await connectDatabase()
    if (!await store.collection('migration_state').findOne({ name: 'sqlite-v1', complete: true })) throw new Error('Run npm run migrate:atlas before starting the app.')
    await ensureIndexes()
    await restoreOrderControls()
    const port = Number(process.env.PORT || 8787)
    await startWhatsApp()
    await app.listen({ port, host: '127.0.0.1' })
    stopOrders = startOrderWorker(sendOrderWhatsApp)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Startup failed')
    process.exit(1)
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 200) : null
}

function jsonBody(request: { body: unknown }) {
  return ((request.body as { json?: Record<string, unknown> } | undefined)?.json) ?? {}
}
