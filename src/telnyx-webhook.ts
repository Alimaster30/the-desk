import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWebhookRelay } from './server/webhook-relay.ts'
import { telnyx } from './server/telnyx.ts'

const binary = resolve('.tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
if (!existsSync(binary)) throw new Error('Install the official cloudflared binary in .tools before starting the Telnyx development webhook.')
const number = process.env.TELNYX_SMS_PHONE_NUMBER?.trim() || process.env.TELNYX_PHONE_NUMBER?.trim()
if (!number) throw new Error('Configure a Telnyx sending number first.')
const sender = (await telnyx(`/messaging_phone_numbers/${encodeURIComponent(number)}`, { timeoutMs: 15000 })).data
if (!sender?.messaging_profile_id) throw new Error('Assign the sending number to a Telnyx messaging profile first.')
const relay = createWebhookRelay(Number(process.env.PORT || 8787))
await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(8788, '127.0.0.1', resolve) })
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8788', '--protocol', 'http2'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let logs = '', origin = '', registered = false, configuring = false
const deadline = setTimeout(() => { console.error('Telnyx webhook tunnel did not become ready within 90 seconds.'); stop(1) }, 90000)

async function configure() {
  if (!origin || !registered || configuring) return
  configuring = true
  const webhook = `${origin}/api/telnyx/webhook`
  try {
    await telnyx(`/messaging_profiles/${encodeURIComponent(sender.messaging_profile_id)}`, { method: 'PATCH', body: { webhook_url: webhook, webhook_api_version: '2' }, timeoutMs: 15000 })
    const verified = (await telnyx(`/messaging_profiles/${encodeURIComponent(sender.messaging_profile_id)}`, { timeoutMs: 15000 })).data
    if (verified.webhook_url !== webhook || verified.webhook_api_version !== '2') throw new Error('Telnyx did not retain the webhook configuration.')
    clearTimeout(deadline)
    console.log(`Telnyx inbound SMS and delivery receipts: ${webhook}`)
    console.log('Keep this process and the app running. Only the signed Telnyx webhook is forwarded. The development URL changes on restart.')
  } catch (error) { console.error(error instanceof Error ? error.message : 'Could not configure the Telnyx webhook.'); stop(1) }
}

tunnel.stderr!.on('data', chunk => {
  logs = (logs + chunk.toString()).slice(-16000)
  origin ||= logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] || ''
  registered ||= logs.includes('Registered tunnel connection')
  void configure()
})
tunnel.on('error', error => { console.error(error.message); stop(1) })
tunnel.on('exit', code => { if (code) console.error(logs.slice(-2000)); stop(code || 0) })
function stop(code: number) { clearTimeout(deadline); tunnel.kill(); relay.close(); process.exit(code) }
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
