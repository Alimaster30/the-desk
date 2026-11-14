import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mock, test, after } from 'node:test'
import type { Document } from 'mongodb'

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'
process.env.APP_TEST = '1'
const { store, client } = await import('./store.ts')
const { app } = await import('./index.ts')
const { decideCredit } = await import('./accounts.ts')
const { setCallCost, upsertCall } = await import('./db.ts')
let tables: Record<string, Document[]> = {}
const collection = (name: string) => {
  const rows = tables[name] ??= []
  const match = (filter: Document) => rows.find(row => Object.entries(filter).every(([key, value]) => row[key] === value))
  const update = (row: Document, change: Document) => {
    Object.assign(row, change.$set)
    for (const [key, value] of Object.entries(change.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
  }
  return {
    findOne: async (filter: Document) => structuredClone(match(filter) ?? null),
    insertOne: async (row: Document) => { rows.push(structuredClone(row)); return { acknowledged: true } },
    updateOne: async (filter: Document, change: Document) => { const row = match(filter); if (row) update(row, change) },
    findOneAndUpdate: async (filter: Document, change: Document) => {
      let row = match(filter)
      if (!row) { row = { ...filter }; rows.push(row) }
      update(row, change)
      return structuredClone(row)
    },
  }
}
mock.method(store, 'collection', collection as unknown as typeof store.collection)
mock.method(client, 'withSession', (async (work: (session: unknown) => unknown) => work({ withTransaction: (operation: () => unknown) => operation() })) as typeof client.withSession)
after(async () => { await app.close(); mock.restoreAll() })

test('Mongo authentication preserves role checks and hides password hashes', async () => {
  const password = 'test-password', salt = 'test-salt'
  const password_hash = `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
  tables = { users: [
    { id: 1, email: 'admin@example.test', name: 'Admin', role: 'admin', balance_units: 0, password_hash },
    { id: 2, email: 'user@example.test', name: 'User', role: 'user', balance_units: 0, password_hash },
  ] }
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.test', password: 'wrong' } })
  assert.equal(wrong.statusCode, 401)
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.test', password } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().role, 'user')
  assert.equal(response.json().password_hash, undefined)
  const cookie = String(response.headers['set-cookie']).split(';')[0]
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json().email, 'user@example.test')
  assert.equal((await app.inject({ url: '/api/whatsapp/status', headers: { cookie } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/billing/requests/1/approve', headers: { cookie } })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/dashboard' })).statusCode, 401)
  const admin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.test', password } })
  const adminCookie = String(admin.headers['set-cookie']).split(';')[0]
  assert.equal((await app.inject({ url: '/api/whatsapp/status', headers: { cookie: adminCookie } })).statusCode, 200)
})

test('a repeated credit approval cannot credit the balance twice', async () => {
  tables = { users: [{ id: 2, balance_units: 0 }], credit_requests: [{ id: 7, user_id: 2, amount_units: 25000, status: 'pending' }] }
  await decideCredit(1, 7, true)
  await assert.rejects(decideCredit(1, 7, true), /already decided/)
  assert.equal(tables.users[0].balance_units, 25000)
  assert.equal(tables.ledger.length, 1)
})

test('a repeated call cost cannot debit the balance twice', async () => {
  tables = { users: [{ id: 2, balance_units: 100000 }], calls: [{ id: 9, user_id: 2, charged: 0, billable_seconds: null }] }
  await setCallCost(9, '0.1250', 'USD', 60)
  await setCallCost(9, '0.1250', 'USD', 60)
  assert.equal(tables.users[0].balance_units, 98750)
  assert.equal(tables.ledger.length, 1)
  assert.equal(tables.calls[0].charged, 1)
})

test('cost arriving before call ownership is charged when ownership is attached', async () => {
  tables = { users: [{ id: 2, balance_units: 100000 }], calls: [{ id: 9, call_session_id: 'late-owner', user_id: null, charged: 0, billable_seconds: null }] }
  await setCallCost(9, '0.1250', 'USD', 60)
  assert.equal(tables.calls[0].charged, 0)
  await upsertCall({ callSessionId: 'late-owner' }, 2)
  assert.equal(tables.users[0].balance_units, 98750)
  assert.equal(tables.ledger.length, 1)
  await assert.rejects(upsertCall({ callSessionId: 'late-owner' }, 3), /No call with that id/)
})
