import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ClientSession } from 'mongodb'
import { store, transaction } from './store.ts'
import { required } from './env.ts'
import { applyWebhook, telnyx } from './telnyx.ts'
import { upsertCall } from './db.ts'
import { ivrMenu, orderCommand, orderError, orderMessage, parseOrder, type OrderInput } from './order-logic.ts'
import { agentMessage, approvalReply, textAgent, textAgentEnabled, textAgentSetup, validateAgentPlan, type AgentInput, type AgentOrder, type AgentProposal, type CustomerDetails } from './text-agent.ts'
import { voiceEnabled, voiceModel } from './voice.ts'
import { startTelnyxVoice, stopTelnyxVoice } from './telnyx-voice.ts'
import { startWhatsAppVoice, stopWhatsAppVoice, whatsAppVoiceConfigured, whatsAppVoiceStatus } from './whatsapp-voice.ts'
import type { AuthUser } from './auth.ts'
import { recordSms } from './sms.ts'

type CallMode = 'ivr' | 'voice' | 'whatsapp'

export type Order = OrderInput & {
  id: string
  user_id: number
  status: 'pending' | 'confirmed' | 'cancelled'
  call_status: 'idle' | 'queued' | 'dialing' | 'ringing' | 'answered' | 'unanswered' | 'completed' | 'review'
  attempt_id: string | null
  call_control_id: string | null
  call_session_id: string | null
  call_requested_via: 'admin' | 'staff' | 'sms' | 'whatsapp' | null
  call_requested_at: string | null
  call_mode?: CallMode
  menu_count: number
  whatsapp_jid: string
  last_error: string | null
  call_end_reason?: string
  created_at: string
  updated_at: string
  customer?: CustomerDetails
  agent_proposal?: AgentProposal | null
  agent_intake?: { minute: number; count: number }
}

type Job = {
  key: string
  order_id: string
  kind: 'invite' | 'confirmed' | 'cancelled' | 'unanswered' | 'help' | 'dial' | 'menu' | 'voice' | 'hangup' | 'agent_input' | 'agent_reply'
  status: 'pending' | 'working' | 'done' | 'failed' | 'skipped'
  priority: number
  command_id: string
  available_at: string
  started_at?: string
  error?: string
  input?: AgentInput
  phone?: string
  text?: string
  channel?: AgentInput['channel']
  recipient?: string
  sent_at?: string
  provider_acknowledged?: boolean
}

const orders = () => store.collection<Order>('orders')
const jobs = () => store.collection<Job>('order_jobs')
export const orderAudioFile = (language: 'en' | 'ur') => resolve(process.env.ORDER_IVR_DIRECTORY || 'data/order-ivr', `${language}.wav`)
const enabled = () => process.env.ORDER_AUTOMATION_ENABLED === 'true'

function publicBase() {
  const url = new URL(required('PUBLIC_BASE_URL'))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw orderError('PUBLIC_BASE_URL must be a public HTTPS origin, without a path or credentials.')
  return url.origin
}

export function orderSetup() {
  const missing = ['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_PHONE_NUMBER', 'TELNYX_CALL_CONTROL_CONNECTION_ID', 'PUBLIC_BASE_URL'].filter(name => !process.env[name]?.trim())
  let configurationError = ''
  if (process.env.PUBLIC_BASE_URL) try { publicBase() } catch { configurationError = 'PUBLIC_BASE_URL must be a public HTTPS origin.' }
  return { enabled: enabled(), missing, configurationError, textAgent: textAgentSetup(), voice: { enabled: voiceEnabled(), ready: voiceReady(), model: voiceModel() }, audio: { en: existsSync(orderAudioFile('en')), ur: existsSync(orderAudioFile('ur')) }, menus: { en: ivrMenu('en'), ur: ivrMenu('ur') } }
}

const voiceReady = () => voiceEnabled() && Boolean(process.env.GEMINI_API_KEY?.trim())

function requireLive() {
  if (!enabled()) throw orderError('Live order actions are disabled. Ask an admin to turn on Live actions in Orders.', 409)
}

export async function createOrder(userId: number, input: Record<string, unknown>, start = false) {
  const fields = parseOrder(input), now = new Date().toISOString()
  if (start) requireLive()
  const row: Order = { ...fields, id: randomUUID(), user_id: userId, status: 'pending', call_status: 'idle', attempt_id: null, call_control_id: null, call_session_id: null, call_requested_via: null, call_requested_at: null, menu_count: 0, whatsapp_jid: `${fields.phone.slice(1)}@s.whatsapp.net`, last_error: null, created_at: now, updated_at: now }
  try {
    if (start) {
      await transaction(async session => {
        await orders().insertOne(row, { session })
        await queue(row, 'invite', `invite:${row.id}`, session)
      })
    } else {
      await orders().insertOne(row)
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw orderError('An order with this reference already exists.', 409)
    throw error
  }
  return orderView(row, start ? 'pending' : null)
}

export async function listOrders(userId: number, organization = false, selectedId?: string) {
  const filter = organization ? {} : { user_id: userId }
  const rows = await orders().find({ ...filter, ...(selectedId ? { id: selectedId } : {}) }).sort({ created_at: -1 }).limit(100).toArray()
  const invites = rows.length ? await jobs().find({ key: { $in: rows.map(row => `invite:${row.id}`) } }).toArray() : []
  const byOrder = new Map(invites.map(invite => [invite.order_id, invite.status === 'done' && !invite.provider_acknowledged ? 'processed' as const : invite.status]))
  return rows.map(row => orderView(row, byOrder.get(row.id) ?? null))
}

function orderView(row: Order, invitationStatus?: Job['status'] | 'processed' | null) {
  const { _id, whatsapp_jid, agent_proposal, agent_intake, ...view } = row as Order & { _id?: unknown }
  return { ...view, invitationStatus, message: orderMessage(row, row.status === 'pending' ? 'invite' : row.status) }
}

async function queue(row: Order, kind: Job['kind'], key: string, session: ClientSession, delay = 0, extra: Partial<Job> = {}) {
  await jobs().updateOne({ key }, { $setOnInsert: { ...extra, key, order_id: row.id, kind, status: 'pending', command_id: randomUUID(), priority: kind === 'hangup' ? 10 : kind === 'menu' || kind === 'voice' ? 5 : kind === 'invite' ? 2 : kind === 'agent_input' ? -1 : 0, available_at: new Date(Date.now() + delay).toISOString() } }, { upsert: true, session })
}

async function save(row: Order, session: ClientSession) {
  row.updated_at = new Date().toISOString()
  const { _id, ...values } = row as Order & { _id?: unknown }
  await orders().updateOne({ id: row.id }, { $set: values }, { session })
}

async function decide(row: Order, status: 'confirmed' | 'cancelled', session: ClientSession, endCall = true) {
  if (row.status !== 'pending') return
  row.status = status
  await queue(row, status, `receipt:${row.id}`, session)
  if (endCall && (row.call_control_id || row.call_mode === 'whatsapp' && row.attempt_id) && row.call_status !== 'unanswered' && row.call_status !== 'completed') await queue(row, 'hangup', `hangup:${row.attempt_id}`, session)
}

async function queueCall(row: Order, session: ClientSession, source: NonNullable<Order['call_requested_via']> = 'admin', mode: CallMode = 'ivr', whatsappReady = false) {
  if (row.status !== 'pending' || row.attempt_id) throw orderError('This order is decided or already has a call attempt.', 409)
  const setup = orderSetup()
  if (mode !== 'ivr' && !voiceReady()) throw orderError('The conversational voice assistant is not configured.', 409)
  if (mode === 'whatsapp') {
    if (!whatsappReady) throw orderError('Link the separate WhatsApp voice device first.', 409)
  } else {
    if (setup.missing.length || setup.configurationError || !setup.audio[row.language]) throw orderError('Calling is not configured. Check the setup information and IVR audio.', 409)
    const user = await store.collection('users').findOne({ id: row.user_id }, { session })
    if (Number(user?.balance_units ?? 0) <= 0) throw orderError('The order owner needs calling credit before requesting this call.', 402)
  }
  const invitation = await jobs().findOne({ key: `invite:${row.id}` }, { session })
  if (invitation?.status === 'failed') throw orderError('The order message failed. Review its action log before calling.', 409)
  if (!invitation) await queue(row, 'invite', `invite:${row.id}`, session)
  row.attempt_id = randomUUID()
  row.call_requested_via = source
  row.call_requested_at = new Date().toISOString()
  row.call_mode = mode
  row.call_status = 'queued'
  row.last_error = null
  await queue(row, 'dial', `dial:${row.attempt_id}`, session)
}

export async function requestOrderAction(userId: number, id: string, action: 'invite' | 'call', consent = false, requestedMode: unknown = 'ivr', role?: AuthUser['role']) {
  requireLive()
  if (requestedMode !== 'ivr' && requestedMode !== 'voice' && requestedMode !== 'whatsapp') throw orderError('Choose a valid call type.')
  if (action === 'call' && !consent) throw orderError('Confirm that the customer requested this phone call.')
  const whatsappReady = action === 'call' && requestedMode === 'whatsapp' && voiceReady() && (await whatsAppVoiceStatus()).state === 'ready'
  return transaction(async session => {
    const row = await orders().findOne(role === 'admin' ? { id } : { id, user_id: userId }, { session })
    if (!row) throw orderError('Order not found.', 404)
    if (row.status !== 'pending') throw orderError('This order is already decided.', 409)
    if (action === 'call') {
      await queueCall(row, session, role === 'user' ? 'staff' : 'admin', requestedMode, whatsappReady)
    } else {
      if (await jobs().findOne({ key: `invite:${row.id}` }, { session })) throw orderError('The confirmation request is already queued or sent. Check its action log.', 409)
      await queue(row, 'invite', `invite:${row.id}`, session)
    }
    await save(row, session)
    return orderView(row)
  })
}

export async function orderActions(userId: number, id: string, organization = false) {
  if (!await orders().findOne(organization ? { id } : { id, user_id: userId })) throw orderError('Order not found.', 404)
  return (await jobs().find({ order_id: id }).sort({ available_at: 1 }).limit(30).toArray()).map(({ key, kind, status, error }) => ({ key, kind, status, error }))
}

export async function handleOrderMessage(input: { id: string, phone: string, body: string, channel: 'sms' | 'whatsapp', jid?: string }) {
  if (!enabled()) return false
  if (!input.id || input.id.length > 200 || !/^\+[1-9]\d{7,14}$/.test(input.phone) || !input.body.trim() || input.body.length > 2000) return false
  const receivedAt = new Date().toISOString()
  const command = orderCommand(input.body)
  const found = command ? await orders().findOne({ reference: command.reference, phone: input.phone }) : null
  if (!found || !command) {
    const answer = approvalReply(input.body)
    const voiceProposal = !command && answer?.reference ? await orders().findOne({ phone: input.phone, reference: answer.reference }) : null
    if (!command && (textAgentEnabled() || voiceProposal?.agent_proposal?.from_voice)) {
      const known = voiceProposal || await orders().findOne({ phone: input.phone })
      if (!known) return false
      await once(`message:${input.channel}:${input.id}`, async session => {
        const budget = await orders().findOne({ id: known.id }, { session })
        if (!budget) return
        const minute = Math.floor(Date.now() / 60000)
        const count = budget.agent_intake?.minute === minute ? budget.agent_intake.count : 0
        if (count >= 6) {
          await queue(budget, 'agent_reply', `agent-limit:${input.phone}:${minute}`, session, 0, { text: 'Please wait one minute before sending another assistant request. Exact CONFIRM, CANCEL and CALL commands still work.', channel: input.channel, recipient: input.jid || budget.whatsapp_jid })
          return
        }
        budget.agent_intake = { minute, count: count + 1 }
        await save(budget, session)
        await queue(budget, 'agent_input', `agent:${input.channel}:${input.id}`, session, 0, { phone: input.phone, input: { ...input, received_at: receivedAt } })
      })
      return true
    }
    const pending = await orders().findOne({ phone: input.phone, status: 'pending' })
    if (!pending) return false
    // Keep the general chat bot from promising an order decision on vague replies.
    await once(`message:${input.channel}:${input.id}`, async session => queue(pending, 'help', `help:${input.channel}:${input.id}`, session))
    return true
  }
  const whatsappReady = command.action === 'call-whatsapp' && !found.attempt_id && found.status === 'pending' && voiceReady() && (await whatsAppVoiceStatus()).state === 'ready'
  await once(`message:${input.channel}:${input.id}`, async session => {
    const row = await orders().findOne({ id: found.id }, { session })
    if (!row) return
    if (input.channel === 'whatsapp' && input.jid && /@(s\.whatsapp\.net|lid)$/.test(input.jid)) row.whatsapp_jid = input.jid
    if (command.action === 'confirm' || command.action === 'cancel') await decide(row, command.action === 'confirm' ? 'confirmed' : 'cancelled', session)
    else if (row.status === 'pending' && !row.attempt_id) {
      try { await queueCall(row, session, input.channel, command.action === 'call-whatsapp' ? 'whatsapp' : voiceReady() ? 'voice' : 'ivr', whatsappReady) } catch (error) {
        if (!(error instanceof Error) || !('statusCode' in error)) throw error
        row.last_error = error.message
        if (command.action === 'call-whatsapp') await queue(row, 'agent_reply', `call-unavailable:${input.channel}:${input.id}`, session, 0, { channel: input.channel, recipient: input.channel === 'sms' ? input.phone : row.whatsapp_jid, text: row.language === 'ur' ? `واٹس ایپ کال دستیاب نہیں۔ آرڈر میں کوئی تبدیلی نہیں ہوئی۔ ${row.reference}` : `WhatsApp calling is unavailable for ${row.reference}. Your order has not changed.` })
      }
    }
    await save(row, session)
  })
  return true
}

async function once(key: string, work: (session: ClientSession) => Promise<void>) {
  try {
    await transaction(async session => {
      if (await store.collection('order_events').findOne({ key }, { session })) return
      await store.collection('order_events').insertOne({ key, created_at: new Date().toISOString() }, { session })
      await work(session)
    })
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error
  }
}

function string(value: unknown) { return typeof value === 'string' ? value : '' }

async function processAgentInput(job: Job) {
  const input = job.input!
  // shortcut: inspect the latest 20 orders per sender; add older-reference retrieval when histories grow.
  const candidates = await orders().find({ phone: input.phone }).sort({ created_at: -1 }).limit(20).toArray()
  const views = candidates.map(({ reference, item, amount, currency, status, customer }): AgentOrder => ({ reference, item, amount, currency, status, customer }))
  const answer = approvalReply(input.body)
  const proposals = candidates.filter(row => row.agent_proposal?.channel === input.channel && (answer?.reference ? row.reference === answer.reference : !row.agent_proposal?.from_voice))
  const target = answer && proposals.length === 1 ? proposals[0] : null
  let plan: ReturnType<typeof validateAgentPlan> | null = null
  let modelError = ''
  if (!answer && textAgentEnabled()) {
    try {
      const history = await jobs().find({ kind: 'agent_input', phone: input.phone, status: 'done' }).sort({ available_at: -1 }).limit(6).toArray()
      plan = validateAgentPlan(await textAgent.plan(input, views, history.reverse().filter(turn => turn.input && turn.text).map(turn => ({ body: turn.input!.body, reply: turn.text! }))), input.body, views)
    } catch (error) {
      modelError = error instanceof Error && /429|quota/i.test(error.message) ? 'Text assistant quota exhausted. Exact order commands remain available.' : 'Text assistant unavailable or response invalid. Exact order commands remain available.'
    }
  }
  await once(`agent-result:${job.key}`, async session => {
    const row = await orders().findOne({ id: target?.id || candidates.find(row => row.reference === plan?.reference)?.id || job.order_id, phone: input.phone }, { session })
    if (!row) throw new Error('Customer order unavailable.')
    const language = plan?.language || row.agent_proposal?.language || (row.language === 'ur' ? 'ur' : 'en')
    let text = agentMessage(language, 'failed')
    if (!textAgentEnabled() && !(answer && row.agent_proposal?.from_voice)) text = orderMessage(row, 'help')
    else if (answer) {
      const proposal = row.agent_proposal
      const preview = proposal ? await jobs().findOne({ key: proposal.reply_key }, { session }) : null
      if (!target || row.status !== 'pending' || !proposal || proposal.id !== target.agent_proposal?.id || proposal.channel !== input.channel || proposal.expires_at < new Date().toISOString() || proposal.expires_at < input.received_at || !preview?.sent_at || preview.status !== 'done' || input.received_at < preview.sent_at) text = agentMessage(language, 'unavailable')
      else {
        row.agent_proposal = null
        if (!answer.approved) text = agentMessage(language, 'withdrawn')
        else if (proposal.action === 'details') {
          row.customer = { name: row.customer?.name || null, address: row.customer?.address || null, notes: row.customer?.notes || null }
          for (const field of ['name', 'address', 'notes'] as const) if (proposal.details?.[field]) row.customer[field] = proposal.details[field]
          text = agentMessage(language, 'saved')
        } else if (proposal.action === 'confirm' || proposal.action === 'cancel') {
          await decide(row, proposal.action === 'confirm' ? 'confirmed' : 'cancelled', session)
          text = agentMessage(language, 'status', row)
        } else {
          try {
            await queueCall(row, session, input.channel, voiceReady() ? 'voice' : 'ivr')
            text = `${row.reference}: Phone callback queued. We will send its result by ${row.channel}.`
          } catch (error) {
            if (!(error instanceof Error) || !('statusCode' in error)) throw error
            row.last_error = error.message
            text = `${row.reference}: Phone callback unavailable. No new call was queued. Please contact the business.`
          }
        }
      }
    } else if (plan) {
      if (plan.action === 'question') text = agentMessage(language, 'question')
      else if (plan.action === 'status') text = agentMessage(language, 'status', row)
      else if (row.status !== 'pending') text = agentMessage(language, 'unavailable')
      else {
        row.agent_proposal = { id: job.key, action: plan.action, details: plan.details, language, channel: input.channel, expires_at: new Date(Date.now() + 600000).toISOString(), reply_key: `agent-reply:${job.key}` }
        text = agentMessage(language, 'proposal', row, row.agent_proposal)
      }
    }
    if (input.channel === 'whatsapp' && input.jid && /@(s\.whatsapp\.net|lid)$/.test(input.jid)) row.whatsapp_jid = input.jid
    if (modelError) row.last_error = modelError
    await save(row, session)
    await queue(row, 'agent_reply', `agent-reply:${job.key}`, session, 0, { text, channel: input.channel, recipient: input.channel === 'sms' ? input.phone : row.whatsapp_jid })
    await jobs().updateOne({ key: job.key }, { $set: { text, ...(modelError ? { error: modelError } : {}) } }, { session })
  })
}

export async function handleVoiceDecision(call: Pick<Order, 'id' | 'attempt_id'>, action: 'confirm' | 'cancel') {
  if (!enabled() || !voiceReady() || !call.attempt_id || (action !== 'confirm' && action !== 'cancel')) return false
  const replyKey = `voice-preview:${call.attempt_id}`
  return transaction(async session => {
    const row = await orders().findOne({ id: call.id, attempt_id: call.attempt_id, status: 'pending', call_status: 'answered' }, { session })
    if (!row || (row.call_mode !== 'voice' && row.call_mode !== 'whatsapp') || await jobs().findOne({ key: replyKey }, { session })) return false
    if (row.call_mode === 'whatsapp') {
      row.agent_proposal = null
      await decide(row, action === 'confirm' ? 'confirmed' : 'cancelled', session, false)
      await save(row, session)
      return true
    }
    if (row.agent_proposal && row.agent_proposal.expires_at > new Date().toISOString()) return false
    const proposal: AgentProposal = { id: replyKey, action, details: null, language: row.language, channel: row.channel, expires_at: new Date(Date.now() + 600000).toISOString(), reply_key: replyKey, from_voice: true }
    row.agent_proposal = proposal
    await save(row, session)
    await queue(row, 'agent_reply', replyKey, session, 0, { text: agentMessage(row.language, 'proposal', row, proposal), channel: row.channel, recipient: row.channel === 'sms' ? row.phone : row.whatsapp_jid })
    return true
  })
}

async function fallbackToMenu(call: Order) {
  await transaction(async session => {
    const row = await orders().findOne({ id: call.id, attempt_id: call.attempt_id, status: 'pending', call_status: 'answered', call_mode: 'voice' }, { session })
    if (!row || !row.call_control_id) return
    row.call_mode = 'ivr'
    row.last_error = 'The voice assistant was unavailable. The call switched to the keypad menu.'
    await queue(row, 'menu', `menu:${row.attempt_id}:1`, session)
    await save(row, session)
  })
}

async function startVoiceJob(row: Order, job: Job) {
  if (row.status !== 'pending' || row.call_status !== 'answered') return
  try {
    if (!voiceReady()) throw new Error('Voice is disabled.')
    await startTelnyxVoice(row, publicBase(), job.command_id, action => handleVoiceDecision(row, action),
      () => void fallbackToMenu(row).catch(() => console.error('The keypad fallback could not be queued.')))
  } catch { await fallbackToMenu(row) }
}

async function updateWhatsAppCall(call: Order, next: 'ringing' | 'answered' | 'ended' | 'review', reason?: string) {
  await transaction(async session => {
    const row = await orders().findOne({ id: call.id, attempt_id: call.attempt_id, call_mode: 'whatsapp' }, { session })
    if (!row || !['dialing', 'ringing', 'answered'].includes(row.call_status)) return
    if (next === 'ringing' && row.call_status !== 'dialing') return
    if (reason) row.call_end_reason = reason.slice(0, 300)
    if (next === 'ended') {
      row.call_status = row.status === 'pending' && !row.agent_proposal?.from_voice ? 'unanswered' : 'completed'
      if (row.status === 'pending' && !row.agent_proposal?.from_voice) await queue(row, 'unanswered', `unanswered:${row.attempt_id}`, session, 5000)
    } else {
      row.call_status = next
      if (next === 'review') row.last_error = reason || 'WhatsApp call or voice assistant disconnected. Review the outcome before contacting the customer again.'
    }
    await save(row, session)
  })
}

export async function handleOrderWebhook(eventType: string, eventId: string, payload: Record<string, unknown>) {
  if (eventType === 'message.received') {
    const from = payload.from as { phone_number?: unknown } | undefined
    const to = payload.to as { phone_number?: unknown }[] | undefined
    if (payload.direction !== 'inbound' || !Array.isArray(to) || !to.some(number => number.phone_number === (process.env.TELNYX_SMS_PHONE_NUMBER?.trim() || process.env.TELNYX_PHONE_NUMBER?.trim()))) return false
    if (!/^\+[1-9]\d{7,14}$/.test(string(from?.phone_number)) || !eventId || typeof payload.text !== 'string' || payload.text.length > 2000) return false
    return handleOrderMessage({ id: string(payload.id) || eventId, phone: string(from?.phone_number), body: payload.text, channel: 'sms' })
  }
  if (!eventType.startsWith('call.') && eventType !== 'streaming.failed') return false
  const controlId = string(payload.call_control_id), sessionId = string(payload.call_session_id)
  let attempt = ''
  try { attempt = JSON.parse(Buffer.from(string(payload.client_state), 'base64').toString()).orderAttempt || '' } catch { /* Non-order calls have no order state. */ }
  const filters = [...(controlId ? [{ call_control_id: controlId }] : []), ...(sessionId ? [{ call_session_id: sessionId }] : []), ...(typeof attempt === 'string' && attempt ? [{ attempt_id: attempt }] : [])]
  if (!filters.length) return false
  const found = await orders().findOne({ $or: filters, call_mode: { $ne: 'whatsapp' } })
  if (!found) return false
  if (!eventId) throw orderError('Order call webhooks require an event id.')
  if (eventType === 'streaming.failed') {
    stopTelnyxVoice(found.attempt_id)
    await fallbackToMenu(found)
    return true
  }
  // Link the call before the ordinary billing webhook can arrive out of order.
  await upsertCall({ clientCallId: found.attempt_id, callControlId: controlId || null, callSessionId: sessionId || null }, found.user_id)
  await applyWebhook(eventType, { ...payload, client_call_id: found.attempt_id })
  await once(`telnyx:${eventId}`, async session => {
    const row = await orders().findOne({ id: found.id }, { session })
    if (!row || row.attempt_id !== found.attempt_id) return
    if (controlId) row.call_control_id = controlId
    if (sessionId) row.call_session_id = sessionId
    if (eventType === 'call.answered') {
      if (row.status !== 'pending') await queue(row, 'hangup', `hangup:${row.attempt_id}`, session)
      else if (!['completed', 'unanswered'].includes(row.call_status) && row.menu_count === 0) {
        row.call_status = 'answered'; row.menu_count = 1
        if (row.call_mode === 'voice' && voiceReady()) await queue(row, 'voice', `voice:${row.attempt_id}`, session)
        else {
          row.call_mode = 'ivr'
          await queue(row, 'menu', `menu:${row.attempt_id}:1`, session)
        }
      }
    } else if (eventType === 'call.ringing' && ['queued', 'dialing'].includes(row.call_status)) row.call_status = 'ringing'
    else if (eventType === 'call.gather.ended' && row.status === 'pending' && row.call_mode !== 'voice') {
      const digit = payload.status === 'valid' ? string(payload.digits) : ''
      if (digit === '1' || digit === '2') {
        await decide(row, digit === '1' ? 'confirmed' : 'cancelled', session)
        if (row.call_status === 'unanswered') row.call_status = 'completed'
      }
      else if (!['completed', 'unanswered'].includes(row.call_status)) {
        if (!['call_hangup', 'cancelled', 'cancelled_amd'].includes(string(payload.status)) && row.menu_count < 3) {
          row.menu_count += 1
          await queue(row, 'menu', `menu:${row.attempt_id}:${row.menu_count}`, session)
        } else await queue(row, 'hangup', `hangup:${row.attempt_id}`, session)
      }
    } else if (eventType === 'call.hangup') {
      row.call_status = row.status === 'pending' && !row.agent_proposal?.from_voice ? 'unanswered' : 'completed'
      if (row.status === 'pending' && !row.agent_proposal?.from_voice) await queue(row, 'unanswered', `unanswered:${row.attempt_id}`, session, 5000)
    }
    await save(row, session)
  })
  if (eventType === 'call.hangup') stopTelnyxVoice(found.attempt_id)
  return true
}

export type WhatsAppSender = (jid: string, text: string) => Promise<void>

export async function runOrderJob(sendWhatsApp: WhatsAppSender, lane?: 'agent' | 'actions') {
  if (!enabled()) return false
  // An interrupted send may already have reached the provider; never silently redial.
  const stale = await jobs().findOneAndUpdate({ status: 'working', started_at: { $lt: new Date(Date.now() - 90000).toISOString() } }, { $set: { status: 'failed', error: 'Action interrupted. Review provider history before retrying.' } }, { returnDocument: 'after' })
  if (stale) await orders().updateOne({ id: stale.order_id }, { $set: { last_error: stale.error, ...(stale.kind === 'dial' ? { call_status: 'review' } : {}) } })
  const job = await jobs().findOneAndUpdate({ status: 'pending', available_at: { $lte: new Date().toISOString() }, ...(lane ? { kind: lane === 'agent' ? 'agent_input' : { $ne: 'agent_input' } } : {}) }, { $set: { status: 'working', started_at: new Date().toISOString() } }, { sort: { priority: -1, available_at: 1 }, returnDocument: 'after' })
  if (!job) return false
  let sendTimeout: NodeJS.Timeout | undefined
  try {
    const row = await orders().findOne({ id: job.order_id })
    if (!row) throw new Error('Order no longer exists.')
    if (job.kind === 'invite' && row.status !== 'pending') {
      await jobs().updateOne({ key: job.key }, { $set: { status: 'skipped' } })
      return true
    }
    if (job.kind === 'agent_input') await processAgentInput(job)
    else if (job.kind === 'dial') {
      if (await dialOrder(row) === false) {
        await jobs().updateOne({ key: job.key }, { $set: { status: 'pending' } })
        return true
      }
    }
    else if (job.kind === 'voice') await startVoiceJob(row, job)
    else if (job.kind === 'hangup' && row.call_mode === 'whatsapp') stopWhatsAppVoice(row.attempt_id)
    else if (job.kind === 'menu' || job.kind === 'hangup') {
      if (job.kind === 'hangup') stopTelnyxVoice(row.attempt_id)
      if (row.call_control_id && !['unanswered', 'completed'].includes(row.call_status)) {
        const hangup = job.kind === 'hangup' || row.status !== 'pending'
        await telnyx(`/calls/${encodeURIComponent(row.call_control_id)}/actions/${hangup ? 'hangup' : 'gather_using_audio'}`, { method: 'POST', timeoutMs: 20000, body: hangup ? { command_id: job.command_id } : { command_id: job.command_id, audio_url: `${publicBase()}/api/order-audio/${row.language}.wav`, valid_digits: '129', minimum_digits: 1, maximum_digits: 1, maximum_tries: 1, timeout_millis: 10000, inter_digit_timeout_millis: 1000 } })
      }
    } else if (job.kind === 'agent_reply' ? !job.key.startsWith('voice-preview:') || row.status === 'pending' && row.agent_proposal?.reply_key === job.key : (job.kind === 'invite' || job.kind === 'unanswered' || job.kind === 'help') ? row.status === 'pending' : row.status === job.kind) {
      const text = job.kind === 'agent_reply' ? job.text! : orderMessage(row, job.kind, job.kind === 'invite' && voiceReady() && whatsAppVoiceConfigured() && (await whatsAppVoiceStatus()).state === 'ready')
      const channel = job.kind === 'agent_reply' ? job.channel : row.channel
      if (channel === 'whatsapp') await Promise.race([
        sendWhatsApp(job.kind === 'agent_reply' ? job.recipient! : row.whatsapp_jid, text),
        new Promise<never>((_, reject) => { sendTimeout = setTimeout(() => reject(new Error('WhatsApp send timed out. Review the chat before retrying.')), 20000) }),
      ])
      else {
        const result = await telnyx('/messages', { method: 'POST', timeoutMs: 20000, body: { from: process.env.TELNYX_SMS_PHONE_NUMBER?.trim() || required('TELNYX_PHONE_NUMBER'), to: row.phone, text, type: 'SMS' } })
        if (typeof result.data?.id !== 'string') throw new Error('Telnyx did not acknowledge the SMS. Review provider history.')
        await recordSms('message.accepted', { ...result.data, direction: 'outbound', from: { phone_number: process.env.TELNYX_SMS_PHONE_NUMBER?.trim() || required('TELNYX_PHONE_NUMBER') }, to: [{ phone_number: row.phone }], text })
      }
    }
    await jobs().updateOne({ key: job.key }, { $set: { status: 'done', sent_at: new Date().toISOString(), ...(job.kind === 'invite' ? { provider_acknowledged: true } : {}) } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Order action failed.'
    await jobs().updateOne({ key: job.key }, { $set: { status: 'failed', error: message } })
    await orders().updateOne({ id: job.order_id }, { $set: { last_error: message, ...(job.kind === 'dial' ? { call_status: 'review' } : {}) } })
    console.error(`Order action ${job.kind} failed; inspect the order action log.`)
  } finally { clearTimeout(sendTimeout) }
  return true
}

async function dialOrder(row: Order) {
  if (row.status !== 'pending' || row.call_status !== 'queued') return
  const invitation = await jobs().findOne({ key: `invite:${row.id}` })
  if (invitation && ['pending', 'working'].includes(invitation.status)) return false
  if (invitation?.status !== 'done') throw new Error('The order details message was not acknowledged. Review its action log before calling.')
  const claimed = await orders().findOneAndUpdate({ id: row.id, status: 'pending', call_status: 'queued' }, { $set: { call_status: 'dialing' } }, { returnDocument: 'after' })
  if (!claimed) return
  if (row.call_mode === 'whatsapp') {
    if (!voiceReady()) throw new Error('WhatsApp voice is disabled.')
    if (!await orders().findOne({ id: row.id, status: 'pending', call_status: 'dialing' })) return
    await startWhatsAppVoice(row, action => handleVoiceDecision(row, action), (next, reason) => updateWhatsAppCall(row, next, reason))
    return
  }
  const user = await store.collection('users').findOne({ id: row.user_id })
  if (Number(user?.balance_units ?? 0) <= 0) throw orderError('Insufficient calling credit.', 402)
  if (!existsSync(orderAudioFile(row.language))) throw new Error('The IVR menu audio is missing.')
  const from = required('TELNYX_PHONE_NUMBER')
  await upsertCall({ clientCallId: row.attempt_id, from, to: row.phone, direction: 'outbound', status: 'initiated' }, row.user_id)
  if (!await orders().findOne({ id: row.id, status: 'pending', call_status: 'dialing' })) return
  const result = await telnyx('/calls', { method: 'POST', timeoutMs: 20000, body: { connection_id: required('TELNYX_CALL_CONTROL_CONNECTION_ID'), from, to: row.phone, command_id: row.attempt_id, client_state: Buffer.from(JSON.stringify({ orderAttempt: row.attempt_id })).toString('base64'), webhook_url: `${publicBase()}/api/telnyx/webhook`, webhook_url_method: 'POST', timeout_secs: 25, time_limit_secs: 90 } })
  if (typeof result.data?.call_control_id !== 'string' || !result.data.call_control_id) throw new Error('Telnyx did not return a call id. Review provider history before retrying.')
  await upsertCall({ clientCallId: row.attempt_id, callControlId: result.data.call_control_id, callSessionId: string(result.data.call_session_id) || null }, row.user_id)
  await transaction(async session => {
    const latest = await orders().findOne({ id: row.id }, { session })
    if (!latest) return
    latest.call_control_id = result.data.call_control_id
    latest.call_session_id = string(result.data.call_session_id) || latest.call_session_id
    if (latest.status !== 'pending') await queue(latest, 'hangup', `hangup:${latest.attempt_id}`, session)
    await save(latest, session)
  })
}

export function startOrderWorker(sendWhatsApp: WhatsAppSender) {
  let running: Promise<unknown> | null = null
  let agentRunning: Promise<unknown> | null = null
  const timer = setInterval(() => {
    if (!running) running = runOrderJob(sendWhatsApp, 'actions').catch(() => console.error('Order worker failed; queued actions are retained.')).finally(() => { running = null })
    if (!agentRunning) agentRunning = runOrderJob(sendWhatsApp, 'agent').catch(() => console.error('Text agent worker failed; queued actions are retained.')).finally(() => { agentRunning = null })
  }, 1000)
  timer.unref()
  return async () => { clearInterval(timer); await Promise.all([running, agentRunning]) }
}
