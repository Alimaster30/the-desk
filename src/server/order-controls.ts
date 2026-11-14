import { getSetting, setSetting } from './db.ts'

type Controls = { enabled: boolean; text: boolean; voice: boolean }
const setting = 'order_automation_controls'
let updates = Promise.resolve()

function apply(controls: Controls) {
  process.env.ORDER_AUTOMATION_ENABLED = String(controls.enabled)
  process.env.TEXT_AGENT_ENABLED = String(controls.text)
  process.env.VOICE_AGENT_ENABLED = String(controls.voice)
}

export async function restoreOrderControls() {
  const saved = await getSetting(setting)
  if (!saved) return
  const controls = JSON.parse(saved) as Controls
  if (typeof controls.enabled !== 'boolean' || typeof controls.text !== 'boolean' || typeof controls.voice !== 'boolean') throw new Error('Invalid saved order automation settings.')
  apply(controls)
}

export function updateOrderControls(input: Record<string, unknown>) {
  const update = updates.then(() => saveOrderControls(input))
  updates = update.catch(() => undefined)
  return update
}

async function saveOrderControls(input: Record<string, unknown>) {
  const keys = Object.keys(input)
  if (keys.length !== 1 || !['enabled', 'text', 'voice'].includes(keys[0]) || typeof input[keys[0]] !== 'boolean') {
    throw Object.assign(new Error('Choose one automation switch and a boolean value.'), { statusCode: 400 })
  }
  const controls: Controls = {
    enabled: process.env.ORDER_AUTOMATION_ENABLED === 'true',
    text: process.env.TEXT_AGENT_ENABLED === 'true',
    voice: process.env.VOICE_AGENT_ENABLED === 'true',
  }
  const key = keys[0] as keyof Controls
  if (key !== 'enabled' && !controls.enabled) throw Object.assign(new Error('Turn on Live actions before changing assistant settings.'), { statusCode: 409 })
  if (key !== 'enabled' && input[key] && !process.env.GEMINI_API_KEY?.trim()) throw Object.assign(new Error('Configure the Gemini API key before enabling an assistant.'), { statusCode: 409 })
  controls[key] = input[key] as boolean
  await setSetting(setting, JSON.stringify(controls))
  apply(controls)
}
