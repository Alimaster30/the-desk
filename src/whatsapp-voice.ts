import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv } from './server/env.ts'

const environment = { ...process.env }
loadEnv()
if ((process.env.WHATSAPP_VOICE_TOKEN?.trim().length || 0) < 32) throw new Error('Set WHATSAPP_VOICE_TOKEN in .env before starting the gateway.')
const dir = resolve('data/whatsapp-voice')
const binary = resolve(dir, process.platform === 'win32' ? 'gateway.exe' : 'gateway')
if (!existsSync(binary)) throw new Error('Build the gateway first (see VOICE-AGENT.md).')
const child = spawn(binary, [], { stdio: 'inherit', env: { ...environment, WHATSAPP_VOICE_TOKEN: process.env.WHATSAPP_VOICE_TOKEN } })
process.on('SIGTERM', () => child.kill())
child.on('error', () => { console.error('Could not start the WhatsApp voice gateway.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 0 })
