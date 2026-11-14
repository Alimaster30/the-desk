export type TelnyxCall = {
  id?: string
  state?: string
  cause?: string
  hangupCause?: string
  hangup?: () => void | Promise<void>
  hold?: () => Promise<unknown>
  unhold?: () => Promise<unknown>
  muteAudio?: () => void
  unmuteAudio?: () => void
  dtmf?: (digit: string) => void
  localStream?: MediaStream
  remoteStream?: MediaStream
  options?: { destinationNumber?: string, callerNumber?: string }
  telnyxIDs?: { telnyxSessionId?: string, telnyxLegId?: string, telnyxCallControlId?: string }
}

type RtcClient = {
  remoteElement: string
  connect: () => void
  disconnect?: () => void
  newCall: (options: { destinationNumber: string, callerNumber: string }) => TelnyxCall
  on: (event: string, handler: (value: unknown) => void) => void
}

const listeners = new Set<(call: TelnyxCall) => void>()
const times = new Map<string, { startedAt: string, answeredAt?: string, endedAt?: string }>()

let client: RtcClient | null = null
let callerNumber = ''
let connecting: Promise<void> | null = null
let currentCall: TelnyxCall | null = null
let generation = 0

export const phoneRuntime = {
  async create(token: string): Promise<RtcClient> {
    const sdk = await import('@telnyx/webrtc')
    const TelnyxRTC = sdk.TelnyxRTC as new (options: { login_token: string }) => RtcClient
    return new TelnyxRTC({ login_token: token })
  },
}

export function onCallUpdate(listener: (call: TelnyxCall) => void) {
  listeners.add(listener)
  if (currentCall) listener(currentCall)
  return () => listeners.delete(listener)
}

export async function placeCall(destination: string) {
  const attempt = generation
  await ensureClient()
  if (attempt !== generation || !client) throw new Error('Call setup was cancelled.')
  if (currentCall) throw new Error('End the current call before starting another.')
  const call = client.newCall({ destinationNumber: destination, callerNumber })
  currentCall = call
  for (const listener of listeners) listener(call)
  return call
}

export async function resetPhone() {
  generation++
  const ending = currentCall
  if (ending) {
    await ending.hangup?.()
    await track({ ...ending, state: 'hangup' }).catch(() => undefined)
  }
  const previous = client
  client = null; connecting = null; currentCall = null; callerNumber = ''
  previous?.disconnect?.()
}

export async function setCallHold(call: TelnyxCall, held: boolean) {
  const action = held ? call.hold : call.unhold
  if (!action || await action.call(call) === false) throw new Error(held ? 'Could not put the call on hold.' : 'Could not resume the call.')
}

async function ensureClient() {
  const attempt = generation
  if (client && connecting) {
    await connecting
    return
  }
  const response = await fetch('/api/telephony/token', { method: 'POST' })
  const body = await response.json() as { token?: string, callerNumber?: string, error?: string }
  if (!response.ok || !body.token || !body.callerNumber) {
    throw new Error(body.error || 'Telnyx login failed.')
  }
  if (attempt !== generation) throw new Error('Call setup was cancelled.')
  const connection = await phoneRuntime.create(body.token)
  if (attempt !== generation) { connection.disconnect?.(); throw new Error('Call setup was cancelled.') }
  callerNumber = body.callerNumber
  client = connection
  client.remoteElement = 'remote-audio'
  connecting = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Telnyx did not register. Check the connection id and caller number.')), 20000)
    client!.on('telnyx.ready', () => {
      window.clearTimeout(timeout)
      resolve()
    })
    client!.on('telnyx.error', (error: unknown) => {
      window.clearTimeout(timeout)
      reject(error instanceof Error ? error : new Error('Telnyx rejected the login.'))
    })
    client!.on('telnyx.notification', (notification: unknown) => {
      const update = notification as { type?: string, call?: TelnyxCall }
      if (client === connection && update.type === 'callUpdate' && update.call) void track(update.call).catch(() => console.error('The call record could not be saved.'))
    })
  })
  try {
    client.connect()
    await connecting
  } catch (error) {
    if (client === connection) { client = null; connecting = null }
    throw error
  }
}

async function track(call: TelnyxCall) {
  const id = call.id || 'current'
  const now = new Date().toISOString()
  const row = times.get(id) ?? { startedAt: now }
  const status = mapState(call.state)
  currentCall = status === 'hangup' || status === 'failed' ? null : call
  if (status === 'answered' && !row.answeredAt) row.answeredAt = now
  if ((status === 'hangup' || status === 'failed') && !row.endedAt) row.endedAt = now
  times.set(id, row)
  for (const listener of listeners) listener(call)
  const ids = call.telnyxIDs ?? {}
  const response = await fetch('/api/calls/sync', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientCallId: call.id ?? null,
      callSessionId: ids.telnyxSessionId ?? null,
      callLegId: ids.telnyxLegId ?? null,
      callControlId: ids.telnyxCallControlId ?? null,
      direction: 'outbound',
      from: call.options?.callerNumber ?? callerNumber,
      to: call.options?.destinationNumber ?? null,
      status,
      startedAt: row.startedAt,
      answeredAt: row.answeredAt ?? null,
      endedAt: row.endedAt ?? null,
      hangupCause: call.cause || call.hangupCause || null,
    }),
  })
  if (!response.ok) throw new Error('The call record could not be saved.')
}

export function mapState(state: string | undefined) {
  if (state === 'active' || state === 'answered' || state === 'held') return 'answered'
  if (state === 'hangup' || state === 'destroy' || state === 'purge') return 'hangup'
  if (state === 'ringing' || state === 'early' || state === 'answering') return 'ringing'
  if (state === 'failed' || state === 'busy' || state === 'rejected') return 'failed'
  return 'initiated'
}

export function stateLabel(state: string | undefined) {
  const status = mapState(state)
  if (!state) return 'Idle'
  if (state === 'held') return 'On hold'
  if (status === 'answered') return 'On the call'
  if (status === 'ringing') return 'Ringing'
  if (status === 'hangup') return 'Call ended'
  if (status === 'failed') return 'Call failed'
  return 'Placing the call'
}
