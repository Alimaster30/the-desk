import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.APP_TEST = '1'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
const { orderTestStore } = await import('./orders.fixture.ts')
const fixture = orderTestStore()
const { app } = await import('./index.ts')
const wa = await import('./whatsapp.ts')
const { mongoAuthState } = await import('./wa-auth.ts')
let events: EventEmitter
let opened = 0
let endCalls = 0
let freshRequested = false
let acknowledgeSends = true
let avatarUrl: string | undefined
const sentMessages: { jid: string; content: Record<string, unknown> }[] = []
mock.method(wa.whatsAppTransport, 'create', async (fresh: boolean) => {
  opened++
  freshRequested = fresh
  events = new EventEmitter()
  return { sock: { ev: events, end: () => { endCalls++ }, profilePictureUrl: async () => avatarUrl, sendMessage: async (jid: string, content: Record<string, unknown>) => {
    sentMessages.push({ jid, content })
    return acknowledgeSends ? { key: { id: `manual-test-${sentMessages.length}` } } : {}
  } }, saveCreds: async () => {} }
})
mock.method(wa.whatsAppTransport, 'logout', async () => ({ ok: true, remoteLogout: true }))
beforeEach(() => {
  wa.stopWhatsApp()
  opened = 0; endCalls = 0; freshRequested = false
  acknowledgeSends = true; sentMessages.length = 0
  avatarUrl = undefined
  fixture.reset({ users: [{ id: 1, role: 'admin' }, { id: 2, role: 'user' }], sessions: [{ token: 'admin-wa-test', user_id: 1, expires_at: '2099-01-01T00:00:00Z' }, { token: 'user-wa-test', user_id: 2, expires_at: '2099-01-01T00:00:00Z' }] })
})
after(async () => { wa.stopWhatsApp(); await app.close(); mock.restoreAll() })

test('personal calls use native WhatsApp IDs without needing a shared phone number', () => {
  assert.equal(wa.whatsAppCallTarget('123456789012345@lid'), '123456789012345@lid')
  assert.equal(wa.whatsAppCallTarget('123456789012345:0@lid'), '123456789012345@lid')
  assert.equal(wa.whatsAppCallTarget('12025550125:12@s.whatsapp.net'), '12025550125@s.whatsapp.net')
  assert.throws(() => wa.whatsAppCallTarget('12025550123@g.us'), /individual WhatsApp contacts/)
  assert.throws(() => wa.whatsAppCallTarget('status@broadcast'), /individual WhatsApp contacts/)
  assert.throws(() => wa.whatsAppCallTarget('123456@untrusted.example'), /individual WhatsApp contacts/)
})

test('call setup accepts individual LID chats without phone mappings and does not dial until the browser joins', async context => {
  const contacts = ['123456789012345@lid', '123456789012346@lid', '12025550123@s.whatsapp.net']
  fixture.tables.wa_chats = contacts.map(jid => ({ jid }))
  const voice = await import('./whatsapp-voice.ts')
  const original = process.env.WHATSAPP_VOICE_TOKEN
  process.env.WHATSAPP_VOICE_TOKEN = 'synthetic-voice-token'.padEnd(32, 'x')
  let dials = 0
  context.mock.method(globalThis, 'fetch', async () => Response.json({ state: 'ready' }))
  context.mock.method(voice.whatsAppVoiceTransport, 'connect', () => { dials++; throw new Error('A ticket must not place a call.') })
  try {
    for (const jid of contacts) {
      const response = await app.inject({ method: 'POST', url: `/api/whatsapp/chats/${encodeURIComponent(jid)}/call`, headers: { cookie: 'desk_session=admin-wa-test' } })
      assert.equal(response.statusCode, 200)
      assert.match(response.json().path, /^\/api\/whatsapp\/call\//)
    }
    assert.equal(dials, 0)
  } finally {
    if (original === undefined) delete process.env.WHATSAPP_VOICE_TOKEN
    else process.env.WHATSAPP_VOICE_TOKEN = original
  }
})

test('environment refresh picks up edited file values while preserving explicit process overrides', async () => {
  const { loadEnv } = await import('./env.ts')
  const original = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'desk-env-test-'))
  const key = 'DESK_ENV_REFRESH_TEST'
  const previous = process.env[key]
  try {
    delete process.env[key]
    process.chdir(directory)
    writeFileSync('.env', key + '=first\n')
    loadEnv([key])
    assert.equal(process.env[key], 'first')
    writeFileSync('.env', key + '=second\n')
    loadEnv([key])
    assert.equal(process.env[key], 'second')
    process.env[key] = 'explicit-override'
    writeFileSync('.env', key + '=third\n')
    loadEnv([key])
    assert.equal(process.env[key], 'explicit-override')
  } finally {
    process.chdir(original)
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
    unlinkSync(join(directory, '.env')); rmdirSync(directory)
  }
})

test('chat avatars are admin-only, cached and refuse non-WhatsApp image hosts', async context => {
  const jid = '12025550123@s.whatsapp.net'
  fixture.tables.wa_chats = [{ jid }]
  const url = `/api/whatsapp/chats/${encodeURIComponent(jid)}/avatar`
  const headers = { cookie: 'desk_session=admin-wa-test' }
  assert.equal((await app.inject({ url })).statusCode, 401)
  assert.equal((await app.inject({ url, headers: { cookie: 'desk_session=user-wa-test' } })).statusCode, 403)
  wa.connectWhatsApp(); await setImmediate()
  let downloads = 0
  context.mock.method(globalThis, 'fetch', async () => {
    downloads++
    return new Response(Buffer.from('synthetic-image'), { headers: { 'Content-Type': 'image/jpeg' } })
  })
  avatarUrl = 'https://127.0.0.1/private'
  assert.equal((await app.inject({ url, headers })).statusCode, 404)
  assert.equal(downloads, 0)
  wa.stopWhatsApp(); wa.connectWhatsApp(); await setImmediate()
  avatarUrl = 'https://pps.whatsapp.net/synthetic-profile'
  const image = await app.inject({ url, headers })
  assert.equal(image.statusCode, 200)
  assert.equal(image.headers['content-type'], 'image/jpeg')
  await app.inject({ url, headers })
  assert.equal(downloads, 1)
})

test('manual text and attachments work with auto-reply off and preserve admin-only access', async () => {
  const jid = '12025550123@s.whatsapp.net', headers = { cookie: 'desk_session=admin-wa-test' }
  const url = `/api/whatsapp/chats/${encodeURIComponent(jid)}/send`
  fixture.tables.wa_chats = [{ jid, display_name: 'Synthetic customer' }]
  fixture.tables.app_settings = [{ key: 'auto_reply', value: '0' }]
  const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload })
  assert.equal((await app.inject({ method: 'POST', url, payload: { text: 'Hello' } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: 'desk_session=user-wa-test' }, payload: { text: 'Hello' } })).statusCode, 403)
  assert.equal((await send({ text: 'Hello' })).statusCode, 409)
  wa.connectWhatsApp(); await setImmediate()
  events.emit('connection.update', { connection: 'open' }); await setImmediate()
  assert.equal((await send({ text: '  Hello 👋  ' })).statusCode, 200)
  assert.deepEqual(sentMessages[0], { jid, content: { text: 'Hello 👋' } })
  assert.equal(fixture.tables.wa_messages[0].source, 'user')
  assert.equal((await send({ text: ' ' })).statusCode, 400)
  assert.equal((await send({ text: 'x'.repeat(4001) })).statusCode, 400)
  assert.equal((await send({ attachment: { kind: 'sticker', name: 'invalid.webp', data: Buffer.from('not WebP').toString('base64') } })).statusCode, 400)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6aSYAAAAASUVORK5CYII=', 'base64')
  assert.equal((await send({ text: 'Photo caption', attachment: { kind: 'image', name: '../photo.png', data: png.toString('base64') } })).statusCode, 200)
  assert.deepEqual(sentMessages[1].content.image, png)
  const row = fixture.tables.wa_messages.find(row => row.media)
  assert.ok(row)
  const attachment = await app.inject({ url: `/api/whatsapp/messages/${row.id}/attachment`, headers })
  assert.equal(attachment.statusCode, 200)
  assert.equal(attachment.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(attachment.rawPayload, png)
  assert.equal((await app.inject({ url: `/api/whatsapp/messages/${row.id}/attachment`, headers: { cookie: 'desk_session=user-wa-test' } })).statusCode, 403)
  acknowledgeSends = false
  const unconfirmed = await send({ text: 'Unconfirmed' })
  assert.equal(unconfirmed.statusCode, 502)
  assert.match(unconfirmed.json().error, /Check the conversation before retrying/)
  assert.equal(fixture.tables.wa_messages.length, 2)
})

test('attachment retries reuse the acknowledged send ID and support files up to the documented limit', async () => {
  const jid = '12025550123@s.whatsapp.net', headers = { cookie: 'desk_session=admin-wa-test' }
  fixture.tables.wa_chats = [{ jid }]
  wa.connectWhatsApp(); await setImmediate()
  events.emit('connection.update', { connection: 'open' }); await setImmediate()
  const url = `/api/whatsapp/chats/${encodeURIComponent(jid)}/send`
  const requestId = '28362398-3dcc-486c-9879-fb3c577f5900'
  const data = Buffer.alloc(5 * 1024 * 1024, 65)
  const payload = { requestId, text: 'Document at size limit', attachment: { kind: 'document', name: 'test.bin', data: data.toString('base64') } }
  const first = await app.inject({ method: 'POST', url, headers, payload })
  assert.equal(first.statusCode, 200)
  const retry = await app.inject({ method: 'POST', url, headers, payload })
  assert.equal(retry.statusCode, 200)
  assert.equal(retry.json().duplicate, true)
  assert.equal(sentMessages.length, 1)
  assert.equal(fixture.tables.wa_messages.length, 1)
  const changed = await app.inject({ method: 'POST', url, headers, payload: { ...payload, text: 'Different content using the same ID' } })
  assert.equal(changed.statusCode, 409)
  assert.equal(sentMessages.length, 1)
  const tooLarge = await app.inject({ method: 'POST', url, headers, payload: { text: '', attachment: { kind: 'document', name: 'large.bin', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') } } })
  assert.equal(tooLarge.statusCode, 400)
  assert.equal(sentMessages.length, 1)
})

test('automatic summaries reuse saved text, refresh on new messages and deduplicate concurrent requests', async context => {
  const jid = 'summary-test@s.whatsapp.net'
  fixture.tables.wa_chats = [{ jid }]
  fixture.tables.wa_messages = [{ id: 1, chat_jid: jid, body: 'Please deliver tomorrow.', timestamp: '2026-11-14T00:00:00Z', from_me: 0 }]
  process.env.GEMINI_API_KEY = 'synthetic-summary-key'
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    await setImmediate()
    return Response.json({ candidates: [{ content: { parts: [{ text: `Summary version ${calls}` }] } }] })
  })
  const { chatSummary } = await import('./chat-summary.ts')
  const [first, duplicate] = await Promise.all([chatSummary(jid), chatSummary(jid)])
  assert.equal(calls, 1)
  assert.deepEqual(first, duplicate)
  assert.equal(first.summaryMessageCount, 1)
  assert.equal((await chatSummary(jid)).summaryText, first.summaryText)
  assert.equal(calls, 1)
  fixture.tables.wa_messages.push({ id: 2, chat_jid: jid, body: 'Address is unchanged.', timestamp: '2026-11-14T00:01:00Z', from_me: 0 })
  const updated = await chatSummary(jid)
  assert.equal(calls, 2)
  assert.equal(updated.summaryMessageCount, 2)
  assert.equal(updated.summaryStale, false)
})

test('summary identifies the linked WhatsApp owner and refreshes cached summaries after an owner name change', async context => {
  const jid = 'owner-summary@s.whatsapp.net'
  fixture.tables.wa_auth = [{ key: 'active-session', data: JSON.stringify('current-') }, { key: 'current-creds.json', data: JSON.stringify({ me: { id: 'owner@s.whatsapp.net', name: 'Tahir Ali' } }) }]
  fixture.tables.wa_chats = [{ jid, display_name: 'Hadi_', summary_text: 'Hadi asks the user.', summary_message_count: 2 }]
  fixture.tables.wa_messages = [
    { id: 1, chat_jid: jid, push_name: 'Hadi_', body: 'Where shall we meet?', timestamp: '2026-11-14T00:00:00Z', from_me: 0 },
    { id: 2, chat_jid: jid, body: 'Outside.', timestamp: '2026-11-14T00:01:00Z', from_me: 1 },
  ]
  process.env.GEMINI_API_KEY = 'synthetic-summary-key'
  const requests: string[] = []
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(String(init.body))
    return Response.json({ candidates: [{ content: { parts: [{ text: 'Hadi asks Tahir Ali where to meet.' }] } }] })
  })
  const { chatSummary } = await import('./chat-summary.ts')
  await chatSummary(jid)
  const prompt = JSON.parse(requests[0])
  assert.match(prompt.contents[0].parts[0].text, /Tahir Ali: Outside\./)
  assert.match(prompt.contents[0].parts[0].text, /Hadi_: Where shall we meet\?/)
  assert.doesNotMatch(prompt.contents[0].parts[0].text, /You: Outside/)
  await chatSummary(jid)
  assert.equal(requests.length, 1)
  fixture.tables.wa_auth[1].data = JSON.stringify({ me: { id: 'owner@s.whatsapp.net', name: 'Desk Support' } })
  await chatSummary(jid)
  assert.equal(requests.length, 2)
  assert.match(JSON.parse(requests[1]).contents[0].parts[0].text, /Desk Support: Outside/)
})

test('only admins can connect and repeated clicks reuse the connecting or QR socket', { timeout: 5000 }, async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/whatsapp/connect' })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/api/whatsapp/connect', headers: { cookie: 'desk_session=user-wa-test' } })).statusCode, 403)
  const start = () => app.inject({ method: 'POST', url: '/api/whatsapp/connect', headers: { cookie: 'desk_session=admin-wa-test' } })
  assert.equal((await start()).statusCode, 200)
  await start(); await setImmediate()
  assert.equal(opened, 1)
  let unsubscribe = () => {}
  const qrReady = new Promise<void>(resolve => { unsubscribe = wa.subscribeWhatsApp(next => { if (next.connection === 'qr') resolve() }) })
  events.emit('connection.update', { qr: 'synthetic-test-pairing-value' })
  await qrReady
  unsubscribe()
  assert.match(wa.whatsAppStatus().qrDataUrl || '', /^data:image\/png;base64,/)
  await start()
  assert.equal(opened, 1)
  events.emit('connection.update', { connection: 'open' }); await setImmediate()
  await start()
  assert.equal(wa.whatsAppStatus().connection, 'open')
  assert.equal(wa.whatsAppStatus().qrDataUrl, null)
  assert.equal(opened, 1)
})

test('a logged-out socket requests fresh pairing and ignores late events from the old socket', async () => {
  wa.connectWhatsApp(); await setImmediate()
  const oldEvents = events
  events.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
  await setImmediate()
  assert.match(wa.whatsAppStatus().error || '', /Connect/)
  wa.connectWhatsApp(); await setImmediate()
  assert.equal(freshRequested, true)
  assert.equal(opened, 2)
  oldEvents.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
  await setImmediate()
  assert.equal(wa.whatsAppStatus().connection, 'starting')
})

test('admin disconnect persists across startup, ignores stale socket events and allows an explicit reconnect', async () => {
  const url = '/api/whatsapp/disconnect'
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: 'desk_session=user-wa-test' } })).statusCode, 403)
  const headers = { cookie: 'desk_session=admin-wa-test' }
  await wa.startWhatsApp(); await setImmediate()
  const oldEvents = events
  oldEvents.emit('connection.update', { connection: 'open' })
  const disconnected = await app.inject({ method: 'POST', url, headers })
  assert.equal(disconnected.statusCode, 200)
  assert.deepEqual(disconnected.json(), { connection: 'paused', qrDataUrl: null, error: null })
  assert.equal(endCalls, 1)
  oldEvents.emit('connection.update', { connection: 'open' })
  assert.equal(wa.whatsAppStatus().connection, 'paused')
  wa.stopWhatsApp()
  await wa.startWhatsApp(); await setImmediate()
  assert.equal(wa.whatsAppStatus().connection, 'paused')
  assert.equal(opened, 1)
  assert.equal((await app.inject({ method: 'POST', url: '/api/whatsapp/connect', headers })).statusCode, 200)
  await setImmediate()
  assert.equal(opened, 2)
  assert.equal(freshRequested, false)
  wa.stopWhatsApp()
  await wa.startWhatsApp(); await setImmediate()
  assert.equal(opened, 3)
})

test('a stalled handshake becomes retryable and stop cancels pending reconnects', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    wa.connectWhatsApp(); await setImmediate()
    context.mock.timers.tick(45000); await setImmediate()
    assert.equal(wa.whatsAppStatus().connection, 'error')
    assert.match(wa.whatsAppStatus().error || '', /timed out/)
    assert.equal(endCalls, 1)
    wa.connectWhatsApp(); await setImmediate()
    events.emit('connection.update', { connection: 'close' }); await setImmediate()
    wa.stopWhatsApp()
    context.mock.timers.tick(5000); await setImmediate()
    assert.equal(opened, 2)
  } finally { context.mock.timers.reset() }
})

test('fresh pairing preserves old auth records and isolates subsequent credential writes', async () => {
  const original = await mongoAuthState()
  await original.saveCreds()
  const oldData = fixture.tables.wa_auth.find(row => row.key === 'creds.json')!.data
  const fresh = await mongoAuthState(true)
  await fresh.saveCreds()
  assert.equal(fixture.tables.wa_auth.find(row => row.key === 'creds.json')!.data, oldData)
  assert.equal(fixture.tables.wa_auth.filter(row => row.key.endsWith('creds.json')).length, 2)
  const active = fixture.tables.wa_auth.find(row => row.key === 'active-session')
  assert.ok(active)
  const restored = await mongoAuthState()
  assert.deepEqual(restored.state.creds.noiseKey, fresh.state.creds.noiseKey)
})

test('logout clears chat history, summaries, auth, learned style and queued WhatsApp actions while preserving SMS', async () => {
  const jid = '12345@s.whatsapp.net'
  fixture.tables.wa_chats = [{ jid, summary_text: 'Private summary' }]
  fixture.tables.wa_messages = [{ id: 1, wa_message_id: 'private-message', chat_jid: jid, body: 'Private text', timestamp: new Date().toISOString() }]
  fixture.tables.wa_auth = [{ key: 'creds.json', data: 'private credentials' }]
  fixture.tables.wa_replies = [{ inbound_id: 'private-message' }]
  fixture.tables.app_settings = [{ key: 'reply_pattern', value: 'Private style' }, { key: 'auto_reply', value: '1' }, { key: 'wa_voice_enabled', value: '1' }]
  fixture.tables.sms_messages = [{ id: 'keep-sms', body: 'SMS stays' }]
  fixture.tables.orders = [{ id: 'wa-order', channel: 'whatsapp', call_mode: 'ivr' }, { id: 'sms-order', channel: 'sms', call_mode: 'whatsapp' }]
  fixture.tables.order_jobs = [{ key: 'wa-message', kind: 'invite', order_id: 'wa-order', status: 'pending' }, { key: 'sms-message', kind: 'invite', order_id: 'sms-order', status: 'pending' }, { key: 'wa-call', kind: 'voice', order_id: 'sms-order', status: 'pending' }, { key: 'telnyx-call', kind: 'voice', order_id: 'wa-order', status: 'pending' }]
  await wa.startWhatsApp(); await setImmediate()
  events.emit('connection.update', { connection: 'open' })
  const oldEvents = events
  await wa.disconnectWhatsApp()
  for (const name of ['wa_chats', 'wa_messages', 'wa_auth', 'wa_replies']) assert.equal(fixture.tables[name].length, 0)
  assert.equal(fixture.tables.sms_messages.length, 1)
  assert.equal(fixture.tables.app_settings.find(row => row.key === 'reply_pattern'), undefined)
  assert.equal(fixture.tables.app_settings.find(row => row.key === 'auto_reply')?.value, '0')
  assert.equal(fixture.tables.app_settings.find(row => row.key === 'wa_gateway_logout_required')?.value, 'true')
  assert.deepEqual(fixture.tables.order_jobs.map(job => job.status), ['skipped', 'pending', 'skipped', 'pending'])
  oldEvents.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: jid, id: 'late-history' }, message: { conversation: 'Late history' } }] })
  await setImmediate()
  assert.equal(fixture.tables.wa_messages.length, 0)
  assert.equal((await app.inject({ url: '/api/whatsapp/chats', headers: { cookie: 'desk_session=admin-wa-test' } })).json().length, 0)
  await wa.resumeWhatsApp(); await setImmediate()
  assert.equal(freshRequested, true)
})

test('a summary completing after logout cannot restore the old account cache', async context => {
  const jid = 'logout-summary@s.whatsapp.net'
  fixture.tables.wa_chats = [{ jid }]
  fixture.tables.wa_messages = [{ id: 1, chat_jid: jid, body: 'Private text', timestamp: new Date().toISOString(), from_me: 0 }]
  process.env.GEMINI_API_KEY = 'logout-summary-model-key'
  let started!: () => void, release!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  context.mock.method(globalThis, 'fetch', async () => { started(); await hold; return Response.json({ candidates: [{ content: { parts: [{ text: 'Old account summary' }] } }] }) })
  const { chatSummary } = await import('./chat-summary.ts')
  const task = chatSummary(jid)
  await start
  await wa.disconnectWhatsApp()
  release()
  await assert.rejects(task, /session changed/)
  assert.equal(fixture.tables.wa_chats.length, 0)
})

test('the retired voice connection endpoint cannot enable or disable one feature separately', async () => {
  const url = '/api/whatsapp/voice'
  assert.equal((await app.inject({ method: 'POST', url, payload: { enabled: false } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: 'desk_session=user-wa-test' }, payload: { enabled: false } })).statusCode, 403)
  const headers = { cookie: 'desk_session=admin-wa-test' }
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { enabled: 'yes' } })).statusCode, 400)
  for (const enabled of [true, false]) {
    const response = await app.inject({ method: 'POST', url, headers, payload: { enabled } })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().error, /share one connection/)
  }
})

test('one account connection enables text and calls regardless of the legacy voice preference, and logout disables both', async context => {
  const voice = await import('./whatsapp-voice.ts')
  const previousToken = process.env.WHATSAPP_VOICE_TOKEN
  process.env.WHATSAPP_VOICE_TOKEN = 'shared-account-test-secret'.padEnd(32, 'x')
  fixture.tables.app_settings = [{ key: 'wa_voice_enabled', value: '0' }]
  context.mock.method(globalThis, 'fetch', async () => Response.json({ state: 'ready' }))
  try {
    wa.connectWhatsApp(); await setImmediate()
    events.emit('connection.update', { connection: 'open' }); await setImmediate()
    assert.equal(wa.whatsAppStatus().connection, 'open')
    assert.equal((await voice.whatsAppVoiceStatus()).enabled, true)
    await wa.disconnectWhatsApp()
    assert.equal(wa.whatsAppStatus().connection, 'paused')
    assert.equal((await voice.whatsAppVoiceStatus()).enabled, false)
    await wa.resumeWhatsApp(); await setImmediate()
    events.emit('connection.update', { connection: 'open' }); await setImmediate()
    assert.equal(wa.whatsAppStatus().connection, 'open')
    assert.equal((await voice.whatsAppVoiceStatus()).enabled, true)
  } finally {
    if (previousToken === undefined) delete process.env.WHATSAPP_VOICE_TOKEN
    else process.env.WHATSAPP_VOICE_TOKEN = previousToken
  }
})

test('summary quota failures preserve saved text and avoid repeat model calls until the provider retry time', async context => {
  const jid = 'quota-summary@s.whatsapp.net'
  fixture.tables.wa_chats = [{ jid, summary_text: 'Previously saved summary.', summary_message_count: 1, summary_at: '2026-11-14T00:00:00Z' }]
  fixture.tables.wa_messages = [{ id: 1, chat_jid: jid, body: 'A message', timestamp: '2026-11-14T00:00:00Z', from_me: 0 }]
  process.env.GEMINI_API_KEY = 'synthetic-summary-key'
  let requests = 0
  context.mock.method(globalThis, 'fetch', async () => {
    requests++
    if (requests > 1) return Response.json({ candidates: [{ content: { parts: [{ text: 'Fresh summary after quota reset.' }] } }] })
    return Response.json({ error: { message: 'Quota exceeded.', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }] } }, { status: 429 })
  })
  const { chatSummary } = await import('./chat-summary.ts')
  const result = await chatSummary(jid)
  assert.equal(result.summaryText, 'Previously saved summary.')
  assert.match(result.summaryNotice || '', /quota is exhausted/)
  assert.equal(result.summaryStale, true)
  assert.ok((result.retryAfterSeconds || 0) > 100)
  await chatSummary(jid)
  assert.equal(requests, 1)
  fixture.tables.wa_messages.push({ id: 2, chat_jid: 'no-saved-summary@s.whatsapp.net', body: 'Another chat', timestamp: '2026-11-14T00:00:00Z', from_me: 0 })
  const missing = await chatSummary('no-saved-summary@s.whatsapp.net')
  assert.equal(missing.summaryText, null)
  assert.match(missing.summaryNotice || '', /no saved summary/)
  assert.equal(requests, 1)
  const oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'different-synthetic-key'
  const withNewKey = await chatSummary('no-saved-summary@s.whatsapp.net')
  assert.equal(requests, 2)
  assert.equal(withNewKey.summaryNotice, undefined)
  process.env.GEMINI_API_KEY = oldKey
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    context.mock.timers.tick(121000)
    const recovered = await chatSummary(jid)
    assert.equal(requests, 3)
    assert.equal(recovered.summaryText, 'Fresh summary after quota reset.')
    assert.equal(recovered.summaryStale, false)
    assert.equal(recovered.summaryNotice, undefined)
  } finally { context.mock.timers.reset() }
})
