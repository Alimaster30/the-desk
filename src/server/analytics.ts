import { store } from './store.ts'
import { toUnits, fromUnits } from './logic.ts'
import type { Order } from './orders.ts'

type OrderSummary = Pick<Order, 'id' | 'reference' | 'created_at' | 'status' | 'call_status' | 'attempt_id' | 'call_mode'>
type Invitation = { order_id: string; status: string; kind: 'invite'; available_at: string; provider_acknowledged?: boolean }
type CallSummary = { started_at: string; duration_seconds: number | null; ended_at: string | null; cost_amount: string | null; currency: string | null }

export async function organizationAnalytics(days: 7 | 30, now = new Date()) {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - days + 1)
  const dates = { $gte: start.toISOString(), $lte: now.toISOString() }
  const daily = Array.from({ length: days }, (_, offset) => ({
    date: new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10),
    pending: 0, confirmed: 0, cancelled: 0, calls: 0, minutes: 0,
  }))
  const outcomes = { pending: 0, confirmed: 0, cancelled: 0 }
  const invitations = { queued: 0, acknowledged: 0, failed: 0, skipped: 0, legacyProcessed: 0 }
  const callbacks = {
    telnyx: { active: 0, completed: 0, noDecision: 0, review: 0 },
    whatsapp: { active: 0, completed: 0, noDecision: 0, review: 0 },
  }
  const pending: { id: string; reference: string; createdAt: string }[] = []
  const failed: { id: string; reference: string; createdAt: string }[] = []
  const charges = new Map<string, number>()
  let callCount = 0, callSeconds = 0, pendingCosts = 0

  const [orders, invites, calls] = await Promise.all([
    store.collection<OrderSummary>('orders').find({ created_at: dates }, { projection: { id: 1, reference: 1, created_at: 1, status: 1, call_status: 1, attempt_id: 1, call_mode: 1 } }).sort({ created_at: -1 }).toArray(),
    store.collection<Invitation>('order_jobs').find({ kind: 'invite', available_at: dates }, { projection: { order_id: 1, status: 1, provider_acknowledged: 1 } }).sort({ available_at: -1 }).toArray(),
    store.collection<CallSummary>('calls').find({ started_at: dates, user_id: { $ne: null } }, { projection: { started_at: 1, duration_seconds: 1, ended_at: 1, cost_amount: 1, currency: 1 } }).toArray(),
  ])
  const byDate = new Map(daily.map(day => [day.date, day]))
  for (const order of orders) {
    if (!Object.hasOwn(outcomes, order.status)) continue
    outcomes[order.status]++
    const day = byDate.get(order.created_at.slice(0, 10))
    if (day) day[order.status]++
    if (order.status === 'pending' && pending.length < 8) pending.push({ id: order.id, reference: order.reference, createdAt: order.created_at })
    if (!order.attempt_id) continue
    const channel = callbacks[order.call_mode === 'whatsapp' ? 'whatsapp' : 'telnyx']
    if (order.call_status === 'review') channel.review++
    else if (order.call_status === 'unanswered') channel.noDecision++
    else if (order.call_status === 'completed') channel.completed++
    else channel.active++
  }
  for (const invite of invites) {
    if (invite.status === 'pending' || invite.status === 'working') invitations.queued++
    else if (invite.status === 'done') {
      if (invite.provider_acknowledged) invitations.acknowledged++
      else invitations.legacyProcessed++
    }
    else if (invite.status === 'failed') invitations.failed++
    else if (invite.status === 'skipped') invitations.skipped++
  }
  const failedIds = invites.filter(invite => invite.status === 'failed').slice(0, 8).map(invite => invite.order_id)
  if (failedIds.length) {
    const records = await store.collection<OrderSummary>('orders').find({ id: { $in: failedIds } }, { projection: { id: 1, reference: 1, created_at: 1 } }).toArray()
    const byId = new Map(records.map(order => [order.id, order]))
    for (const id of failedIds) {
      const order = byId.get(id)
      if (order) failed.push({ id, reference: order.reference, createdAt: order.created_at })
    }
  }
  for (const call of calls) {
    callCount++
    callSeconds += call.duration_seconds ?? 0
    const day = byDate.get(call.started_at.slice(0, 10))
    if (day) { day.calls++; day.minutes += (call.duration_seconds ?? 0) / 60 }
    const amount = call.cost_amount == null ? null : toUnits(call.cost_amount)
    if (amount == null) {
      if (call.ended_at) pendingCosts++
    } else {
      const currency = call.currency || 'Unspecified'
      charges.set(currency, (charges.get(currency) ?? 0) + amount)
    }
  }
  return { days, daily, outcomes, invitations, callbacks, pending, failed, usage: {
    calls: callCount, seconds: callSeconds, pendingCosts, charges: [...charges].map(([currency, units]) => ({ currency, amount: fromUnits(units) })),
  } }
}
