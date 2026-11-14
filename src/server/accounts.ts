import type { AuthUser } from './auth.ts'
import { store, nextId, transaction } from './store.ts'
import { fromUnits, priceUnits, purchaseBlock, toUnits } from './logic.ts'
import { orderPhoneNumber, searchAvailableNumbers } from './telnyx.ts'

export async function balanceOf(userId: number) {
  return Number((await store.collection('users').findOne({ id: userId }))?.balance_units ?? 0)
}
export async function dashboardFor(userId: number) {
  const balance = await balanceOf(userId)
  const [spent] = await store.collection('ledger').aggregate([{ $match: { user_id: userId, amount_units: { $lt: 0 } } }, { $group: { _id: null, units: { $sum: { $multiply: ['$amount_units', -1] } } } }]).toArray()
  const [time] = await store.collection('calls').aggregate([{ $match: { user_id: userId } }, { $group: { _id: null, seconds: { $sum: '$duration_seconds' }, pending: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'hangup'] }, { $eq: ['$cost_amount', null] }] }, 1, 0] } } } }]).toArray()
  const destinations = await store.collection('calls').aggregate([
    { $match: { user_id: userId, cost_amount: { $ne: null } } },
    { $group: { _id: { $ifNull: ['$to_number', 'Unknown'] }, calls: { $sum: 1 }, seconds: { $sum: '$duration_seconds' }, amount: { $sum: { $convert: { input: '$cost_amount', to: 'double', onError: 0, onNull: 0 } } } } },
    { $sort: { amount: -1 } }, { $limit: 12 },
  ]).toArray()
  const ledger = await store.collection('ledger').find({ user_id: userId }).sort({ id: -1 }).limit(40).toArray()
  return { balance: fromUnits(balance), spent: fromUnits(Number(spent?.units ?? 0)), durationSeconds: Number(time?.seconds ?? 0), pendingCostCount: Number(time?.pending ?? 0),
    byDestination: destinations.map(row => ({ destination: String(row._id), calls: Number(row.calls), durationSeconds: Number(row.seconds), amount: Number(row.amount).toFixed(4) })),
    ledger: ledger.map(row => ({ id: Number(row.id), kind: String(row.kind), amount: fromUnits(Number(row.amount_units)), note: row.note ?? null, createdAt: String(row.created_at) })),
  }
}

export async function requestCredit(userId: number, amount: string, note: string) {
  const units = toUnits(amount)
  if (units == null || units < 10000 || units > 10000 * 10000) fail(400, 'Enter an amount from 1.00 to 10000.00.')
  const id = await nextId('credit_requests')
  await store.collection('credit_requests').insertOne({ id, user_id: userId, amount_units: units, note: note.slice(0, 280) || null, status: 'pending', created_at: new Date().toISOString(), decided_at: null, decided_by: null })
  return creditJson(id)
}
export async function listCredits(user: AuthUser) {
  const rows = await store.collection<CreditRow>('credit_requests').find(user.role === 'admin' ? {} : { user_id: user.id }).sort({ id: -1 }).limit(100).toArray()
  return Promise.all(rows.map(async row => creditView({ ...row, ...await creditUser(row.user_id) })))
}
export async function decideCredit(adminId: number, requestId: number, approve: boolean) {
  await transaction(async session => {
    const row = await store.collection<CreditRow>('credit_requests').findOne({ id: requestId }, { session })
    if (!row) fail(404, 'No credit request with that id.')
    if (row.status !== 'pending') fail(400, 'That request is already decided.')
    await store.collection('credit_requests').updateOne({ id: requestId }, { $set: { status: approve ? 'approved' : 'rejected', decided_at: new Date().toISOString(), decided_by: adminId } }, { session })
    if (approve) {
      await store.collection('users').updateOne({ id: row.user_id }, { $inc: { balance_units: row.amount_units } }, { session })
      await store.collection('ledger').insertOne({ id: await nextId('ledger', session), user_id: row.user_id, amount_units: row.amount_units, kind: 'credit', ref: String(requestId), note: 'Approved credit', created_at: new Date().toISOString() }, { session })
    }
  })
  return creditJson(requestId)
}

export async function gallery(query: { country?: string, area?: string, contains?: string }) {
  const country = (query.country || 'US').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) fail(400, 'Use a two-letter country code.')
  return searchAvailableNumbers({ country, area: query.area?.trim() || '', contains: query.contains?.trim() || '' })
}

export async function myNumbers(userId: number) {
  return store.collection('owned_numbers').find({ user_id: userId }, { projection: { _id: 0, user_id: 0 } }).sort({ ordered_at: -1 }).toArray()
}
export async function buyNumber(user: AuthUser, phoneNumber: string, country: string) {
  const number = phoneNumber.trim(), code = country.trim().toUpperCase()
  if (!/^\+\d{8,15}$/.test(number)) fail(400, 'Choose a number from the gallery.')
  if (!/^[A-Z]{2}$/.test(code)) fail(400, 'Use a two-letter country code.')
  if (await store.collection('owned_numbers').findOne({ phone_number: number })) fail(400, 'That number is already on an account.')
  if (await balanceOf(user.id) <= 0) fail(402, 'Your balance is $0.00. Request credit and wait for approval before buying a number.')
  const quote = await searchAvailableNumbers({ country: code, contains: number.replace(/\D/g, ''), limit: 10 })
  const match = quote.find(item => item.phoneNumber === number)
  if (!match) fail(400, 'That number is no longer available.')
  const upfront = priceUnits(match.upfrontCost) ?? 0, monthly = priceUnits(match.monthlyCost) ?? 0
  const charge = upfront > 0 ? upfront : monthly
  // Reserve the balance and number before making the external purchase.
  await transaction(async session => {
    const account = await store.collection('users').findOne({ id: user.id }, { session })
    const blocked = purchaseBlock(Number(account?.balance_units ?? 0), match.upfrontCost, match.monthlyCost)
    if (blocked) fail(blocked.status, blocked.message)
    await store.collection('owned_numbers').insertOne({ phone_number: number, user_id: user.id, region: match.region || null, upfront_cost: match.upfrontCost, monthly_cost: match.monthlyCost, currency: match.currency, ordered_at: new Date().toISOString(), order_status: 'pending' }, { session })
    if (charge > 0) await store.collection('users').updateOne({ id: user.id }, { $inc: { balance_units: -charge } }, { session })
  })
  try {
    await orderPhoneNumber(number)
  } catch (error) {
    // A timeout may still mean Telnyx accepted the order; retain the reservation for reconciliation.
    await store.collection('owned_numbers').updateOne({ phone_number: number }, { $set: { order_status: 'review' } })
    throw error
  }
  await transaction(async session => {
    await store.collection('owned_numbers').updateOne({ phone_number: number }, { $set: { order_status: 'ordered' } }, { session })
    if (charge > 0) await store.collection('ledger').insertOne({ id: await nextId('ledger', session), user_id: user.id, amount_units: -charge, kind: 'number', ref: number, note: 'Number purchase', created_at: new Date().toISOString() }, { session })
  })
  return { phoneNumber: number, charged: fromUnits(charge) }
}

type CreditRow = { id: number, user_id: number, amount_units: number, note: string | null, status: string, created_at: string, decided_at: string | null, email?: string, name?: string }
async function creditUser(id: number) {
  const user = await store.collection('users').findOne({ id })
  return { email: user?.email as string | undefined, name: user?.name as string | undefined }
}
async function creditJson(id: number) {
  const row = await store.collection<CreditRow>('credit_requests').findOne({ id })
  if (!row) fail(404, 'No credit request with that id.')
  return creditView({ ...row, ...await creditUser(row.user_id) })
}
function creditView(row: CreditRow) {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email ?? null,
    name: row.name ?? null,
    amount: fromUnits(row.amount_units),
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }
}

function fail(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = statusCode
  throw error
}
