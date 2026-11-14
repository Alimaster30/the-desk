import { createServer, request as forward } from 'node:http'

// Expose the signed webhook only; the app and authenticated APIs stay local.
export function createWebhookRelay(appPort = 8787) {
  return createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/telnyx/webhook') {
      response.writeHead(404).end()
      return
    }
    let bytes = 0
    const chunks: Buffer[] = []
    request.on('data', chunk => {
      if (response.writableEnded) return
      bytes += chunk.length
      if (bytes > 1024 * 1024) response.writeHead(413).end()
      else chunks.push(Buffer.from(chunk))
    })
    request.on('error', () => { if (!response.writableEnded) response.writeHead(400).end() })
    request.on('end', () => {
      if (response.writableEnded) return
      const upstream = forward({ hostname: '127.0.0.1', port: appPort, path: '/api/telnyx/webhook', method: 'POST', timeout: 10000,
        headers: { 'content-type': 'application/json',
          ...(request.headers['telnyx-timestamp'] ? { 'telnyx-timestamp': request.headers['telnyx-timestamp'] } : {}),
          ...(request.headers['telnyx-signature-ed25519'] ? { 'telnyx-signature-ed25519': request.headers['telnyx-signature-ed25519'] } : {}),
        },
      }, result => { response.writeHead(result.statusCode || 502, { 'content-type': 'application/json' }); result.pipe(response) })
      upstream.on('timeout', () => upstream.destroy())
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); if (!response.writableEnded) response.end() })
      response.on('close', () => upstream.destroy())
      upstream.end(Buffer.concat(chunks))
    })
  })
}
