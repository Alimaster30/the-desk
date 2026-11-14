import type { ClientSession } from 'mongodb'
import { durationSeconds, nextStatus, toUnits } from './logic.ts'
import { store, nextId, transaction } from './store.ts'

type CallRow = {
  id: number
  client_call_id: string | null
  call_session_id: string | null
  call_leg_id: string | null
  call_control_id: string | null
  direction: string | null
  from_number: string | null
  to_number: string | null
  status: string
  started_at: string | null
  answered_at: string | null
  ended_at: string | null
  duration_seconds: number | null
  billable_seconds: number | null
  cost_amount: string | null
  currency: string | null
  hangup_cause: string | null
  created_at: string
  user_id?: number | null
  charged?: number | null
}

export type CallPatch = {
  clientCallId?: string | null
  callSessionId?: string | null
  callLegId?: string | null
  callControlId?: string | null
  direction?: string | null
  from?: string | null
  to?: string | null
  status?: string | null
  startedAt?: string | null
  answeredAt?: string | null
  endedAt?: string | null
  hangupCause?: string | null
  costAmount?: string | null
  currency?: string | null
  billableSeconds?: number | null
}

export function callJson(row: CallRow) {
  return {
    id: row.id,
    direction: row.direction,
    from: row.from_number,
    to: row.to_number,
    status: row.status,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    billableSeconds: row.billable_seconds,
    costAmount: row.cost_amount,
    currency: row.currency,
    hangupCause: row.hangup_cause,
  }
}

export async function listCalls(userId: number) {
  const rows = await store.collection<CallRow>('calls').find({ user_id: userId }).sort({ started_at: -1, created_at: -1 }).limit(200).toArray()
  return rows.map(callJson)
}

export async function getCall(id: number) {
  const row = await store.collection<CallRow>('calls').findOne({ id })
  return row ? { row, json: callJson(row) } : null
}

export async function upsertCall(patch: CallPatch, userId?: number) {
  return transaction(async session => {
    const existing = await findCall(patch, session)
    if (userId && existing?.user_id && existing.user_id !== userId) throw Object.assign(new Error('No call with that id.'), { statusCode: 404 })
    const status = patch.status ? nextStatus(existing?.status ?? null, patch.status) : existing?.status ?? 'initiated'
    const answeredAt = patch.answeredAt || existing?.answered_at || null
    const endedAt = patch.endedAt || existing?.ended_at || null
    const finished = status === 'hangup' || status === 'failed'
    const duration = finished ? durationSeconds(answeredAt, endedAt) : existing?.duration_seconds ?? null
    const values = {
      client_call_id: patch.clientCallId || existing?.client_call_id || null,
      call_session_id: patch.callSessionId || existing?.call_session_id || null,
      call_leg_id: patch.callLegId || existing?.call_leg_id || null,
      call_control_id: patch.callControlId || existing?.call_control_id || null,
      direction: patch.direction || existing?.direction || null,
      from_number: patch.from || existing?.from_number || null,
      to_number: patch.to || existing?.to_number || null,
      status,
      started_at: patch.startedAt || existing?.started_at || new Date().toISOString(),
      answered_at: answeredAt,
      ended_at: endedAt,
      duration_seconds: duration,
      billable_seconds: patch.billableSeconds ?? existing?.billable_seconds ?? null,
      cost_amount: patch.costAmount || existing?.cost_amount || null,
      currency: patch.currency || existing?.currency || null,
      hangup_cause: patch.hangupCause || existing?.hangup_cause || null,
    }
    const row: CallRow = { ...values, id: existing?.id ?? await nextId('calls', session), created_at: existing?.created_at ?? new Date().toISOString(), user_id: existing?.user_id ?? userId ?? null, charged: existing?.charged ?? 0 }
    await store.collection<CallRow>('calls').updateOne({ id: row.id }, { $set: row }, { upsert: true, session })
    if (row.cost_amount != null) await chargeCall(row, session)
    return { row, json: callJson(row) }
  })
}

async function findCall(patch: CallPatch, session: ClientSession): Promise<CallRow | null> {
  for (const [field, value] of [['call_session_id', patch.callSessionId], ['client_call_id', patch.clientCallId], ['call_control_id', patch.callControlId], ['call_leg_id', patch.callLegId]]) {
    if (!value) continue
    const row = await store.collection<CallRow>('calls').findOne({ [field!]: value }, { session })
    if (row) return row
  }
  if (patch.to && patch.callSessionId) {
    const row = await store.collection<CallRow>('calls').findOne({ to_number: patch.to, call_session_id: null }, { sort: { id: -1 }, session })
    const age = row ? Date.now() - Date.parse(row.created_at) : Infinity
    if (row && age >= 0 && age < 120000) return row
  }
  return null
}

async function chargeCall(row: CallRow, session: ClientSession) {
  if (row.charged || !row.user_id) return
  const units = toUnits(row.cost_amount ?? '') ?? 0
  if (row.user_id && units > 0) {
    await store.collection('users').updateOne({ id: row.user_id }, { $inc: { balance_units: -units } }, { session })
    await store.collection('ledger').insertOne({ id: await nextId('ledger', session), user_id: row.user_id, amount_units: -units, kind: 'call', ref: String(row.id), note: 'Call', created_at: new Date().toISOString() }, { session })
  }
  row.charged = 1
  await store.collection('calls').updateOne({ id: row.id }, { $set: { charged: 1 } }, { session })
}

export async function setCallCost(id: number, amount: string, currency: string | null, billableSeconds: number | null) {
  return transaction(async session => {
    const row = await store.collection<CallRow>('calls').findOne({ id }, { session })
    if (!row) throw new Error('Call not found')
    row.cost_amount = amount; row.currency = currency; row.billable_seconds = billableSeconds ?? row.billable_seconds
    await store.collection<CallRow>('calls').updateOne({ id }, { $set: { cost_amount: amount, currency, billable_seconds: row.billable_seconds } }, { session })
    await chargeCall(row, session)
    return { row, json: callJson(row) }
  })
}

type MessageRow = { id: number, wa_message_id: string, chat_jid: string, sender: string | null, push_name: string | null, body: string, timestamp: string, from_me: number, source: string, media?: { kind: string; name: string; mimetype: string } }

export async function saveText(input: { waMessageId: string, chatJid: string, sender: string | null, pushName: string | null, body: string, timestamp: string, displayName: string | null, fromMe: boolean, source: 'user' | 'auto' }) {
  return transaction(async session => {
    if (await store.collection('wa_messages').findOne({ wa_message_id: input.waMessageId }, { session })) return false
    await store.collection<MessageRow>('wa_messages').insertOne({ id: await nextId('wa_messages', session), wa_message_id: input.waMessageId, chat_jid: input.chatJid, sender: input.sender, push_name: input.pushName, body: input.body, timestamp: input.timestamp, from_me: input.fromMe ? 1 : 0, source: input.source }, { session })
    const chat = await store.collection('wa_chats').findOne({ jid: input.chatJid }, { session })
    await store.collection('wa_chats').updateOne({ jid: input.chatJid }, { $set: { display_name: chat?.display_name ?? input.displayName } }, { upsert: true, session })
    return true
  })
}

export async function setChatName(jid: string, name: string) {
  await store.collection('wa_chats').updateOne({ jid }, { $set: { display_name: name } }, { upsert: true })
}

export async function listChats() {
  const rows = await store.collection('wa_messages').aggregate([
    { $sort: { timestamp: 1, id: 1 } },
    { $group: { _id: '$chat_jid', message_count: { $sum: { $cond: [{ $eq: ['$from_me', 0] }, 1, 0] } }, transcript_count: { $sum: 1 }, first_message_at: { $first: '$timestamp' }, last_message_at: { $last: '$timestamp' }, last_text: { $last: '$body' } } },
    { $lookup: { from: 'wa_chats', localField: '_id', foreignField: 'jid', as: 'chat' } },
    { $sort: { last_message_at: -1 } },
  ]).toArray()
  return rows.map(row => {
    const chat = row.chat[0] ?? {}
    return { jid: row._id as string, displayName: chat.display_name ?? null, messageCount: Number(row.message_count), transcriptCount: Number(row.transcript_count), firstMessageAt: row.first_message_at as string, lastMessageAt: row.last_message_at as string, lastText: row.last_text as string, summaryText: chat.summary_text ?? null, summaryModel: chat.summary_model ?? null, summaryAt: chat.summary_at ?? null, summaryMessageCount: chat.summary_message_count ?? null, summaryStale: Boolean(chat.summary_text) && chat.summary_message_count !== row.transcript_count }
  })
}

export async function listMessages(jid: string) {
  const rows = await store.collection<MessageRow>('wa_messages').find({ chat_jid: jid }).sort({ timestamp: 1, id: 1 }).toArray()
  return rows.map(row => ({ id: row.id, sender: row.sender, pushName: row.push_name, body: row.body, timestamp: row.timestamp, fromMe: row.from_me === 1, attachment: row.media ? { kind: row.media.kind, name: row.media.name, mimetype: row.media.mimetype, url: `/api/whatsapp/messages/${row.id}/attachment` } : undefined }))
}

export async function saveSummary(jid: string, text: string, model: string, messageCount: number, owner: string) {
  await store.collection('wa_chats').updateOne({ jid }, { $set: { summary_text: text, summary_model: model, summary_at: new Date().toISOString(), summary_message_count: messageCount, summary_owner: owner } })
}

export async function getSetting(key: string): Promise<string | null> {
  return (await store.collection('app_settings').findOne({ key }))?.value ?? null
}
export async function setSetting(key: string, value: string) {
  await store.collection('app_settings').updateOne({ key }, { $set: { value } }, { upsert: true })
}
export async function listReplyRows() {
  const rows = await store.collection<MessageRow>('wa_messages').find().sort({ timestamp: -1, id: -1 }).limit(500).toArray()
  return rows.reverse().map(row => ({ chatJid: row.chat_jid, body: row.body, fromMe: row.from_me === 1, source: row.source || 'user' }))
}
export async function recentChat(jid: string, limit: number) {
  const rows = await store.collection<MessageRow>('wa_messages').find({ chat_jid: jid }).sort({ timestamp: -1, id: -1 }).limit(limit).toArray()
  return rows.reverse().map(row => ({ body: row.body, fromMe: row.from_me === 1 }))
}
export async function listHistoryAnchors() {
  const rows = await store.collection<MessageRow>('wa_messages').aggregate<{ row: MessageRow }>([{ $sort: { id: 1 } }, { $group: { _id: '$chat_jid', row: { $first: '$$ROOT' } } }]).toArray()
  return rows.map(row => row.row)
}
export async function listUnanswered(sinceIso: string) {
  const latest = await store.collection<MessageRow>('wa_messages').aggregate<{ row: MessageRow }>([
    { $match: { from_me: 0, chat_jid: { $not: /@(g\.us|broadcast)$/ } } },
    { $sort: { timestamp: -1, id: -1 } }, { $group: { _id: '$chat_jid', row: { $first: '$$ROOT' } } },
  ]).toArray()
  const result: MessageRow[] = []
  for (const { row } of latest) if (row.timestamp >= sinceIso && !await userRepliedAfter(row.chat_jid, row.timestamp) && !await hasReplied(row.wa_message_id)) result.push(row)
  return result
}
export async function userRepliedAfter(jid: string, timestamp: string) {
  return Boolean(await store.collection('wa_messages').findOne({ chat_jid: jid, timestamp: { $gt: timestamp }, from_me: 1, source: 'user' }))
}
export async function hasReplied(inboundId: string) {
  return Boolean(await store.collection('wa_replies').findOne({ inbound_id: inboundId }))
}
export async function markReplied(inboundId: string) {
  await store.collection('wa_replies').updateOne({ inbound_id: inboundId }, { $setOnInsert: { created_at: new Date().toISOString() } }, { upsert: true })
}
