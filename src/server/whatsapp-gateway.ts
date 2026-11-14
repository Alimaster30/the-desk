import { EventEmitter } from 'node:events'
import { startVoiceGateway, stopVoiceGateway } from './voice-gateway.ts'
import { getSetting, setSetting } from './db.ts'
import { mongoAuthState } from './wa-auth.ts'
import { clearWhatsAppSession } from './whatsapp-session.ts'

const origin = 'http://127.0.0.1:8795'
export async function gatewayRequest(path: string, body?: unknown, timeout = 5000) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_VOICE_TOKEN?.trim()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error((await response.text()).trim() || 'WhatsApp gateway request failed.')
  return response.json()
}

async function readyGateway() {
  try { return await gatewayRequest('/status', undefined, 1000) } catch { /* Start the gateway if it is not already managed separately. */ }
  startVoiceGateway()
  for (let attempt = 0; ; attempt++) {
    try { return await gatewayRequest('/status', undefined, 1000) }
    catch (error) { if (attempt >= 24) throw error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
}

export async function logoutSharedGateway() {
  await readyGateway()
  const result = await gatewayRequest('/logout', {}, 15000)
  await stopVoiceGateway()
  return result
}

export async function sharedWhatsAppSocket(fresh: boolean) {
  const initial = await readyGateway()
  if (fresh || await getSetting('wa_gateway_logout_required') === 'true') {
    await logoutSharedGateway()
    await setSetting('wa_gateway_logout_required', 'false')
    return sharedWhatsAppSocket(false)
  }
  if (initial.state === 'logged_out') throw new Error('Restart the manually managed WhatsApp gateway to generate a fresh QR code.')
  const ev = new EventEmitter()
  let stopped = false, cursor = 0, previous = '', timer: NodeJS.Timeout | undefined
  async function poll() {
    try {
      const state = await gatewayRequest('/status')
      if (stopped) return
      const signature = JSON.stringify([state.state, state.qr, state.owner])
      if (signature !== previous) {
        previous = signature
        if (state.owner) {
          const saved = await getSetting('wa_account')
          const previousOwner = saved ? JSON.parse(saved) : (await mongoAuthState()).state.creds.me
          const normalize = (id: string) => id.replace(/:\d+@/, '@')
          if (previousOwner?.id && normalize(previousOwner.id) !== normalize(state.owner.id)) await clearWhatsAppSession(false)
          await setSetting('wa_account', JSON.stringify(state.owner))
        }
        if (stopped) return
        if (state.state === 'ready') ev.emit('connection.update', { connection: 'open' })
        else if (state.state === 'qr' && state.qr) ev.emit('connection.update', { qr: state.qr })
        else if (state.state === 'logged_out') { stopped = true; ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }); return }
        else { stopped = true; ev.emit('connection.update', { connection: 'close', needsPairing: state.hasSession === false }); return }
      }
      if (state.state === 'ready') {
        const rows = await gatewayRequest(`/events?after=${cursor}`) as { id: number; event: { type: string; data: unknown } }[]
        for (const row of rows) {
          if (stopped) return
          ev.emit(row.event.type, row.event.data)
          cursor = row.id
        }
      }
    } catch {
      if (!stopped) { stopped = true; ev.emit('connection.update', { connection: 'close' }); return }
    }
    if (!stopped) timer = setTimeout(poll, 700)
  }
  timer = setTimeout(poll, 0)
  const sock = {
    shared: true,
    ev,
    end(_reason?: Error) { stopped = true; if (timer) clearTimeout(timer) },
    async logout() { const result = await gatewayRequest('/logout', {}, 15000); if (!result.ok) throw new Error('WhatsApp logout was not confirmed.'); return result },
    async sendMessage(jid: string, content: Record<string, any>) {
      if (stopped) throw new Error('WhatsApp session has ended.')
      const kind = content.image ? 'image' : content.sticker ? 'sticker' : content.document ? 'document' : undefined
      return gatewayRequest('/send', { jid, text: content.text || content.caption || '', ...(kind ? { attachment: { kind, name: content.fileName || 'attachment', mimetype: content.mimetype || (kind === 'sticker' ? 'image/webp' : 'application/octet-stream'), data: (content.image || content.sticker || content.document).toString('base64') } } : {}) }, 75000)
    },
    async profilePictureUrl(jid: string) { return (await gatewayRequest(`/avatar?jid=${encodeURIComponent(jid)}`)).url },
  }
  return { sock, saveCreds: async () => {} }
}
