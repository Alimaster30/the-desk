import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { after, beforeEach, mock, test } from 'node:test'
import type { AuthUser } from './auth.ts'

process.env.APP_TEST = '1'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
process.env.TELNYX_API_KEY = 'sms-test-key'
process.env.TELNYX_SMS_PHONE_NUMBER = '+12025550100'
process.env.TELNYX_PHONE_NUMBER = '+12025550100'
process.env.GEMINI_API_KEY = 'sms-test-model-key'
process.env.PUBLIC_BASE_URL = 'https://example.test'
process.env.ORDER_AUTOMATION_ENABLED = 'false'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const { orderTestStore } = await import('./orders.fixture.ts')
const fixture = orderTestStore()
const { sendSms, recordSms, smsMessages, smsConversations, smsLines, smsSummary } = await import('./sms.ts')
const { app } = await import('./index.ts')
const admin: AuthUser = { id: 1, name: 'Desk Admin', email: 'admin@example.test', role: 'admin', orderAccess: true, balanceUnits: 100000 }
const user: AuthUser = { ...admin, id: 2, name: 'Sara', role: 'user', orderAccess: false }
const line = '+12025550122', remote = '+12025550123', id = `${line}:${remote}`
let requests: { url: string; body: any }[] = []
let failed = false
let rejected = false
mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
  const target = String(url), body = JSON.parse(String(init.body || '{}'))
  requests.push({ url: target, body })
  if (target.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({ candidates: [{ content: { parts: [{ text: 'Sara confirmed the delivery address with the contact.' }] } }] })
  assert.equal(target, 'https://api.telnyx.com/v2/messages')
  if (rejected) return Response.json({ errors: [{ detail: "The 'from' address should be string containing a valid number associated with the sending messaging profile." }] }, { status: 400 })
  if (failed) throw new Error('Provider connection lost after possible acceptance.')
  return Response.json({ data: { id: `provider-${requests.length}`, to: [{ status: 'queued' }] } })
})
beforeEach(() => {
  fixture.reset({ users: [{ ...admin, balance_units: 100000 }, { ...user, balance_units: 100000 }], sessions: [{ token: 'sms-user', user_id: 2, expires_at: '2099-01-01T00:00:00.000Z' }, { token: 'sms-admin', user_id: 1, expires_at: '2099-01-01T00:00:00.000Z' }], owned_numbers: [{ phone_number: line, user_id: 2, order_status: 'ordered' }] })
  requests = []; failed = false; rejected = false
  process.env.PUBLIC_BASE_URL = 'https://example.test'
})
after(async () => { await app.close(); mock.restoreAll() })
const inbound = (messageId = 'in-1', text = 'Is delivery tomorrow?', time = '2026-11-14T10:00:00.000Z') => ({ id: messageId, direction: 'inbound', from: { phone_number: remote }, to: [{ phone_number: line }], text, received_at: time, media: [] })
const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/sms/conversations/${encodeURIComponent(id)}/send`, headers: { cookie: 'desk_session=sms-user' }, payload })

test('SMS routes isolate lines, history, sends and summaries even from another admin', async () => {
  await recordSms('message.received', inbound())
  assert.deepEqual(await smsLines(user), [line])
  assert.deepEqual(await smsLines(admin), ['+12025550100'])
  assert.equal((await smsConversations(user)).length, 1)
  assert.equal((await smsConversations(admin)).length, 0)
  for (const suffix of ['messages', 'summary', 'send']) {
    const response = await app.inject({ method: suffix === 'messages' ? 'GET' : 'POST', url: `/api/sms/conversations/${encodeURIComponent(id)}/${suffix}`, headers: { cookie: 'desk_session=sms-admin' }, ...(suffix === 'send' ? { payload: { text: 'Private', requestId: randomUUID() } } : {}) })
    assert.equal(response.statusCode, 403)
  }
  assert.equal((await app.inject({ url: '/api/sms/conversations' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/sms/setup', headers: { cookie: 'desk_session=sms-user' } })).statusCode, 200)
  assert.equal(requests.length, 0)
})

test('the fallback sender belongs only to the first admin and a number transfer cannot expose prior messages', async () => {
  const otherAdmin: AuthUser = { ...admin, id: 3, name: 'Other admin' }
  fixture.tables.users.push(otherAdmin)
  assert.deepEqual(await smsLines(otherAdmin), [])
  await recordSms('message.received', inbound())
  fixture.tables.owned_numbers[0].user_id = 3
  await recordSms('message.received', inbound())
  assert.equal((await smsMessages(otherAdmin, id)).length, 0)
  await assert.rejects(smsMessages(user, id), /does not belong/)
  assert.equal(fixture.tables.sms_messages[0].user_id, user.id)
})

test('manual SMS remains available with assistants off and is deduplicated across retries', async () => {
  const payload = { text: 'Hello 👋', requestId: randomUUID() }
  const first = await send(payload)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().ok, true)
  assert.equal((await send(payload)).json().id, first.json().id)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].body, { from: line, to: remote, text: payload.text, type: 'SMS' })
  assert.equal((await smsMessages(user, id))[0].status, 'queued')
  assert.equal((await send({ ...payload, text: 'Changed' })).statusCode, 409)
  assert.equal((await send({ text: 'No request id' })).statusCode, 400)
  fixture.tables.users[1].balance_units = 0
  assert.equal((await send({ text: 'No credit', requestId: randomUUID() })).statusCode, 402)
})

test('concurrent duplicate requests send once and ambiguous failures cannot silently resend', async () => {
  const payload = { text: 'Single message', requestId: randomUUID() }
  const responses = await Promise.all([send(payload), send(payload)])
  assert.equal(requests.length, 1)
  assert.ok(responses.some(response => response.statusCode === 200))
  failed = true
  const uncertain = { text: 'Uncertain', requestId: randomUUID() }
  assert.equal((await send(uncertain)).statusCode, 500)
  failed = false
  assert.equal((await send(uncertain)).statusCode, 409)
  assert.equal(requests.length, 2)
})

test('explicit sender rejections explain the sending number and allow a safe retry after fixing configuration', async () => {
  const payload = { text: 'Retry after setup', requestId: randomUUID() }
  rejected = true
  const response = await send(payload)
  assert.equal(response.statusCode, 400)
  assert.match(response.json().error, /Sending number \+12025550122/)
  assert.equal(fixture.tables.sms_sends[0].status, 'rejected')
  rejected = false
  const retries = await Promise.all([send(payload), send(payload)])
  assert.ok(retries.some(result => result.statusCode === 200))
  assert.equal(requests.length, 2)
  assert.equal(fixture.tables.sms_sends[0].status, 'accepted')
  assert.equal((await send(payload)).statusCode, 200)
  assert.equal(requests.length, 2)
})

test('signed inbound SMS is saved with automation paused; duplicate events and old events keep latest preview', async () => {
  const payload = JSON.stringify({ data: { event_type: 'message.received', id: 'event-1', payload: inbound() } })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = sign(null, Buffer.from(`${timestamp}|${payload}`), privateKey).toString('base64')
  const post = () => app.inject({ method: 'POST', url: '/api/telnyx/webhook', payload, headers: { 'content-type': 'application/json', 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature } })
  assert.equal((await post()).statusCode, 200)
  assert.equal((await post()).statusCode, 200)
  assert.equal((await smsMessages(user, id)).length, 1)
  await recordSms('message.received', inbound('old', 'Older', '2026-11-13T10:00:00.000Z'))
  assert.equal((await smsConversations(user))[0].last_text, 'Is delivery tomorrow?')
  assert.equal((await app.inject({ method: 'POST', url: '/api/telnyx/webhook', payload, headers: { 'content-type': 'application/json' } })).statusCode, 401)
  assert.equal(requests.length, 0)
})

test('final delivery status does not regress and messaging cost debits once', async () => {
  await sendSms(user, id, { text: 'Delivery', requestId: randomUUID() })
  const receipt = { id: 'provider-1', direction: 'outbound', from: { phone_number: line }, to: [{ phone_number: remote, status: 'delivered' }], text: 'Delivery', cost: { amount: '0.0100', currency: 'USD' } }
  await recordSms('message.finalized', receipt)
  await recordSms('message.finalized', receipt)
  await recordSms('message.sent', { ...receipt, to: [{ phone_number: remote, status: 'sent' }] })
  assert.equal((await smsMessages(user, id))[0].status, 'delivered')
  assert.equal(fixture.tables.users[1].balance_units, 99900)
  assert.equal(fixture.tables.ledger.length, 1)
})

test('MMS validates photos, creates a temporary provider link and keeps owner-only media access', async () => {
  const attachment = { kind: 'image', name: 'test.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') }
  const response = await send({ text: 'Photo', requestId: randomUUID(), attachment })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(requests[0].body.type, 'MMS')
  const url = new URL(requests[0].body.media_urls[0]), token = url.pathname.split('/').at(-1)
  assert.equal((await app.inject({ url: url.pathname })).statusCode, 200)
  assert.equal((await app.inject({ url: `/api/sms/media/${token}`, headers: { cookie: 'desk_session=sms-admin' } })).statusCode, 404)
  fixture.tables.sms_media[0].public_until = '2000-01-01T00:00:00.000Z'
  assert.equal((await app.inject({ url: url.pathname })).statusCode, 404)
  assert.equal((await app.inject({ url: `/api/sms/media/${token}`, headers: { cookie: 'desk_session=sms-user' } })).statusCode, 200)
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787'
  assert.equal((await send({ requestId: randomUUID(), attachment })).statusCode, 409)
  assert.equal((await send({ requestId: randomUUID(), attachment: { ...attachment, kind: 'document' } })).statusCode, 400)
  assert.equal(requests.length, 1)
})

test('automatic summaries identify the line owner, cache unchanged texts and update for new messages', async () => {
  await recordSms('message.received', inbound())
  const first = await smsSummary(user, id) as { summaryText: string }
  assert.match(first.summaryText, /Sara/)
  assert.equal(requests.length, 1)
  assert.match(requests[0].body.contents[0].parts[0].text, /ownerName.*Sara/)
  await smsSummary(user, id)
  assert.equal(requests.length, 1)
  await recordSms('message.received', inbound('in-2', 'Please use my new address.'))
  await smsSummary(user, id)
  assert.equal(requests.length, 2)
})
