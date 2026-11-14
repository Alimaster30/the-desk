import { MongoClient, type ClientSession } from 'mongodb'
import { loadEnv, required } from './env.ts'

loadEnv()
export const client = new MongoClient(required('MONGODB_URI'), { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 })
export const store = client.db(process.env.MONGODB_DB?.trim() || 'agentic_desk')

export async function connectDatabase() {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Atlas connection timed out. Check DNS, network access, and the Atlas IP access list.')), 15000) }),
    ])
    await store.command({ ping: 1 })
  } finally { clearTimeout(timer) }
}

export async function nextId(name: string, session?: ClientSession) {
  const row = await store.collection<{ _id: string, value: number }>('counters').findOneAndUpdate(
    { _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session },
  )
  return row!.value
}

export async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  return client.withSession(session => session.withTransaction(() => work(session)))
}

export async function ensureIndexes() {
  for (const [name, fields] of Object.entries({
    users: ['id', 'email'], sessions: ['token'], calls: ['id'], wa_messages: ['id', 'wa_message_id'],
    wa_chats: ['jid'], wa_replies: ['inbound_id'], app_settings: ['key'],
    credit_requests: ['id'], ledger: ['id'], owned_numbers: ['phone_number'], wa_auth: ['key'], migration_state: ['name'],
    orders: ['id', 'reference'], order_jobs: ['key'], order_events: ['key'],
    sms_messages: ['id'], sms_sends: ['key'], sms_media: ['token'],
  })) {
    for (const field of fields) await store.collection(name).createIndex({ [field]: 1 }, { unique: true })
  }
  for (const field of ['client_call_id', 'call_session_id']) {
    await store.collection('calls').createIndex({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } })
  }
  await store.collection('wa_messages').createIndex({ chat_jid: 1, timestamp: 1 })
  await store.collection('sms_chats').createIndex({ user_id: 1, line: 1, remote: 1 }, { unique: true })
  await store.collection('sms_chats').createIndex({ user_id: 1, last_at: -1 })
  await store.collection('sms_messages').createIndex({ user_id: 1, line: 1, remote: 1, timestamp: -1 })
  await store.collection('calls').createIndex({ user_id: 1, started_at: -1 })
  await store.collection('orders').createIndex({ user_id: 1, created_at: -1 })
  await store.collection('orders').createIndex({ created_at: -1 })
  await store.collection('calls').createIndex({ started_at: -1 })
  await store.collection('order_jobs').createIndex({ kind: 1, available_at: -1 })
  await store.collection('order_jobs').createIndex({ status: 1, priority: -1, available_at: 1 })
  await store.collection('order_jobs').createIndex({ phone: 1, kind: 1, available_at: -1 })
}
