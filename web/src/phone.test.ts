import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { phoneRuntime, placeCall, resetPhone, setCallHold } from './phone.ts'
import { confirmWhatsAppSend } from './send-response.ts'

test('manual sends require explicit acknowledgement and report empty or non-JSON responses without JSON parser errors', async () => {
  await confirmWhatsAppSend(Response.json({ ok: true }))
  await assert.rejects(confirmWhatsAppSend(new Response('', { status: 200 })), /no send confirmation/)
  await assert.rejects(confirmWhatsAppSend(new Response('', { status: 500 })), /no send confirmation/)
  await assert.rejects(confirmWhatsAppSend(new Response('<html>Proxy failure</html>', { status: 502 })), /no send confirmation/)
  await assert.rejects(confirmWhatsAppSend(new Response('', { status: 413 })), /too large/)
  await assert.rejects(confirmWhatsAppSend(Response.json({ error: 'Reconnect WhatsApp.' }, { status: 409 })), /Reconnect WhatsApp/)
  await assert.rejects(confirmWhatsAppSend(Response.json({})), /no send confirmation/)
})

test('WhatsApp microphone worklet sends complete 20ms little-endian PCM frames across input blocks', () => {
  let Processor: any
  const frames: ArrayBuffer[] = []
  class AudioWorkletProcessor { port = { postMessage: (buffer: ArrayBuffer) => frames.push(buffer) } }
  runInNewContext(readFileSync(new URL('../public/whatsapp-pcm.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor, registerProcessor: (_name: string, value: unknown) => { Processor = value },
  })
  const processor = new Processor()
  processor.process([[Float32Array.from([1, -1, 0])]])
  assert.equal(frames.length, 0)
  processor.process([[new Float32Array(317)]])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].byteLength, 640)
  assert.equal(new DataView(frames[0]).getInt16(0, true), 32767)
  assert.equal(new DataView(frames[0]).getInt16(2, true), -32767)
  assert.equal(new DataView(frames[0]).getInt16(4, true), 0)
})

test('hold and resume preserve the SDK receiver and surface a rejected action', async () => {
  const call = {
    hold: async function () { assert.equal(this, call); return true },
    unhold: async function () { assert.equal(this, call); return false },
  }
  await setCallHold(call, true)
  await assert.rejects(setCallHold(call, false), /Could not resume/)
})

test('sign-out records the end, disconnects RTC, ignores stale events and requests a fresh login', async context => {
  const oldWindow = globalThis.window
  globalThis.window = { setTimeout, clearTimeout } as unknown as Window & typeof globalThis
  let tokens = 0, hangups = 0, disconnects = 0
  const records: { clientCallId: string; status: string }[] = []
  const clients: Map<string, (value: unknown) => void>[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (url === '/api/telephony/token') { tokens++; return Response.json({ token: `fake-token-${tokens}`, callerNumber: '+12025550100' }) }
    assert.equal(url, '/api/calls/sync')
    records.push(JSON.parse(String(init.body)))
    return Response.json({ ok: true })
  })
  context.mock.method(phoneRuntime, 'create', async () => {
    const events = new Map<string, (value: unknown) => void>()
    clients.push(events)
    return { remoteElement: '', connect: () => events.get('telnyx.ready')?.({}), disconnect: () => { disconnects++ }, on: (name: string, handler: (value: unknown) => void) => { events.set(name, handler) }, newCall: () => ({ id: `test-call-${clients.length}`, state: 'active', hangup: () => { hangups++ } }) }
  })
  try {
    await placeCall('+12025550123')
    await resetPhone()
    assert.equal(hangups, 1)
    assert.equal(disconnects, 1)
    assert.deepEqual(records.map(row => row.status), ['hangup'])
    clients[0].get('telnyx.notification')?.({ type: 'callUpdate', call: { id: 'old-call', state: 'active' } })
    await setImmediate()
    assert.equal(records.length, 1)
    await placeCall('+12025550124')
    assert.equal(tokens, 2)
  } finally { await resetPhone(); globalThis.window = oldWindow }
})

test('signing out during SDK loading cancels the pending call before it can dial', async context => {
  let release!: () => void
  let dials = 0, disconnects = 0
  context.mock.method(globalThis, 'fetch', async () => Response.json({ token: 'fake-pending-token', callerNumber: '+12025550100' }))
  context.mock.method(phoneRuntime, 'create', async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { remoteElement: '', connect: () => {}, disconnect: () => { disconnects++ }, on: () => {}, newCall: () => { dials++; return {} } }
  })
  const pending = placeCall('+12025550123')
  await setImmediate()
  await resetPhone()
  release()
  await assert.rejects(pending, /cancelled/)
  assert.equal(dials, 0)
  assert.equal(disconnects, 1)
})
