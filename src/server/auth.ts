import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { store, nextId } from './store.ts'

export type AuthUser = {
  id: number
  email: string
  name: string
  role: 'admin' | 'user'
  orderAccess: boolean
  balanceUnits: number
}

type UserRow = {
  id: number
  email: string
  name: string
  password_hash: string
  role: string
  order_access?: boolean
  balance_units: number
  created_at: string
}

const COOKIE = 'desk_session'

export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    orderAccess: user.orderAccess,
    balanceUnits: user.balanceUnits,
  }
}

export async function signup(input: { email: string, name: string, password: string }) {
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email.')
  if (name.length < 2) fail(400, 'Enter your name.')
  if (input.password.length < 8) fail(400, 'Use a password of at least 8 characters.')
  const existing = await store.collection<UserRow>('users').findOne({ email })
  if (existing) fail(400, 'An account with that email already exists.')
  const id = await nextId('users')
  try {
    await store.collection<UserRow>('users').insertOne({ id, email, name, password_hash: hashPassword(input.password), role: 'user', balance_units: 0, created_at: new Date().toISOString() })
  } catch (error) {
    if ((error as { code?: number }).code === 11000) fail(400, 'An account with that email already exists.')
    throw error
  }
  return sessionFor(id)
}

export async function login(email: string, password: string) {
  const row = await store.collection<UserRow>('users').findOne({ email: email.trim().toLowerCase() })
  if (!row || !verifyPassword(password, row.password_hash)) fail(401, 'Email or password is wrong.')
  return sessionFor(row.id)
}

export async function logout(token: string) {
  if (token) await store.collection('sessions').deleteOne({ token })
}

export async function userFromToken(token: string): Promise<AuthUser | null> {
  if (!token) return null
  const session = await store.collection('sessions').findOne({ token })
  const row = session ? await store.collection<UserRow>('users').findOne({ id: session.user_id }) : null
  return row ? toUser(row) : null
}

export async function listOrderStaff() {
  const rows = await store.collection<UserRow>('users').find({ role: 'user', order_access: true }, {
    projection: { _id: 0, id: 1, name: 1, email: 1 },
  }).sort({ email: 1 }).toArray()
  return rows.map(({ id, name, email }) => ({ id, name, email }))
}

export async function setOrderAccess(email: string, allowed: boolean) {
  const result = await store.collection<UserRow>('users').updateOne(
    { email: email.trim().toLowerCase(), role: 'user' }, { $set: { order_access: allowed } },
  )
  if (!result.matchedCount) fail(404, 'No regular account found for that email.')
}

export function readSession(cookieHeader: string | undefined) {
  if (!cookieHeader) return ''
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return decodeURIComponent(rest.join('='))
  }
  return ''
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 30) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`
}

async function sessionFor(userId: number) {
  const token = randomBytes(32).toString('hex')
  await store.collection('sessions').insertOne({ token, user_id: userId, created_at: new Date().toISOString() })
  const row = (await store.collection<UserRow>('users').findOne({ id: userId }))!
  return { token, user: toUser(row) }
}

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === 'admin' ? 'admin' : 'user',
    orderAccess: row.role === 'admin' || row.order_access === true,
    balanceUnits: row.balance_units,
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const next = scryptSync(password, salt, 32)
  const current = Buffer.from(hash, 'hex')
  return current.length === next.length && timingSafeEqual(current, next)
}

function fail(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = statusCode
  throw error
}
