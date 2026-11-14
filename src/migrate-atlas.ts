import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { client, store, connectDatabase, ensureIndexes, transaction } from './server/store.ts'

const primaryKeys: Record<string, string> = {
  users: 'id', sessions: 'token', calls: 'id', credit_requests: 'id', ledger: 'id',
  owned_numbers: 'phone_number', wa_chats: 'jid', wa_messages: 'id', wa_replies: 'inbound_id', app_settings: 'key',
}
const source = new DatabaseSync('data/app.db', { readOnly: true })
let exitCode = 0
try {
  source.exec('BEGIN EXCLUSIVE')
  const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  assert.deepEqual(tables.map(row => row.name).sort(), Object.keys(primaryKeys).sort(), 'Unknown SQLite tables; update migration before proceeding.')
  const snapshot: Record<string, Record<string, unknown>[]> = {}
  for (const table of Object.keys(primaryKeys)) snapshot[table] = source.prepare(`SELECT * FROM ${table}`).all()
  snapshot.wa_auth = existsSync('data/baileys-auth') ? readdirSync('data/baileys-auth').filter(name => name.endsWith('.json')).map(key => {
    const data = readFileSync(`data/baileys-auth/${key}`, 'utf8')
    JSON.parse(data)
    return { key, data }
  }) : []
  if (existsSync('data/telnyx-credential-id')) {
    const value = readFileSync('data/telnyx-credential-id', 'utf8').trim()
    if (value && !snapshot.app_settings.some(row => row.key === 'telnyx_credential_id')) snapshot.app_settings.push({ key: 'telnyx_credential_id', value })
  }
  const counts = Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]))
  console.log(JSON.stringify({ database: store.databaseName, sourceCounts: counts }))
  if (!process.argv.includes('--dry-run')) {
    await connectDatabase()
    const marker = await store.collection('migration_state').findOne({ name: 'sqlite-v1', complete: true })
    if (marker) {
      console.log('Migration already completed. No records were overwritten.')
    } else {
      await ensureIndexes()
      for (const table of Object.keys(snapshot)) assert.equal(await store.collection(table).countDocuments(), 0, `${table} is not empty; refusing to overwrite Atlas data.`)
      mkdirSync('data/migration-backups', { recursive: true })
      const backup = `data/migration-backups/app-${Date.now()}.db`
      copyFileSync('data/app.db', backup)
      await transaction(async session => {
        for (const [table, rows] of Object.entries(snapshot)) {
          if (rows.length) await store.collection(table).insertMany(rows.map(row => ({ ...row })), { session })
          assert.equal(await store.collection(table).countDocuments({}, { session }), rows.length, `${table}: count mismatch`)
          const key = primaryKeys[table] || 'key'
          const saved = await store.collection(table).find({}, { projection: { _id: 0 }, session }).toArray()
          const byKey = new Map(saved.map(row => [row[key], row]))
          // SQLite rows have a null prototype; MongoDB returns plain objects.
          for (const row of rows) assert.deepEqual(byKey.get(row[key]), { ...row }, `${table}: record differs`)
          if (key === 'id') await store.collection<{ _id: string, value: number }>('counters').updateOne({ _id: table }, { $max: { value: rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) } }, { upsert: true, session })
        }
        await store.collection('migration_state').insertOne({ name: 'sqlite-v1', complete: true, completed_at: new Date().toISOString(), counts, backup }, { session })
      })
      for (const [table, count] of Object.entries(counts)) assert.equal(await store.collection(table).countDocuments(), count, `${table}: post-commit count mismatch`)
      console.log(JSON.stringify({ migrated: true, verified: true, counts, backup }))
    }
  }
} catch (error) {
  exitCode = 1
  console.error(error instanceof Error ? error.message : 'Atlas migration failed')
} finally {
  source.close()
  await Promise.race([client.close(), new Promise(resolve => setTimeout(resolve, 1000))])
  process.exit(exitCode)
}
