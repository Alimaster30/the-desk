import { store, transaction } from './store.ts'
let version = 0
export const whatsAppSessionVersion = () => version

// WhatsApp Web-style logout clears this device's local cache, not messages on the phone.
export async function clearWhatsAppSession(paused = true) {
  version++
  await transaction(async session => {
    for (const name of ['wa_messages', 'wa_chats', 'wa_replies', 'wa_auth']) await store.collection(name).deleteMany({}, { session })
    for (const key of ['reply_pattern', 'pattern_updated_at', 'wa_account']) await store.collection('app_settings').deleteOne({ key }, { session })
    for (const [key, value] of Object.entries({ auto_reply: '0', pattern_example_count: '0', wa_voice_enabled: '0', wa_connection_paused: String(paused), wa_gateway_logout_required: String(paused) })) await store.collection('app_settings').updateOne({ key }, { $set: { value } }, { upsert: true, session })
    const queued = await store.collection('order_jobs').find({ status: 'pending' }, { session }).toArray()
    for (const job of queued) {
      const order = await store.collection('orders').findOne({ id: job.order_id }, { session })
      const channel = job.channel || order?.channel
      const callJob = ['dial', 'voice', 'menu', 'hangup'].includes(job.kind)
      if (callJob ? order?.call_mode === 'whatsapp' : channel === 'whatsapp') {
        await store.collection('order_jobs').updateOne({ key: job.key, status: 'pending' }, { $set: { status: 'skipped', error: 'WhatsApp account logged out. Review before sending from a new session.' } }, { session })
        if (callJob) await store.collection('orders').updateOne({ id: job.order_id }, { $set: { call_status: 'review', last_error: 'WhatsApp account logged out before the call action.' } }, { session })
      }
    }
  })
}
