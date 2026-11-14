import WebSocket from 'ws'
import { z } from 'zod'
import { openVoice } from './voice.ts'
import { getSetting } from './db.ts'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { TLSSocket } from 'node:tls'
import { WebSocketServer } from 'ws'
import { readSession, userFromToken } from './auth.ts'

const origin = 'http://127.0.0.1:8795'
const headers = () => ({ Authorization: 'Bearer ' + process.env.WHATSAPP_VOICE_TOKEN?.trim() })
export const whatsAppVoiceConfigured = () => (process.env.WHATSAPP_VOICE_TOKEN?.trim().length ?? 0) >= 32
export const whatsAppVoiceTransport = {
  connect(phone: string, manual = false, attempt?: string) {
    return new WebSocket(origin.replace('http:', 'ws:') + '/call', { headers: { ...headers(), 'X-Call-Destination': phone, ...(manual ? { 'X-Call-Mode': 'manual' } : {}), ...(attempt ? { 'X-Call-Attempt': attempt } : {}) }, handshakeTimeout: 5000, maxPayload: 16000 })
  },
}
const statusSchema = z.object({ state: z.enum(['connecting', 'qr', 'ready', 'disconnected', 'logged_out']), qr: z.string().max(2048).optional() })

export async function whatsAppVoiceStatus() {
  if (await getSetting('wa_connection_paused') === 'true') return { state: 'off', enabled: false, qrDataUrl: null }
  if (!whatsAppVoiceConfigured()) return { state: 'disabled', enabled: false, qrDataUrl: null }
  try {
    const response = await fetch(origin + '/status', { headers: headers(), signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error()
    const status = statusSchema.parse(await response.json())
    return { state: status.state, enabled: status.state === 'ready', qrDataUrl: null }
  } catch { return { state: 'unavailable', enabled: false, qrDataUrl: null } }
}

export async function setWhatsAppVoiceEnabled(_enabled: boolean) {
  throw Object.assign(new Error('WhatsApp text and calls share one connection. Use Connect or Disconnect on the WhatsApp page.'), { statusCode: 409 })
}

const active = new Map<string, () => void>()
const tickets = new Map<string, { userId: number; phone: string; expiry: number }>()

export async function manualWhatsAppCallTicket(userId: number, phone: string) {
  if ((await whatsAppVoiceStatus()).state !== 'ready') throw Object.assign(new Error('Connect WhatsApp before calling.'), { statusCode: 409 })
  if (active.size) throw Object.assign(new Error('The WhatsApp voice device is already in a call.'), { statusCode: 409 })
  for (const [key, ticket] of tickets) if (ticket.userId === userId || ticket.expiry < Date.now()) tickets.delete(key)
  const path = '/api/whatsapp/call/' + randomBytes(24).toString('hex')
  tickets.set(path, { userId, phone, expiry: Date.now() + 15000 })
  return { path }
}

export function attachManualWhatsAppCalls(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64000 })
  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/api/whatsapp/call/')) return
    const fail = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    void (async () => {
      const ticket = tickets.get(request.url!)
      const expectedOrigin = `${request.socket instanceof TLSSocket ? 'https' : 'http'}://${request.headers.host}`
      if (request.headers.origin !== expectedOrigin || !ticket || ticket.expiry < Date.now()) { fail(); return }
      const user = await userFromToken(readSession(request.headers.cookie))
      if (user?.role !== 'admin' || user.id !== ticket.userId || active.size || (await whatsAppVoiceStatus()).state !== 'ready' || tickets.get(request.url!) !== ticket) { fail(); return }
      tickets.delete(request.url!)
      sockets.handleUpgrade(request, socket, head, browser => {
        let gateway: WebSocket
        try { gateway = whatsAppVoiceTransport.connect(ticket.phone, true) }
        catch { browser.close(1011, 'The voice gateway is unavailable.'); return }
        let answered = false, closed = false
        const close = () => {
          if (closed) return
          closed = true
          active.delete(request.url!)
          clearTimeout(deadline)
          clearInterval(heartbeat)
          gateway.terminate()
          browser.close()
        }
        const deadline = setTimeout(close, 60 * 60 * 1000)
        deadline.unref()
        let alive = true
        const heartbeat = setInterval(() => {
          if (!alive) { close(); return }
          alive = false; browser.ping()
        }, 15000)
        heartbeat.unref()
        browser.on('pong', () => { alive = true })
        active.set(request.url!, close)
        browser.on('close', close); browser.on('error', close)
        gateway.on('close', close); gateway.on('error', close)
        browser.on('message', (raw, binary) => {
          if (!binary || !Buffer.isBuffer(raw) || raw.length > 64000 || raw.length % 2) { close(); return }
          if (!answered) return
          if (gateway.readyState !== WebSocket.OPEN || gateway.bufferedAmount > 64000) { close(); return }
          gateway.send(raw, { binary: true })
        })
        gateway.on('message', (raw, binary) => {
          if (browser.readyState !== WebSocket.OPEN || browser.bufferedAmount > 64000) { close(); return }
          if (binary) { if (answered) browser.send(raw, { binary: true }); return }
          try {
            const event = z.enum(['ringing', 'answered', 'ended', 'error']).parse(JSON.parse(raw.toString()).event)
            if (event === 'answered') answered = true
            browser.send(JSON.stringify({ event }))
          } catch { close() }
        })
      })
    })().catch(fail)
  })
  return () => { tickets.clear(); for (const peer of sockets.clients) peer.terminate(); sockets.close() }
}

export function stopWhatsAppVoice(id: string | null) { if (id) active.get(id)?.() }
export function stopWhatsAppVoiceCalls() { tickets.clear(); for (const close of active.values()) close() }

export async function startWhatsAppVoice(order: Parameters<typeof openVoice>[0] & { phone: string; attempt_id: string | null }, propose: Parameters<typeof openVoice>[2], status: (next: 'ringing' | 'answered' | 'ended' | 'review', reason?: string) => Promise<void>) {
  const id = order.attempt_id
  if (!id || !whatsAppVoiceConfigured() || (await whatsAppVoiceStatus()).state !== 'ready' || active.size) throw new Error('WhatsApp calling is unavailable or busy.')
  const peer = whatsAppVoiceTransport.connect(order.phone, false, id)
  let voice: ReturnType<typeof openVoice> | undefined, finished = false
  let opened = false, answered = false
  let playback = Buffer.alloc(0)
  let playbackTimer: NodeJS.Timeout | undefined
  let nextFrameAt = 0
  const timer = setTimeout(() => finish('ended'), 90000)
  timer.unref()
  const report = (next: Parameters<typeof status>[0], reason?: string) => { void status(next, reason).catch(() => console.error('WhatsApp call status could not be saved.')) }
  function clearPlayback() {
    playback = Buffer.alloc(0)
    if (playbackTimer) clearInterval(playbackTimer)
    playbackTimer = undefined
    nextFrameAt = 0
  }
  function pumpPlayback() {
    if (finished) { clearPlayback(); return }
    if (!playback.length) { if (nextFrameAt <= performance.now()) clearPlayback(); return }
    if (peer.bufferedAmount > 64000) { finish('review', 'WhatsApp audio connection stalled while playing speech.'); return }
    const now = performance.now()
    if (!nextFrameAt || now - nextFrameAt > 180) nextFrameAt = now
    // Match the codec's 60 ms frames, keeping only 120 ms ahead to absorb timer jitter.
    while (playback.length && nextFrameAt <= now + 120) {
      const frame = playback.subarray(0, 1920)
      playback = playback.subarray(frame.length)
      nextFrameAt += frame.length / 32
      peer.send(frame, { binary: true }, error => { if (error) finish('review', 'WhatsApp audio frame could not be sent.') })
    }
  }
  function finish(next?: 'ended' | 'review', reason?: string) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearPlayback()
    active.delete(id!)
    voice?.close()
    peer.terminate()
    if (opened && next) report(next, reason)
  }
  active.set(id, () => finish('ended'))
  return new Promise<void>((resolve, reject) => {
    peer.on('open', () => { opened = true; resolve() })
    peer.on('close', () => {
      if (!opened) reject(new Error('The WhatsApp call gateway is not ready.'))
      finish('review', 'WhatsApp audio gateway connection closed unexpectedly.')
    })
    peer.on('error', () => finish('review', 'WhatsApp audio gateway connection failed.'))
    peer.on('message', (raw, binary) => {
      try {
        if (binary) {
          if (Buffer.isBuffer(raw)) voice?.input(raw)
          return
        }
        const control = z.object({ event: z.enum(['ringing', 'answered', 'ended', 'error']), reason: z.string().max(300).optional() }).parse(JSON.parse(raw.toString()))
        const event = control.event
        if (event === 'ringing' && !answered) report('ringing')
        else if (event === 'answered' && !answered) {
          answered = true
          report('answered')
          voice = openVoice({ ...order, call_mode: 'whatsapp' }, {
            play(audio) {
              if (finished) return
              if (playback.length + audio.length > 16000 * 2 * 30) { finish('review', 'Voice assistant produced more than 30 seconds of queued speech.'); return }
              playback = Buffer.concat([playback, audio])
              if (!playbackTimer) { playbackTimer = setInterval(pumpPlayback, 20); playbackTimer.unref(); pumpPlayback() }
            },
            clear() { clearPlayback(); if (!finished) peer.send(JSON.stringify({ event: 'clear' })) },
            fail: reason => finish('review', reason),
          }, propose)
        } else if (event === 'ended' || event === 'error') {
          const beforeAudio = event === 'ended' && !answered && control.reason === 'rejected'
          finish(event === 'error' || beforeAudio ? 'review' : 'ended', beforeAudio ? 'WhatsApp returned a rejection before audio connected. No voice-assistant session started; review call signaling before retrying.' : control.reason)
        }
      } catch { finish('review', 'Invalid WhatsApp audio gateway event.') }
    })
  })
}
