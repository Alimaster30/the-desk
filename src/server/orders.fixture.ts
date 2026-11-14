import { mock } from 'node:test'
import type { Document } from 'mongodb'
import { client, store } from './store.ts'

// Test-only Mongo substitute: provider workflow tests never connect to Atlas.
export function orderTestStore() {
  let tables: Record<string, Document[]> = {}
  let transactionQueue = Promise.resolve()
  const matches = (row: Document, filter: Document): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return (value as Document[]).some(item => matches(row, item))
    if (value && typeof value === 'object') return Object.entries(value).every(([operator, operand]) => {
      if (operator === '$lte' && typeof operand === 'string') return String(row[key]) <= operand
      if (operator === '$gte' && typeof operand === 'string') return typeof row[key] === 'string' && row[key] >= operand
      if (operator === '$lt' && typeof operand === 'string') return String(row[key]) < operand
      if (operator === '$in') return (operand as unknown[]).includes(row[key])
      if (operator === '$ne') return row[key] !== operand
      throw new Error(`Unsupported fixture operator ${operator}`)
    })
    return row[key] === value
  })
  const changeRow = (row: Document, change: Document, insert = false) => {
    if (insert) Object.assign(row, structuredClone(change.$setOnInsert || {}))
    Object.assign(row, structuredClone(change.$set || {}))
    for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] || 0) + Number(value)
  }
  const sortRows = (rows: Document[], sort: Document) => rows.sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * Number(direction)
    return 0
  })
  const collection = (name: string) => {
    const rows = () => tables[name] ??= []
    const insert = (row: Document) => {
      const unique = name === 'orders' ? ['id', 'reference'] : ['order_events', 'order_jobs', 'sms_sends'].includes(name) ? ['key'] : name === 'sms_messages' ? ['id'] : name === 'sms_media' ? ['token'] : []
      if (name === 'sms_chats' && rows().some(existing => ['user_id', 'line', 'remote'].every(field => existing[field] === row[field]))) throw Object.assign(new Error('Duplicate key'), { code: 11000 })
      if (rows().some(existing => unique.some(field => existing[field] === row[field]))) throw Object.assign(new Error('Duplicate key'), { code: 11000 })
      rows().push(structuredClone(row))
    }
    return {
      findOne: async (filter: Document, options: Document = {}) => structuredClone(sortRows(rows().filter(row => matches(row, filter)), options.sort || {})[0] ?? null),
      insertOne: async (row: Document) => { insert(row); return { acknowledged: true } },
      deleteOne: async (filter: Document) => {
        const index = rows().findIndex(row => matches(row, filter))
        if (index < 0) return { deletedCount: 0 }
        rows().splice(index, 1)
        return { deletedCount: 1 }
      },
      deleteMany: async (filter: Document) => {
        const selected = rows().filter(row => matches(row, filter))
        tables[name] = rows().filter(row => !matches(row, filter))
        return { deletedCount: selected.length }
      },
      updateOne: async (filter: Document, change: Document, options: Document = {}) => {
        const row = rows().find(row => matches(row, filter))
        if (row) { changeRow(row, change); return { matchedCount: 1 } }
        if (options.upsert) { const added = { ...filter }; changeRow(added, change, true); insert(added) }
        return { matchedCount: 0 }
      },
      findOneAndUpdate: async (filter: Document, change: Document, options: Document = {}) => {
        const row = sortRows(rows().filter(row => matches(row, filter)), options.sort || {})[0]
        if (row) { const before = structuredClone(row); changeRow(row, change); return structuredClone(options.returnDocument === 'after' ? row : before) }
        if (!options.upsert) return null
        const added = { ...filter }; changeRow(added, change, true); insert(added); return structuredClone(added)
      },
      find: (filter: Document = {}) => {
        let selected = rows().filter(row => matches(row, filter))
        const cursor = { sort: (sort: Document) => { selected = sortRows(selected, sort); return cursor }, limit: (limit: number) => { selected = selected.slice(0, limit); return cursor }, toArray: async () => structuredClone(selected) }
        return cursor
      },
    }
  }
  mock.method(store, 'collection', collection as unknown as typeof store.collection)
  mock.method(client, 'withSession', (async (work: (session: unknown) => Promise<unknown>) => {
    const previous = transactionQueue
    let release!: () => void
    transactionQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    const snapshot = structuredClone(tables)
    try { return await work({ withTransaction: (operation: () => unknown) => operation() }) }
    catch (error) { tables = snapshot; throw error }
    finally { release() }
  }) as typeof client.withSession)
  return { get tables() { return tables }, reset(seed: Record<string, Document[]> = {}) { tables = structuredClone(seed) } }
}
