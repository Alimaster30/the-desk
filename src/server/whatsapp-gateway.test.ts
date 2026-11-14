import assert from 'node:assert/strict'
import { beforeEach, after, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

process.env.APP_TEST = '1'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
process.env.WHATSAPP_VOICE_TOKEN = 'shared-gateway-test-token'.padEnd(32, 'x')
const { orderTestStore } = await import('./orders.fixture.ts')
const fixture = orderTestStore()
const { sharedWhatsAppSocket } = await import('./whatsapp-gateway.ts')
let state: Record<string, unknown>, requests: { path: string; body: any }[]
mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
  const target = new URL(String(url))
  assert.equal(target.origin, 'http://127.0.0.1:8795')
  const body = init.body ? JSON.parse(String(init.body)) : null
  requests.push({ path: target.pathname + target.search, body })
  if (target.pathname === '/status') return Response.json(state)
  if (target.pathname === '/events') return Response.json(target.searchParams.get('after') === '0' ? [{ id: 1, event: { type: 'messages.upsert', data: { type: 'notify', messages: [{ key: { remoteJid: '123@lid', id: 'message-1' }, message: { conversation: 'Hello' } }] } } }] : [])
  if (target.pathname === '/logout') { state = { state: 'qr', qr: 'fresh-shared-qr' }; return Response.json({ ok: true, remoteLogout: true }) }
  if (target.pathname === '/send') return Response.json({ key: { id: 'sent-1' } })
  throw new Error('Unexpected gateway operation.')
})
beforeEach(() => { fixture.reset(); requests = []; state = { state: 'qr', qr: 'one-shared-qr' } })
after(() => mock.restoreAll())

test('one shared QR drives messaging, text/media sends and account identity', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { sock } = await sharedWhatsAppSocket(false)
  const connections: any[] = [], messages: any[] = []
  sock.ev.on('connection.update', event => connections.push(event))
  sock.ev.on('messages.upsert', event => messages.push(event))
  try {
    context.mock.timers.tick(0); await setImmediate()
    assert.equal(connections[0].qr, 'one-shared-qr')
    state = { state: 'ready', owner: { id: 'owner@s.whatsapp.net', name: 'Desk Owner' } }
    context.mock.timers.tick(700); await setImmediate()
    assert.equal(connections[1].connection, 'open')
    assert.equal(messages[0].messages[0].key.remoteJid, '123@lid')
    assert.match(fixture.tables.app_settings.find(row => row.key === 'wa_account')?.value, /Desk Owner/)
    assert.equal((await sock.sendMessage('123@lid', { text: 'Reply' })).key.id, 'sent-1')
    await sock.sendMessage('123@lid', { image: Buffer.from('photo'), caption: 'Photo', mimetype: 'image/png' })
    const photo = requests.filter(row => row.path === '/send').at(-1)!.body
    assert.equal(photo.attachment.data, Buffer.from('photo').toString('base64'))
    assert.equal(photo.text, 'Photo')
    sock.end()
    await assert.rejects(sock.sendMessage('123@lid', { text: 'Too late' }), /session has ended/)
  } finally { sock.end(); context.mock.timers.reset() }
})

test('a fresh connection revokes saved credentials before offering a new shared QR', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { sock } = await sharedWhatsAppSocket(true)
  const updates: any[] = []
  sock.ev.on('connection.update', event => updates.push(event))
  try {
    context.mock.timers.tick(0); await setImmediate()
    assert.equal(requests.filter(row => row.path === '/logout').length, 1)
    assert.equal(updates[0].qr, 'fresh-shared-qr')
  } finally { sock.end(); context.mock.timers.reset() }
})
