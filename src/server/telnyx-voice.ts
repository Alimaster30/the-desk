import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { checkWebhook, telnyx } from './telnyx.ts'
import { openVoice, voiceEnabled } from './voice.ts'

type Call = Parameters<typeof openVoice>[0] & { call_control_id: string | null; attempt_id: string | null }
const streams = new Map<string, {
  path: string; url: string; accept: (peer: WebSocket) => void; close: () => void
}>()

export async function startTelnyxVoice(call: Call, origin: string, commandId: string, propose: Parameters<typeof openVoice>[2], fallback: () => void) {
  const id = call.attempt_id, control = call.call_control_id
  if (!id || !control || streams.has(id) || streams.size >= 4) throw new Error('Voice stream unavailable.')
  const path = '/api/voice/media/' + randomBytes(24).toString('hex')
  const url = origin.replace(/^https:/, 'wss:') + path
  let peer: WebSocket | undefined, voice: ReturnType<typeof openVoice> | undefined, finished = false
  let pending = Buffer.alloc(0), sequence = 0
  const deadline = setTimeout(fail, 12000)
  const safety = setTimeout(close, 95000)
  deadline.unref(); safety.unref()
  function send(payload: unknown) {
    if (peer?.readyState === WebSocket.OPEN && peer.bufferedAmount < 90000) peer.send(JSON.stringify(payload))
    else fail()
  }
  function close() {
    if (finished) return
    finished = true
    clearTimeout(deadline); clearTimeout(safety)
    streams.delete(id!)
    voice?.close()
    peer?.terminate()
  }
  function fail() {
    if (finished) return
    close()
    void telnyx(`/calls/${encodeURIComponent(control!)}/actions/streaming_stop`, { method: 'POST', timeoutMs: 4000 })
      .catch(() => undefined).finally(fallback)
  }
  streams.set(id, { path, url, close, accept(socket) {
    peer = socket
    socket.on('error', fail)
    socket.on('close', fail)
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString())
        if (message.event === 'start' && !voice) {
          const start = message.start
          if (start?.call_control_id !== control || start.media_format?.encoding !== 'L16' || start.media_format.sample_rate !== 16000 || start.media_format.channels !== 1) { fail(); return }
          clearTimeout(deadline)
          voice = openVoice(call, {
            play(pcm) {
              pending = Buffer.concat([pending, pcm])
              const length = pending.length - pending.length % 640
              // Telnyx normalizes L16 to little-endian on the WebSocket.
              for (let i = 0; i < length && !finished; i += 640) send({ event: 'media', media: { payload: pending.subarray(i, i + 640).toString('base64') } })
              pending = pending.subarray(length)
            },
            clear() { pending = Buffer.alloc(0); send({ event: 'clear' }) },
            fail,
          }, propose)
        } else if (message.event === 'media' && voice && message.media?.track === 'inbound') {
          const chunk = Number(message.media.chunk)
          const payload = message.media.payload
          if (!Number.isSafeInteger(chunk) || chunk <= sequence || typeof payload !== 'string') return
          const pcm = Buffer.from(payload, 'base64')
          if (!pcm.length || pcm.length > 16000 || pcm.length % 2) return
          sequence = chunk
          voice.input(pcm)
        } else if (message.event === 'stop') close()
      } catch { fail() }
    })
  } })
  try {
    await telnyx(`/calls/${encodeURIComponent(control)}/actions/streaming_start`, { method: 'POST', timeoutMs: 10000, body: {
      stream_url: url, stream_track: 'inbound_track', stream_codec: 'L16', stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: 'L16', stream_bidirectional_sampling_rate: 16000, stream_bidirectional_target_legs: 'self', command_id: commandId,
    } })
  } catch (error) { close(); throw error }
}

export function stopTelnyxVoice(attempt: string | null) { if (attempt) streams.get(attempt)?.close() }

export function attachTelnyxVoice(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 24000 })
  const used = new WeakSet<object>()
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/api/whatsapp/call/')) return
    const stream = [...streams.values()].find(candidate => candidate.path === request.url)
    const timestamp = request.headers['telnyx-timestamp'], signature = request.headers['telnyx-signature-ed25519']
    if (!voiceEnabled() || !process.env.TELNYX_PUBLIC_KEY?.trim() || !stream || used.has(stream) || typeof timestamp !== 'string' || typeof signature !== 'string' || !checkWebhook(stream.url, timestamp, signature)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    used.add(stream)
    sockets.handleUpgrade(request, socket, head, peer => stream.accept(peer))
  })
  return () => { for (const stream of streams.values()) stream.close(); sockets.close() }
}
