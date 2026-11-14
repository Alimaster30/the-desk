import { geminiText } from './gemini.ts'
import { pairReplies } from './logic.ts'
import {
  getSetting,
  listReplyRows,
  recentChat,
  setSetting,
} from './db.ts'

const MIN_EXAMPLES = 3
let learning = false

const autoRepliesPaused = () => process.env.WHATSAPP_AUTO_REPLY_PAUSED === 'true'

export async function replyState() {
  const examples = pairReplies(await listReplyRows())
  const pattern = await getSetting('reply_pattern') || ''
  return {
    enabled: !autoRepliesPaused() && await getSetting('auto_reply') !== '0',
    paused: autoRepliesPaused(),
    pattern,
    exampleCount: examples.length,
    ready: examples.length >= MIN_EXAMPLES && Boolean(pattern),
    updatedAt: await getSetting('pattern_updated_at'),
  }
}

export async function setAutoReply(enabled: boolean) {
  if (autoRepliesPaused()) throw Object.assign(new Error('Automatic replies are paused for this server run.'), { statusCode: 409 })
  await setSetting('auto_reply', enabled ? '1' : '0')
  return replyState()
}

export async function learnReplyPattern() {
  if (learning) return
  learning = true
  try {
    const pairs = pairReplies(await listReplyRows())
    await setSetting('pattern_example_count', String(pairs.length))
    if (!pairs.length) return
    const pattern = await geminiText(
      'Describe how this person replies on WhatsApp so another writer can imitate them. Cover language, length, tone, greetings, and what they avoid. Use only the examples. Plain sentences. Do not write a sample reply.',
      pairs.map((pair, index) => `${index + 1}. Them: ${pair.them}\nUs: ${pair.us}`).join('\n\n'),
    )
    await setSetting('reply_pattern', pattern)
    await setSetting('pattern_updated_at', new Date().toISOString())
  } finally {
    learning = false
  }
}

export async function draftReply(jid: string, inbound: string): Promise<string | null> {
  if (autoRepliesPaused() || await getSetting('auto_reply') === '0') return null
  const pairs = pairReplies(await listReplyRows()).slice(-8)
  const pattern = await getSetting('reply_pattern')
  const style = pattern
    ? `Pattern learned from their real replies:\n${pattern}`
    : pairs.length
      ? `Imitate only these real replies:\n${pairs.map((pair, index) => `${index + 1}. Them: ${pair.them}\nUs: ${pair.us}`).join('\n\n')}`
      : 'No real replies have been seen yet. Answer in the same language as the incoming text, in one or two short lines, the way a person texts.'
  const recent = await recentChat(jid, 12)
  const reply = await geminiText(
    'You send WhatsApp replies as this person. Follow the style notes. Return only the reply text, with no quotes.',
    `${style}\n\nRecent chat:\n${recent.map((message) => `${message.fromMe ? 'Us' : 'Them'}: ${message.body}`).join('\n')}\n\nReply to:\n${inbound}`,
  )
  const cleaned = reply.trim().replace(/^["']|["']$/g, '')
  if (!cleaned || cleaned.toUpperCase() === 'SKIP') return null
  return cleaned.slice(0, 1000)
}
