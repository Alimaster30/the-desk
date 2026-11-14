import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createWebhookRelay } from './webhook-relay.ts'

test('the public relay forwards exact webhook bytes and signatures while blocking other routes and methods', async () => {
  const received: { body: string; timestamp?: string | string[]; signature?: string | string[] }[] = []
  const app = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push({ body: Buffer.concat(chunks).toString(), timestamp: request.headers['telnyx-timestamp'], signature: request.headers['telnyx-signature-ed25519'] })
    response.writeHead(request.headers['telnyx-signature-ed25519'] ? 200 : 401, { 'content-type': 'application/json' }).end('{}')
  })
  app.listen(0, '127.0.0.1'); await once(app, 'listening')
  const relay = createWebhookRelay((app.address() as { port: number }).port)
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening')
  const origin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`
  try {
    for (const path of ['/', '/api/auth/me', '/api/sms/conversations', '/api/telnyx/webhook?other=1']) assert.equal((await fetch(origin + path, { method: 'POST' })).status, 404)
    assert.equal((await fetch(origin + '/api/telnyx/webhook')).status, 404)
    assert.equal((await fetch(origin + '/api/telnyx/webhook', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413)
    assert.equal(received.length, 0)
    const body = '{ "data": {"text":"hello اردو"} }'
    assert.equal((await fetch(origin + '/api/telnyx/webhook', { method: 'POST', body, headers: { 'telnyx-timestamp': '123', 'telnyx-signature-ed25519': 'signature' } })).status, 200)
    assert.deepEqual(received[0], { body, timestamp: '123', signature: 'signature' })
    assert.equal((await fetch(origin + '/api/telnyx/webhook', { method: 'POST', body })).status, 401)
  } finally {
    await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()))
  }
})
