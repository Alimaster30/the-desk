import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mock, test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
process.env.TELNYX_API_KEY = 'test-only'
process.env.VOICE_AGENT_ENABLED = 'true'
const { orderTestStore } = await import('./orders.fixture.ts')
const { voiceTransport } = await import('./voice.ts')
const { attachTelnyxVoice, startTelnyxVoice, stopTelnyxVoice } = await import('./telnyx-voice.ts')
const { startWhatsAppVoice, stopWhatsAppVoiceCalls, whatsAppVoiceTransport, manualWhatsAppCallTicket, attachManualWhatsAppCalls } = await import('./whatsapp-voice.ts')

test('signed Telnyx stream passes audio both ways, clears interruption and limits decision tools', { timeout: 10000 }, async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  let streamUrl = ''
  mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    streamUrl = JSON.parse(String(init.body)).stream_url
    return Response.json({ data: { result: 'ok' } })
  })
  const model = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(model, 'listening')
  const modelPort = (model.address() as { port: number }).port
  mock.method(voiceTransport, 'connect', () => new WebSocket(`ws://127.0.0.1:${modelPort}`))
  const server = createServer()
  const stop = attachTelnyxVoice(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let telnyx: WebSocket | undefined
  const call = { attempt_id: 'test-attempt', call_control_id: 'test-control', reference: 'ORDER-1', item: 'Notebook', amount: '5.00', currency: 'USD', language: 'ur', channel: 'sms' } as const
  const proposed: string[] = []
  let fallback = 0
  try {
    await startTelnyxVoice(call, 'https://example.test', 'test-command', async action => { proposed.push(action); return true }, () => { fallback++ })
    const path = new URL(streamUrl).pathname
    const address = `ws://127.0.0.1:${port}${path}`
    const bad = new WebSocket(address)
    const [error] = await once(bad, 'error')
    assert.match(error.message, /403/)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(null, Buffer.from(`${timestamp}|${streamUrl}`), privateKey).toString('base64')
    const options = { headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature } }
    telnyx = new WebSocket(address, options)
    await once(telnyx, 'open')
    const modelConnection = once(model, 'connection')
    telnyx.send(JSON.stringify({ event: 'start', start: { call_control_id: 'test-control', media_format: { encoding: 'L16', sample_rate: 16000, channels: 1 } } }))
    const [gemini] = await modelConnection as [WebSocket]
    const read = async (socket: WebSocket) => JSON.parse(String((await once(socket, 'message'))[0]))
    assert.match((await read(gemini)).setup.systemInstruction.parts[0].text, /Pakistani Urdu/)
    const greeting = read(gemini)
    gemini.send(JSON.stringify({ setupComplete: {} }))
    assert.match((await greeting).realtimeInput.text, /Introduce yourself/)
    const audio = Buffer.alloc(640)
    audio.writeInt16LE(1234)
    const incoming = read(gemini)
    telnyx.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: '1', payload: audio.toString('base64') } }))
    assert.deepEqual(Buffer.from((await incoming).realtimeInput.audio.data, 'base64'), audio)
    const output = Buffer.alloc(960)
    for (let i = 0; i < output.length; i += 2) output.writeInt16LE(3456, i)
    const outgoing = read(telnyx)
    gemini.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: output.toString('base64') } }] } } }))
    const played = Buffer.from((await outgoing).media.payload, 'base64')
    assert.equal(played.length, 640)
    assert.equal(played.readInt16LE(638), 3456)
    const interrupted = read(telnyx)
    gemini.send(JSON.stringify({ serverContent: { interrupted: true } }))
    assert.equal((await interrupted).event, 'clear')
    for (const [id, action, status] of [['1', 'other', 'unavailable'], ['2', 'confirm', 'queued'], ['3', 'cancel', 'unavailable']]) {
      const response = read(gemini)
      gemini.send(JSON.stringify({ toolCall: { functionCalls: [{ id, name: 'propose_decision', args: { action } }] } }))
      assert.equal((await response).toolResponse.functionResponses[0].response.status, status)
    }
    assert.deepEqual(proposed, ['confirm'])
    const replay = new WebSocket(address, options)
    assert.match((await once(replay, 'error'))[0].message, /403/)
    const closed = once(telnyx, 'close')
    stopTelnyxVoice(call.attempt_id)
    await closed
    assert.equal(fallback, 0)
  } finally {
    telnyx?.terminate()
    stop()
    for (const peer of model.clients) peer.terminate()
    model.close()
    server.close()
    mock.restoreAll()
  }
})

test('WhatsApp gateway adapter pipes PCM into the same voice session and closes on hangup', { timeout: 10000 }, async () => {
  orderTestStore()
  process.env.WHATSAPP_VOICE_TOKEN = 'synthetic-whatsapp-token'.padEnd(32, 'x')
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(String(url), 'http://127.0.0.1:8795/status')
    return Response.json({ state: 'ready' })
  })
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const model = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await Promise.all([once(gateway, 'listening'), once(model, 'listening')])
  mock.method(whatsAppVoiceTransport, 'connect', (phone: string) => new WebSocket(`ws://127.0.0.1:${(gateway.address() as { port: number }).port}`, { headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_VOICE_TOKEN, 'X-Call-Destination': phone } }))
  mock.method(voiceTransport, 'connect', () => new WebSocket(`ws://127.0.0.1:${(model.address() as { port: number }).port}`))
  const states: string[] = []
  const decisions: string[] = []
  const report = async (next: string) => { states.push(next) }
  const parse = async (socket: WebSocket) => JSON.parse(String((await once(socket, 'message'))[0]))
  try {
    const connected = once(gateway, 'connection')
    await startWhatsAppVoice({ attempt_id: 'wa-test', phone: '+12025550128', reference: 'ORDER-1', item: 'Notebook', amount: '5.00', currency: 'USD', language: 'en', channel: 'whatsapp' }, async action => { decisions.push(action); return true }, report)
    const [peer, handshake] = await connected
    assert.equal(handshake.headers['x-call-destination'], '+12025550128')
    const modelConnected = once(model, 'connection')
    peer.send(JSON.stringify({ event: 'ringing' }))
    peer.send(JSON.stringify({ event: 'answered' }))
    const [gemini] = await modelConnected as [WebSocket]
    const setup = (await parse(gemini)).setup
    assert.match(setup.systemInstruction.parts[0].text, /Start in English/)
    assert.match(setup.systemInstruction.parts[0].text, /completes the order IN THIS CALL/)
    assert.equal(setup.tools[0].functionDeclarations[0].name, 'decide_order')
    const greeting = parse(gemini)
    gemini.send(JSON.stringify({ setupComplete: {} }))
    await greeting
    const frame = Buffer.alloc(1920, 1)
    const input = parse(gemini)
    peer.send(frame)
    assert.deepEqual(Buffer.from((await input).realtimeInput.audio.data, 'base64'), frame)
    function collectAudio(length: number) {
      const chunks: Buffer[] = []
      let bytes = 0, maxAhead = 0
      const started = Date.now()
      return new Promise<{ audio: Buffer; maxAhead: number; elapsed: number }>(resolve => {
        const receive = (data: Buffer, binary: boolean) => {
          if (!binary) return
          chunks.push(Buffer.from(data)); bytes += data.length
          maxAhead = Math.max(maxAhead, bytes - Math.floor((Date.now() - started) / 60) * 1920)
          if (bytes >= length) { peer.off('message', receive); resolve({ audio: Buffer.concat(chunks), maxAhead, elapsed: Date.now() - started }) }
        }
        peer.on('message', receive)
      })
    }
    const output = collectAudio(1920)
    gemini.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(2880, 2).toString('base64') } }] } } }))
    assert.deepEqual((await output).audio, Buffer.alloc(1920, 2))
    const spokenTurn = collectAudio(96000)
    for (let i = 0; i < 150; i++) {
      gemini.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(960, 4).toString('base64') } }] } } }))
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const played = await spokenTurn
    assert.deepEqual(played.audio, Buffer.alloc(96000, 4))
    assert.ok(played.maxAhead <= 7680, 'small model chunks bypassed pacing and accumulated excessive audio ahead of playback')
    assert.ok(played.elapsed >= 2800, 'three seconds of speech was sent faster than playback')
    const nextFrame = once(peer, 'message')
    gemini.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(144000, 6).toString('base64') } }] } } }))
    await nextFrame
    const clear = new Promise<void>(resolve => {
      const receive = (data: Buffer, binary: boolean) => { if (!binary && JSON.parse(data.toString()).event === 'clear') { peer.off('message', receive); resolve() } }
      peer.on('message', receive)
    })
    gemini.send(JSON.stringify({ serverContent: { interrupted: true } }))
    await clear
    let staleAudio = false
    const stale = (_data: Buffer, binary: boolean) => { if (binary) staleAudio = true }
    peer.on('message', stale)
    await new Promise(resolve => setTimeout(resolve, 100))
    peer.off('message', stale)
    assert.equal(staleAudio, false, 'old speech continued after the customer interrupted')
    for (const [id, action, status] of [['bad', 'unknown', 'unavailable'], ['saved', 'confirm', 'confirmed'], ['duplicate', 'cancel', 'unavailable']]) {
      const response = parse(gemini)
      gemini.send(JSON.stringify({ toolCall: { functionCalls: [{ id, name: 'decide_order', args: { action } }] } }))
      assert.equal((await response).toolResponse.functionResponses[0].response.status, status)
    }
    assert.deepEqual(decisions, ['confirm'])
    const closed = once(gemini, 'close')
    peer.send(JSON.stringify({ event: 'ended' }))
    await closed
    assert.deepEqual(states, ['ringing', 'answered', 'ended'])
  } finally {
    stopWhatsAppVoiceCalls()
    for (const server of [gateway, model]) {
      for (const peer of server.clients) peer.terminate()
      server.close()
    }
    mock.restoreAll()
  }
})

test('a rejection before WhatsApp media connects is reported for review without starting Gemini', { timeout: 10000 }, async () => {
  orderTestStore()
  process.env.WHATSAPP_VOICE_TOKEN = 'rejection-test-token'.padEnd(32, 'x')
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(gateway, 'listening')
  let modelStarts = 0
  mock.method(globalThis, 'fetch', async () => Response.json({ state: 'ready' }))
  mock.method(voiceTransport, 'connect', () => { modelStarts++; throw new Error('Gemini must not start before media is ready.') })
  mock.method(whatsAppVoiceTransport, 'connect', () => new WebSocket(`ws://127.0.0.1:${(gateway.address() as { port: number }).port}`))
  let reported!: (result: { state: string; reason?: string }) => void
  const result = new Promise<{ state: string; reason?: string }>(resolve => { reported = resolve })
  try {
    const connected = once(gateway, 'connection')
    await startWhatsAppVoice({ attempt_id: 'rejected-test', phone: '+12025550128', reference: 'ORDER-1', item: 'Notebook', amount: '5.00', currency: 'USD', language: 'en', channel: 'whatsapp' }, async () => false, async (state, reason) => { if (state === 'review') reported({ state, reason }) })
    const [peer] = await connected as [WebSocket]
    peer.send(JSON.stringify({ event: 'ended', reason: 'rejected' }))
    const outcome = await result
    assert.equal(outcome.state, 'review')
    assert.match(outcome.reason || '', /before audio connected/)
    assert.equal(modelStarts, 0)
  } finally {
    stopWhatsAppVoiceCalls()
    for (const peer of gateway.clients) peer.terminate()
    gateway.close()
    mock.restoreAll()
  }
})

test('personal WhatsApp call authenticates one-use tickets, enforces origin and bridges PCM without a model', { timeout: 10000 }, async () => {
  const fixture = orderTestStore()
  fixture.reset({ users: [{ id: 1, role: 'admin' }, { id: 2, role: 'user' }], sessions: [
    { token: 'manual-admin', user_id: 1, expires_at: '2099-01-01T00:00:00Z' },
    { token: 'manual-user', user_id: 2, expires_at: '2099-01-01T00:00:00Z' },
  ] })
  process.env.WHATSAPP_VOICE_TOKEN = 'synthetic-whatsapp-token'.padEnd(32, 'x')
  mock.method(globalThis, 'fetch', async () => Response.json({ state: 'ready' }))
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const server = createServer()
  const close = attachManualWhatsAppCalls(server)
  server.listen(0, '127.0.0.1')
  await Promise.all([once(server, 'listening'), once(gateway, 'listening')])
  const port = (server.address() as { port: number }).port
  let connections = 0
  mock.method(whatsAppVoiceTransport, 'connect', (phone: string, manual?: boolean) => {
    assert.equal(phone, '123456789012345@lid'); assert.equal(manual, true); connections++
    return new WebSocket(`ws://127.0.0.1:${(gateway.address() as { port: number }).port}`)
  })
  let browser: WebSocket | undefined
  const reject = async (path: string, cookie: string, origin: string) => {
    const peer = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Cookie: cookie, Origin: origin } })
    peer.on('error', () => {})
    const [, response] = await once(peer, 'unexpected-response')
    assert.equal(response.statusCode, 403)
    response.destroy(); peer.terminate()
  }
  try {
    const { path } = await manualWhatsAppCallTicket(1, '123456789012345@lid')
    const origin = `http://127.0.0.1:${port}`
    await reject(path, '', origin)
    await reject(path, 'desk_session=manual-user', origin)
    await reject(path, 'desk_session=manual-admin', 'https://untrusted.example')
    const connected = once(gateway, 'connection')
    browser = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Cookie: 'desk_session=manual-admin', Origin: origin } })
    await once(browser, 'open')
    const [peer] = await connected as [WebSocket]
    const answered = once(browser, 'message')
    peer.send(JSON.stringify({ event: 'answered' }))
    assert.equal(JSON.parse(String((await answered)[0])).event, 'answered')
    const input = once(peer, 'message')
    browser.send(Buffer.alloc(640, 1))
    assert.deepEqual((await input)[0], Buffer.alloc(640, 1))
    const output = once(browser, 'message')
    peer.send(Buffer.alloc(640, 2))
    assert.deepEqual((await output)[0], Buffer.alloc(640, 2))
    const ended = once(peer, 'close')
    browser.close(); await ended
    await reject(path, 'desk_session=manual-admin', origin)
    assert.equal(connections, 1)
  } finally {
    browser?.terminate(); stopWhatsAppVoiceCalls(); close()
    for (const peer of gateway.clients) peer.terminate()
    gateway.close(); server.close(); mock.restoreAll()
  }
})
