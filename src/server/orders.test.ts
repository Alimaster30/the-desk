import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { after, beforeEach, mock, test } from 'node:test'

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
process.env.APP_TEST = '1'
process.env.ORDER_AUTOMATION_ENABLED = 'true'
process.env.TELNYX_API_KEY = 'fake-test-key'
process.env.TELNYX_PHONE_NUMBER = '+12025550100'
process.env.TELNYX_CALL_CONTROL_CONNECTION_ID = 'test-call-control'
process.env.PUBLIC_BASE_URL = 'https://example.test'
process.env.ORDER_IVR_DIRECTORY = mkdtempSync(join(tmpdir(), 'order-ivr-test-'))
writeFileSync(join(process.env.ORDER_IVR_DIRECTORY, 'en.wav'), Buffer.from('test audio fixture'))
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const { orderTestStore } = await import('./orders.fixture.ts')
const fixture = orderTestStore()
const { createOrder, requestOrderAction, handleOrderMessage, handleOrderWebhook, runOrderJob, listOrders, handleVoiceDecision } = await import('./orders.ts')
const { app } = await import('./index.ts')
const { textAgent } = await import('./text-agent.ts')
const input = { reference: 'ORDER-1', phone: '+923001234567', channel: 'sms', language: 'en', item: 'Two shirts', amount: '2500', currency: 'PKR' }
let requests: { path: string, body: Record<string, unknown> }[] = []
let whatsapp: string[] = []
const sendWhatsApp = async (_jid: string, text: string) => { whatsapp.push(text) }
let failProvider = false
let failStreaming = false
let whatsAppVoiceReady = false
mock.method(globalThis, 'fetch', async (url: string | URL | Request, options: RequestInit = {}) => {
  if (String(url) === 'http://127.0.0.1:8795/status') return Response.json({ state: whatsAppVoiceReady ? 'ready' : 'disconnected' })
  if (!String(url).startsWith('https://api.telnyx.com/v2/')) throw new Error('Tests cannot make external requests.')
  requests.push({ path: String(url).replace('https://api.telnyx.com/v2', ''), body: JSON.parse(String(options.body || '{}')) })
  if (failProvider && String(url).endsWith('/calls')) throw new Error('Simulated connection lost after provider acceptance')
  if (failStreaming && String(url).endsWith('/streaming_start')) throw new Error('Simulated stream unavailable')
  return new Response(JSON.stringify({ data: String(url).endsWith('/calls') ? { call_control_id: 'call-1', call_session_id: 'session-1' } : { id: 'message-1' } }), { status: 200 })
})
beforeEach(() => {
  fixture.reset({ users: [{ id: 1, email: 'admin@example.test', name: 'Admin', role: 'admin', balance_units: 100000 }, { id: 2, role: 'user' }], sessions: [{ token: 'admin-test', user_id: 1, expires_at: '2099-01-01T00:00:00.000Z' }, { token: 'user-test', user_id: 2, expires_at: '2099-01-01T00:00:00.000Z' }] })
  requests = []; whatsapp = []; failProvider = false; failStreaming = false; whatsAppVoiceReady = false
  process.env.ORDER_AUTOMATION_ENABLED = 'true'
  process.env.TEXT_AGENT_ENABLED = 'false'
  process.env.VOICE_AGENT_ENABLED = 'false'
  process.env.WHATSAPP_VOICE_TOKEN = ''
})
after(async () => { await app.close(); mock.restoreAll() })
const reply = (body: string, phone = input.phone, id = body) => handleOrderMessage({ id, phone, body, channel: 'whatsapp' })
const current = () => fixture.tables.orders[0]
async function drain() { for (let i = 0; i < 15 && await runOrderJob(sendWhatsApp); i += 1) { /* Drain bounded test jobs. */ } }
const event = (type: string, id: string, payload: Record<string, unknown> = {}) => handleOrderWebhook(type, id, { call_control_id: 'call-1', call_session_id: 'session-1', ...payload })

function enableVoice() {
  process.env.TEXT_AGENT_ENABLED = 'true'
  process.env.VOICE_AGENT_ENABLED = 'true'
  process.env.GEMINI_API_KEY = 'synthetic-test-key'
}

test('Telnyx conversational dispatch falls back to the keypad without redialing', async () => {
  enableVoice(); failStreaming = true
  const order = await createOrder(1, input)
  await requestOrderAction(1, order.id, 'call', true, 'voice'); await drain()
  await event('call.answered', 'answer'); await drain()
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
  assert.equal(requests.filter(item => item.path.endsWith('/streaming_start')).length, 1)
  assert.equal(requests.filter(item => item.path.endsWith('/gather_using_audio')).length, 1)
  assert.equal(current().call_mode, 'ivr')
})

test('spoken decision cannot change an order without the referenced original-channel approval', async () => {
  enableVoice()
  const order = await createOrder(1, input)
  await requestOrderAction(1, order.id, 'call', true, 'voice'); await drain()
  const call = { id: order.id, attempt_id: current().attempt_id }
  assert.equal(await handleVoiceDecision(call, 'confirm'), false)
  await event('call.answered', 'answer')
  assert.equal(await handleVoiceDecision({ ...call, attempt_id: 'another-call' }, 'confirm'), false)
  assert.equal(await handleVoiceDecision(call, 'confirm'), true)
  assert.equal(await handleVoiceDecision(call, 'cancel'), false)
  assert.equal(current().status, 'pending')
  const sms = (body: string, id: string) => handleOrderMessage({ id, phone: input.phone, body, channel: 'sms' })
  await sms('YES ORDER-1', 'before-preview')
  await runOrderJob(sendWhatsApp, 'agent')
  assert.equal(current().status, 'pending')
  await drain()
  await sms('YES', 'no-reference'); await drain()
  await reply('YES ORDER-1', input.phone, 'wrong-channel'); await drain()
  assert.equal(current().status, 'pending')
  await sms('YES ORDER-1', 'with-reference'); await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => item.path === '/messages' && String(item.body.text).includes('Your order is confirmed.')).length, 1)
  await event('call.hangup', 'hangup')
})

for (const action of ['confirm', 'cancel'] as const) test(`WhatsApp spoken ${action} saves once during the active call without text approval or cutting off speech`, async () => {
  enableVoice()
  process.env.WHATSAPP_VOICE_TOKEN = 'x'.repeat(32)
  whatsAppVoiceReady = true
  const order = await createOrder(1, input)
  await requestOrderAction(1, order.id, 'call', true, 'whatsapp')
  const call = { id: order.id, attempt_id: current().attempt_id }
  assert.equal(await handleVoiceDecision(call, action), false)
  current().call_status = 'answered'
  assert.equal(await handleVoiceDecision({ ...call, attempt_id: 'stale-call' }, action), false)
  assert.equal(await handleVoiceDecision(call, action), true)
  assert.equal(current().status, action === 'confirm' ? 'confirmed' : 'cancelled')
  assert.equal(current().agent_proposal, null)
  assert.equal(current().call_status, 'answered')
  assert.equal(await handleVoiceDecision(call, action === 'confirm' ? 'cancel' : 'confirm'), false)
  const jobs = fixture.tables.order_jobs
  assert.equal(jobs.filter(job => job.key === `receipt:${order.id}`).length, 1)
  assert.equal(jobs.filter(job => job.kind === 'agent_reply' || job.kind === 'hangup').length, 0)
})

test('WhatsApp callbacks need a linked voice device and share the existing attempt limit', async () => {
  enableVoice()
  process.env.WHATSAPP_VOICE_TOKEN = 'x'.repeat(32)
  const order = await createOrder(1, input)
  assert.equal((await app.inject({ url: '/api/whatsapp/voice-status', headers: { cookie: 'desk_session=user-test' } })).statusCode, 403)
  await assert.rejects(requestOrderAction(1, order.id, 'call', true, 'whatsapp'), /separate WhatsApp voice device/)
  assert.equal(current().attempt_id, null)
  whatsAppVoiceReady = true
  await handleOrderMessage({ body: 'CALL-WHATSAPP ORDER-1', id: 'text-call', phone: input.phone, channel: 'sms' })
  await reply('CALL-WHATSAPP ORDER-1', input.phone, 'wa-call')
  assert.equal(current().call_mode, 'whatsapp')
  assert.equal(fixture.tables.order_jobs.filter(job => job.kind === 'dial').length, 1)
  assert.equal(await event('call.answered', 'wrong-provider', { client_state: Buffer.from(JSON.stringify({ orderAttempt: current().attempt_id })).toString('base64') }), false)
  await reply('CONFIRM ORDER-1')
  await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => item.path === '/calls').length, 0)
})

test('voice-only mode preserves explicit original-channel approval without enabling the text assistant', async context => {
  enableVoice()
  process.env.TEXT_AGENT_ENABLED = 'false'
  const text = await import('./text-agent.ts')
  let modelCalls = 0
  context.mock.method(text.textAgent, 'plan', async () => { modelCalls++; throw new Error('Text assistant must stay off.') })
  const order = await createOrder(1, input)
  const setup = await app.inject({ url: '/api/orders/setup', headers: { cookie: 'desk_session=admin-test' } })
  assert.equal(setup.json().textAgent.enabled, false)
  assert.equal(setup.json().voice.ready, true)
  await requestOrderAction(1, order.id, 'call', true, 'voice'); await drain()
  await event('call.answered', 'voice-only-answer')
  assert.equal(await handleVoiceDecision({ id: order.id, attempt_id: current().attempt_id }, 'confirm'), true)
  assert.equal(current().status, 'pending')
  const sms = (body: string, id: string) => handleOrderMessage({ id, phone: input.phone, body, channel: 'sms' })
  await sms('YES ORDER-1', 'voice-only-before-preview')
  await runOrderJob(sendWhatsApp, 'agent')
  assert.equal(current().status, 'pending')
  await drain()
  await sms('YES', 'voice-only-no-reference'); await drain()
  await reply('YES ORDER-1', input.phone, 'voice-only-wrong-channel'); await drain()
  assert.equal(current().status, 'pending')
  await sms('YES ORDER-1', 'voice-only-approval'); await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(modelCalls, 0)
  assert.equal(process.env.TEXT_AGENT_ENABLED, 'false')
})

test('admin-only API stores an order without sending anything and hides internal fields', async () => {
  assert.equal((await app.inject({ url: '/api/orders' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/orders', headers: { cookie: 'desk_session=user-test' } })).statusCode, 403)
  const response = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: 'desk_session=admin-test' }, payload: input })
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(response.json().status, 'pending')
  assert.equal(response.json()._id, undefined)
  assert.equal(response.json().whatsapp_jid, undefined)
  assert.equal(requests.length, 0)
  await assert.rejects(createOrder(1, input), /already exists/)
  await assert.rejects(requestOrderAction(2, response.json().id, 'invite'), /not found/)
})

test('admin grants order access without exposing other staff orders or WhatsApp settings', async () => {
  const admin = { cookie: 'desk_session=admin-test' }
  const staff = { cookie: 'desk_session=user-test' }
  fixture.tables.users[1].email = 'staff@example.test'
  const access = (allowed: boolean, headers = admin) => app.inject({ method: 'PUT', url: '/api/admin/order-staff', headers, payload: { email: 'staff@example.test', allowed } })
  assert.equal((await access(true, staff)).statusCode, 403)
  assert.equal((await access(true)).statusCode, 200)
  const first = await createOrder(1, input)
  const second = await app.inject({ method: 'POST', url: '/api/orders', headers: staff, payload: { ...input, reference: 'STAFF-2', startConfirmation: true } })
  assert.equal(second.statusCode, 201, second.body)
  assert.equal(second.json().invitationStatus, 'pending')
  assert.equal((await app.inject({ url: '/api/orders', headers: staff })).json().length, 1)
  assert.equal((await app.inject({ url: '/api/orders', headers: admin })).json().length, 2)
  assert.equal((await app.inject({ url: `/api/orders?order=${first.id}`, headers: staff })).json().length, 0)
  assert.equal((await app.inject({ url: `/api/orders/${first.id}/actions`, headers: staff })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `/api/orders/${first.id}/invite`, headers: staff })).statusCode, 404)
  assert.equal((await app.inject({ url: '/api/whatsapp/voice-status', headers: staff })).statusCode, 403)
  await drain()
  assert.equal(requests.filter(request => request.path === '/messages').length, 1)
  assert.match(String(requests[0].body.text), /STAFF-2/)
  assert.equal((await app.inject({ url: '/api/orders', headers: staff })).json()[0].invitationStatus, 'done')
  assert.equal((await access(false)).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/orders', headers: staff })).statusCode, 403)
})

test('starting confirmation respects the live switch and queues only one invitation per reference', async () => {
  process.env.ORDER_AUTOMATION_ENABLED = 'false'
  await assert.rejects(createOrder(1, input, true), /disabled/)
  assert.equal(fixture.tables.orders?.length ?? 0, 0)
  process.env.ORDER_AUTOMATION_ENABLED = 'true'
  const results = await Promise.allSettled([createOrder(1, input, true), createOrder(1, input, true)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(fixture.tables.order_jobs.length, 1)
  await reply('CONFIRM ORDER-1')
  await drain()
  assert.equal(fixture.tables.order_jobs.find(job => job.kind === 'invite')?.status, 'skipped')
  assert.equal(requests.filter(request => request.path === '/messages').length, 1)
})

test('admin analytics separates periods, provider acknowledgements and pending Telnyx costs', async () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const old = new Date(Date.now() - 10 * 86400000).toISOString()
  const first = await createOrder(1, input)
  const second = await createOrder(2, { ...input, reference: 'OLDER-2' })
  Object.assign(fixture.tables.orders[0], { created_at: recent, status: 'pending', attempt_id: 'wa-attempt', call_mode: 'whatsapp', call_status: 'review' })
  Object.assign(fixture.tables.orders[1], { created_at: old, status: 'confirmed', attempt_id: 'telnyx-attempt', call_status: 'completed' })
  fixture.tables.order_jobs = [
    { kind: 'invite', order_id: first.id, status: 'failed', available_at: recent },
    { kind: 'invite', order_id: second.id, status: 'done', available_at: recent, provider_acknowledged: true },
    { kind: 'agent_reply', order_id: second.id, status: 'done', available_at: recent },
  ]
  fixture.tables.calls = [
    { user_id: 1, started_at: recent, ended_at: recent, duration_seconds: 60, cost_amount: '0.1250', currency: 'USD' },
    { user_id: 2, started_at: recent, ended_at: recent, duration_seconds: 30, cost_amount: null },
    { user_id: 2, started_at: recent, ended_at: recent, duration_seconds: 30, cost_amount: '0.5000', currency: 'EUR' },
    { user_id: null, started_at: recent, cost_amount: '99', currency: 'USD' },
  ]
  const admin = { cookie: 'desk_session=admin-test' }
  const staff = { cookie: 'desk_session=user-test' }
  fixture.tables.users[1].order_access = true
  assert.equal((await app.inject({ url: '/api/admin/analytics', headers: staff })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/admin/analytics?days=900', headers: admin })).statusCode, 400)
  const short = await app.inject({ url: '/api/admin/analytics', headers: admin })
  assert.equal(short.statusCode, 200, short.body)
  assert.deepEqual(short.json().outcomes, { pending: 1, confirmed: 0, cancelled: 0 })
  assert.deepEqual(short.json().invitations, { queued: 0, acknowledged: 1, failed: 1, skipped: 0, legacyProcessed: 0 })
  assert.equal(short.json().failed[0].id, first.id)
  assert.equal(short.json().callbacks.whatsapp.review, 1)
  assert.equal(short.json().usage.pendingCosts, 1)
  assert.equal(short.json().usage.seconds, 120)
  assert.equal(short.json().daily.reduce((sum: number, day: { calls: number }) => sum + day.calls, 0), 3)
  assert.equal(short.json().daily.reduce((sum: number, day: { minutes: number }) => sum + day.minutes, 0), 2)
  assert.deepEqual(short.json().usage.charges, [{ currency: 'USD', amount: '0.1250' }, { currency: 'EUR', amount: '0.5000' }])
  const long = await app.inject({ url: '/api/admin/analytics?days=30', headers: admin })
  assert.equal(long.json().outcomes.confirmed, 1)
  assert.equal(long.json().callbacks.telnyx.completed, 1)
  assert.equal(long.json().daily.length, 30)
})

test('admin live-action toggles persist, gate assistants and preserve child preferences while paused', async () => {
  const originalKey = process.env.GEMINI_API_KEY
  const headers = { cookie: 'desk_session=admin-test' }, url = '/api/admin/order-controls'
  const { restoreOrderControls } = await import('./order-controls.ts')
  const update = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload })
  try {
    assert.equal((await app.inject({ method: 'POST', url, payload: { enabled: false } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: 'desk_session=user-test' }, payload: { enabled: false } })).statusCode, 403)
    assert.equal((await update({ enabled: 'yes' })).statusCode, 400)
    assert.equal((await update({ enabled: true, voice: true })).statusCode, 400)
    assert.equal((await update({ enabled: false })).json().enabled, false)
    assert.equal((await update({ text: true })).statusCode, 409)
    await update({ enabled: true })
    process.env.GEMINI_API_KEY = ''
    assert.equal((await update({ text: true })).statusCode, 409)
    process.env.GEMINI_API_KEY = 'synthetic-controls-key'
    const voice = await update({ voice: true })
    assert.equal(voice.statusCode, 200)
    assert.equal(voice.json().textAgent.enabled, false)
    assert.equal(voice.json().voice.enabled, true)
    const paused = await update({ enabled: false })
    assert.equal(paused.json().enabled, false)
    assert.equal(paused.json().textAgent.enabled, false)
    process.env.ORDER_AUTOMATION_ENABLED = 'true'
    process.env.TEXT_AGENT_ENABLED = 'false'
    process.env.VOICE_AGENT_ENABLED = 'false'
    await restoreOrderControls()
    assert.equal(process.env.ORDER_AUTOMATION_ENABLED, 'false')
    assert.equal(process.env.TEXT_AGENT_ENABLED, 'false')
    assert.equal(process.env.VOICE_AGENT_ENABLED, 'true')
    await update({ enabled: true })
    const textOff = await update({ text: false })
    assert.equal(textOff.json().voice.enabled, true)
    assert.equal(textOff.json().textAgent.enabled, false)
    const textOn = await update({ text: true })
    assert.equal(textOn.json().textAgent.enabled, true)
    assert.equal(textOn.json().voice.enabled, true)
    const voiceOff = await update({ voice: false })
    assert.equal(voiceOff.json().textAgent.enabled, true)
    assert.equal(voiceOff.json().voice.enabled, false)
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
})

test('overlapping automation changes preserve child preferences and failed updates do not block later saves', async () => {
  const { updateOrderControls } = await import('./order-controls.ts')
  const previousKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'synthetic-controls-key'
  try {
    await Promise.all([updateOrderControls({ text: true }), updateOrderControls({ enabled: false })])
    assert.equal(process.env.ORDER_AUTOMATION_ENABLED, 'false')
    assert.equal(process.env.TEXT_AGENT_ENABLED, 'true')
    const saved = fixture.tables.app_settings.find(row => row.key === 'order_automation_controls')!
    assert.deepEqual(JSON.parse(saved.value), { enabled: false, text: true, voice: false })
    await assert.rejects(updateOrderControls({ voice: true }), /Turn on Live actions/)
    await updateOrderControls({ enabled: true })
    assert.equal(process.env.TEXT_AGENT_ENABLED, 'true')
    assert.equal(process.env.VOICE_AGENT_ENABLED, 'false')
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
  }
})

test('duplicate CALL replies and simultaneous requests queue only one phone call', async () => {
  await createOrder(1, input)
  await Promise.all([reply('CALL ORDER-1', input.phone, 'first'), reply('CALL ORDER-1', input.phone, 'second')])
  await reply('CALL ORDER-1', input.phone, 'first')
  await Promise.all([runOrderJob(sendWhatsApp), runOrderJob(sendWhatsApp)])
  await drain()
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
  const dial = requests.find(item => item.path === '/calls')!
  assert.equal(dial.body.connection_id, 'test-call-control')
  assert.equal(dial.body.time_limit_secs, 90)
  assert.equal(dial.body.to, input.phone)
  assert.equal(requests[0].path, '/messages')
  assert.equal(fixture.tables.calls[0].user_id, 1)
})

test('signing out removes the session and protected routes require a fresh login', async () => {
  const headers = { cookie: 'desk_session=admin-test' }
  assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 200)
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers })
  assert.equal(logout.statusCode, 200)
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/)
  assert.equal((await app.inject({ url: '/api/orders', headers })).statusCode, 401)
})

test('cross-channel confirmation before dispatch prevents the queued phone call', async () => {
  await createOrder(1, input)
  await reply('CALL ORDER-1')
  await reply('CONFIRM ORDER-1')
  await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => item.path === '/calls').length, 0)
  assert.equal(requests.filter(item => item.path === '/messages' && String(item.body.text).includes('Your order is confirmed.')).length, 1)
  assert.match(String(requests[0].body.text), /Your order is confirmed/)
  await reply('CANCEL ORDER-1')
  assert.equal(current().status, 'confirmed')
})

test('unknown customers and unreferenced prose cannot change an order', async () => {
  await createOrder(1, input)
  assert.equal(await reply('CONFIRM ORDER-1', '+12025550999'), false)
  assert.equal(await reply('do not CONFIRM ORDER-1'), true)
  await reply('do not CONFIRM ORDER-1')
  await drain()
  assert.equal(requests.filter(item => item.path === '/messages').length, 1)
  assert.match(String(requests[0].body.text), /order status has not changed/)
  assert.equal(current().status, 'pending')
  await assert.rejects(requestOrderAction(1, current().id, 'call'), /customer requested/)
})

test('answer, repeat and keypad confirmation are idempotent and send one original-channel receipt', async () => {
  await createOrder(1, input)
  await reply('CALL ORDER-1'); await drain()
  await event('call.answered', 'answered'); await event('call.answered', 'answered-copy'); await drain()
  assert.equal(requests.filter(item => item.path.endsWith('/gather_using_audio')).length, 1)
  assert.equal(requests.find(item => item.path.endsWith('/gather_using_audio'))?.body.valid_digits, '129')
  await event('call.gather.ended', 'repeat', { digits: '9', status: 'valid' })
  await event('call.gather.ended', 'repeat', { digits: '9', status: 'valid' }); await drain()
  assert.equal(requests.filter(item => item.path.endsWith('/gather_using_audio')).length, 2)
  await event('call.gather.ended', 'confirm', { digits: '1', status: 'valid' })
  await event('call.gather.ended', 'confirm', { digits: '1', status: 'valid' }); await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => item.path === '/messages' && String(item.body.text).includes('Your order is confirmed.')).length, 1)
  assert.equal(requests.filter(item => item.path.endsWith('/hangup')).length, 1)
})

test('timeouts have a bounded menu and unanswered calls remain pending', async () => {
  await createOrder(1, input); await reply('CALL ORDER-1'); await drain()
  await event('call.answered', 'answer'); await drain()
  for (let i = 0; i < 3; i += 1) { await event('call.gather.ended', `timeout-${i}`, { status: 'timeout', digits: '' }); await drain() }
  assert.equal(requests.filter(item => item.path.endsWith('/gather_using_audio')).length, 3)
  assert.equal(requests.filter(item => item.path.endsWith('/hangup')).length, 1)
  await event('call.hangup', 'hangup')
  await event('call.answered', 'late-answer'); await drain()
  assert.equal(current().status, 'pending')
  assert.equal(current().call_status, 'unanswered')
  await reply('CALL ORDER-1', input.phone, 'redial-request'); await drain()
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
})

test('late keypad result after hangup wins over pending unanswered notification', async () => {
  await createOrder(1, { ...input, channel: 'whatsapp' }); await reply('CALL ORDER-1'); await drain()
  await event('call.answered', 'answer'); await drain()
  await event('call.hangup', 'hangup')
  await event('call.gather.ended', 'late-result', { digits: '2', status: 'valid' }); await drain()
  assert.equal(current().status, 'cancelled')
  for (const job of fixture.tables.order_jobs) job.available_at = '2000-01-01T00:00:00.000Z'
  await drain()
  assert.equal(whatsapp.filter(text => text.includes('Your order is cancelled.')).length, 1)
})

test('ambiguous provider failures and interrupted jobs never silently redial', async () => {
  await createOrder(1, input); await reply('CALL ORDER-1')
  failProvider = true; await drain(); await drain()
  assert.equal(current().call_status, 'review')
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
  const job = fixture.tables.order_jobs[0]
  job.status = 'working'; job.started_at = '2000-01-01T00:00:00.000Z'
  await drain()
  assert.equal(job.status, 'failed')
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
})

test('live flag and credit gates stop external actions', async () => {
  await createOrder(1, input)
  process.env.ORDER_AUTOMATION_ENABLED = 'false'
  await assert.rejects(requestOrderAction(1, current().id, 'invite'), /disabled/)
  assert.equal(await reply('CALL ORDER-1'), false)
  process.env.ORDER_AUTOMATION_ENABLED = 'true'
  fixture.tables.users[0].balance_units = 0
  await reply('CALL ORDER-1')
  assert.equal(current().attempt_id, null)
  assert.match(current().last_error, /credit/)
  await drain(); assert.equal(requests.length, 0)
})

test('signed SMS webhooks validate the receiving line and customer and deduplicate messages', async () => {
  await createOrder(1, input)
  const webhook = { data: { id: 'sms-event', event_type: 'message.received', payload: { id: 'sms-1', direction: 'inbound', from: { phone_number: input.phone }, to: [{ phone_number: process.env.TELNYX_PHONE_NUMBER }], text: 'CONFIRM ORDER-1' } } }
  const raw = JSON.stringify(webhook), timestamp = String(Math.floor(Date.now() / 1000))
  assert.equal(await handleOrderWebhook('message.received', 'wrong-line', { ...webhook.data.payload, to: [{ phone_number: '+12025550999' }] }), false)
  assert.equal(current().status, 'pending')
  const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), privateKey).toString('base64')
  assert.equal((await app.inject({ method: 'POST', url: '/api/telnyx/webhook', payload: webhook })).statusCode, 401)
  for (let i = 0; i < 2; i += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/telnyx/webhook', payload: raw, headers: { 'content-type': 'application/json', 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature } })
    assert.equal(response.statusCode, 200, response.body)
  }
  await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => item.path === '/messages').length, 1)
  assert.equal((await listOrders(2)).length, 0)
})

test('a stalled WhatsApp send is bounded and does not block the next order', async context => {
  await createOrder(1, { ...input, channel: 'whatsapp' })
  await requestOrderAction(1, current().id, 'invite')
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sending = runOrderJob(async () => new Promise<void>(() => {}))
    await setImmediate()
    context.mock.timers.tick(20000)
    await sending
    assert.equal(fixture.tables.order_jobs[0].status, 'failed')
    assert.match(current().last_error, /timed out/)
  } finally { context.mock.timers.reset() }
  const next = await createOrder(1, { ...input, reference: 'NEXT-ORDER' })
  await requestOrderAction(1, next.id, 'invite'); await drain()
  assert.equal(requests.filter(item => item.path === '/messages').length, 1)
})

test('only generic menu audio is public; arbitrary paths cannot read files', async () => {
  const audio = await app.inject({ url: '/api/order-audio/en.wav' })
  assert.equal(audio.statusCode, 200)
  assert.match(String(audio.headers['content-type']), /audio\/wav/)
  assert.equal((await app.inject({ url: '/api/order-audio/secrets.wav' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/orders/setup' })).statusCode, 401)
})

test('text agent queues input without waiting for a model, previews details, then saves only on customer approval', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  const planner = context.mock.method(textAgent, 'plan', async () => ({ action: 'details' as const, reference: 'ORDER-1', language: 'roman-ur' as const, details: { name: 'Ali', address: 'House 5 Lahore', notes: null } }))
  await createOrder(1, input)
  await reply('Mera naam Ali hai, address House 5 Lahore', input.phone, 'natural-1')
  await reply('Mera naam Ali hai, address House 5 Lahore', input.phone, 'natural-1')
  assert.equal(planner.mock.callCount(), 0)
  assert.equal(fixture.tables.order_jobs.filter(job => job.kind === 'agent_input').length, 1)
  await drain()
  assert.equal(planner.mock.callCount(), 1)
  assert.equal(current().customer, undefined)
  assert.match(whatsapp[0], /YES ORDER-1/)
  await reply('YES ORDER-1', input.phone, 'approve-details'); await drain()
  assert.equal(current().customer.name, 'Ali')
  assert.equal(current().customer.address, 'House 5 Lahore')
  assert.equal(current().status, 'pending')
  assert.equal(requests.length, 0, 'agent replies use incoming WhatsApp, not the SMS order channel')
  await reply('YES ORDER-1', input.phone, 'approve-details'); await drain()
  assert.equal(whatsapp.length, 2)
})

test('agent confirmation needs the delivered same-channel preview and sends one original-channel receipt', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  context.mock.method(textAgent, 'plan', async () => ({ action: 'confirm' as const, reference: 'ORDER-1', language: 'en' as const, details: null }))
  await createOrder(1, input)
  await reply('Please confirm my order', input.phone, 'propose')
  await reply('yes', input.phone, 'too-early')
  await drain()
  assert.equal(current().status, 'pending')
  await handleOrderMessage({ id: 'wrong-channel', phone: input.phone, channel: 'sms', body: 'YES ORDER-1' }); await drain()
  assert.equal(current().status, 'pending')
  await reply('YES ORDER-1', input.phone, 'approve'); await drain()
  await reply('YES ORDER-1', input.phone, 'approve'); await drain()
  assert.equal(current().status, 'confirmed')
  assert.equal(requests.filter(item => String(item.body.text).includes('Your order is confirmed.')).length, 1)
  assert.equal(requests.filter(item => item.path === '/calls').length, 0)
})

test('unknown senders, invalid model output, expired proposals and negated approvals never change orders', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  const planner = context.mock.method(textAgent, 'plan', async () => ({ action: 'cancel' as const, reference: 'PRIVATE-ORDER', language: 'en' as const, details: null }))
  await createOrder(1, input)
  assert.equal(await reply('confirm my order', '+12025550999', 'outsider'), false)
  await reply('cancel my order', input.phone, 'bad-plan'); await drain()
  assert.equal(current().status, 'pending')
  assert.match(whatsapp[0], /Nothing was changed/)
  planner.mock.mockImplementation(async () => ({ action: 'cancel' as const, reference: 'ORDER-1', language: 'en' as const, details: null }))
  await reply('cancel my order', input.phone, 'proposal'); await drain()
  current().agent_proposal.expires_at = '2000-01-01T00:00:00Z'
  await reply('YES ORDER-1', input.phone, 'expired'); await drain()
  assert.equal(current().status, 'pending')
  await reply('cancel my order', input.phone, 'proposal-2'); await drain()
  await reply('NO ORDER-1', input.phone, 'withdraw'); await drain()
  assert.equal(current().agent_proposal, null)
  assert.equal(current().status, 'pending')
})

test('agent failures fall back to exact commands and cannot hold the telephony queue', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  let finish!: () => void
  context.mock.method(textAgent, 'plan', async () => { await new Promise<void>(resolve => { finish = resolve }); throw new Error('Simulated model outage') })
  await createOrder(1, input)
  await reply('what is my order?', input.phone, 'slow-model')
  const processing = runOrderJob(sendWhatsApp, 'agent')
  await setImmediate()
  await reply('CALL ORDER-1'); await runOrderJob(sendWhatsApp, 'actions'); await runOrderJob(sendWhatsApp, 'actions')
  assert.equal(requests.filter(item => item.path === '/calls').length, 1)
  finish(); await processing; await drain()
  assert.match(whatsapp[0], /Nothing was changed/)
  assert.equal(current().status, 'pending')
})

test('natural-language SMS callback uses the same guarded one-attempt call workflow', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  context.mock.method(textAgent, 'plan', async () => ({ action: 'call' as const, reference: 'ORDER-1', language: 'roman-ur' as const, details: null }))
  await createOrder(1, input)
  const sms = (id: string, text: string) => handleOrderWebhook('message.received', id, { id, direction: 'inbound', from: { phone_number: input.phone }, to: [{ phone_number: process.env.TELNYX_PHONE_NUMBER }], text })
  await sms('natural-sms', 'Mujhe order ke liye phone karein'); await drain()
  assert.equal(current().attempt_id, null)
  assert.match(String(requests[0].body.text), /YES ORDER-1/)
  await sms('approved-sms', 'haan ORDER-1'); await drain()
  assert.equal(current().call_requested_via, 'sms')
  assert.equal(requests.filter(request => request.path === '/calls').length, 1)
  await sms('duplicate-approved', 'haan ORDER-1'); await drain()
  assert.equal(requests.filter(request => request.path === '/calls').length, 1)
})

test('agent intake is bounded per customer and the feature switch skips model processing', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  const planner = context.mock.method(textAgent, 'plan', async () => { throw new Error('Must not call the model after disabling') })
  await createOrder(1, input)
  await Promise.all(Array.from({ length: 9 }, (_, index) => reply('tell me about my order', input.phone, `burst-${index}`)))
  assert.equal(fixture.tables.order_jobs.filter(job => job.kind === 'agent_input').length, 6)
  assert.equal(fixture.tables.order_jobs.filter(job => job.kind === 'agent_reply').length, 1)
  process.env.TEXT_AGENT_ENABLED = 'false'
  await drain()
  assert.equal(planner.mock.callCount(), 0)
  assert.equal(current().status, 'pending')
  await reply('CONFIRM ORDER-1', input.phone, 'exact-after-rate-limit'); await drain()
  assert.equal(current().status, 'confirmed')
})

test('agent status reads facts and a quota error is recorded without leaking provider details', async context => {
  process.env.TEXT_AGENT_ENABLED = 'true'
  const planner = context.mock.method(textAgent, 'plan', async () => ({ action: 'status' as const, reference: 'ORDER-1', language: 'ur' as const, details: null }))
  await createOrder(1, input)
  await reply('میرے آرڈر کی تفصیل کیا ہے؟', input.phone, 'read-status'); await drain()
  assert.match(whatsapp[0], /Two shirts; 2500.00 PKR/)
  assert.equal(current().agent_proposal, undefined)
  planner.mock.mockImplementation(async () => { throw new Error('429 quota exhausted; fake-secret-must-not-be-stored') })
  await reply('What is my order?', input.phone, 'quota'); await drain()
  assert.match(current().last_error, /quota exhausted/)
  assert.doesNotMatch(JSON.stringify(fixture.tables), /fake-secret-must-not-be-stored/)
  assert.equal(current().status, 'pending')
})
