import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

let gateway: ChildProcess | null = null

export function startVoiceGateway() {
  if (gateway) return
  const binary = resolve('data/whatsapp-voice', process.platform === 'win32' ? 'gateway.exe' : 'gateway')
  if (!existsSync(binary)) throw new Error('Build the WhatsApp voice gateway first (see VOICE-AGENT.md).')
  if (!process.env.WHATSAPP_VOICE_TOKEN?.trim()) {
    const token = randomBytes(32).toString('hex')
    const env = existsSync('.env') ? readFileSync('.env', 'utf8') : ''
    const lines = env.split(/\r?\n/).filter(line => !/^\s*WHATSAPP_VOICE_TOKEN\s*=/.test(line))
    writeFileSync('.env', lines.join('\n').trimEnd() + '\nWHATSAPP_VOICE_TOKEN=' + token + '\n', { mode: 0o600 })
    process.env.WHATSAPP_VOICE_TOKEN = token
  }
  if (process.env.WHATSAPP_VOICE_TOKEN.trim().length < 32) throw new Error('WHATSAPP_VOICE_TOKEN must contain at least 32 characters.')
  const child = spawn(binary, [], { windowsHide: true, stdio: 'ignore', env: process.env })
  gateway = child
  child.once('error', () => { if (gateway === child) gateway = null })
  child.once('exit', () => { if (gateway === child) gateway = null })
}

export async function stopVoiceGateway() {
  const previous = gateway
  if (!previous) return
  await new Promise<void>(resolve => {
    previous.once('exit', () => resolve())
    previous.once('error', () => resolve())
    previous.kill()
  })
  if (gateway === previous) gateway = null
}
