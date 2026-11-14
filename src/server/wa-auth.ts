import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from 'baileys'
import { store } from './store.ts'
import { randomUUID } from 'node:crypto'

const fileKey = (key: string) => key.replace(/\//g, '__').replace(/:/g, '-')

export async function mongoAuthState(fresh = false) {
  const collection = store.collection<{ key: string, data: string }>('wa_auth')
  const active = await collection.findOne({ key: 'active-session' })
  let prefix: string = active ? JSON.parse(active.data) : ''
  if (typeof prefix !== 'string') throw new Error('Invalid WhatsApp session metadata.')
  if (fresh) {
    prefix = `${randomUUID()}-`
    await collection.updateOne({ key: 'active-session' }, { $set: { data: JSON.stringify(prefix) } }, { upsert: true })
  }
  const authKey = (key: string) => fileKey(`${prefix}${key}`)
  const read = async (key: string) => {
    const row = await collection.findOne({ key: authKey(key) })
    return row ? JSON.parse(row.data, BufferJSON.reviver) : null
  }
  const write = async (key: string, value: unknown) => {
    await collection.updateOne({ key: authKey(key) }, { $set: { data: JSON.stringify(value, BufferJSON.replacer) } }, { upsert: true })
  }
  const creds = await read('creds.json') || initAuthCreds()
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result: { [id: string]: SignalDataTypeMap[typeof type] } = {}
        for (const id of ids) {
          let value = await read(`${type}-${id}.json`)
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
          result[id] = value
        }
        return result
      },
      set: async data => {
        for (const category in data) {
          const entries = data[category as keyof SignalDataTypeMap]
          for (const id in entries) {
            const value = entries[id], key = `${category}-${id}.json`
            if (value) await write(key, value)
            else await collection.deleteOne({ key: authKey(key) })
          }
        }
      },
    },
  }
  return { state, saveCreds: () => write('creds.json', creds) }
}

// Revoke the previous text-only device when upgrading an existing installation.
export async function logoutLegacyWhatsApp() {
  const { state } = await mongoAuthState()
  if (!state.creds.registered || !state.creds.me) return true
  const baileys = await import('baileys')
  const { default: pino } = await import('pino')
  const socket = baileys.default({ auth: state, logger: pino({ level: 'silent' }) })
  try {
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 12000)
      socket.ev.on('connection.update', update => {
        if (update.connection === 'open') void socket.logout().then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(false) })
        else if (update.connection === 'close') { clearTimeout(timer); resolve((update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode === 401) }
      })
    })
  } finally { socket.end(new Error('Legacy WhatsApp device cleanup finished.')) }
}
