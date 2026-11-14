import { useEffect, useRef, useState, type FormEvent } from 'react'
import { PageHeading, EmptyState, Icon } from './ui'
import { OrderAutomationMenu } from './OrderAutomationMenu'

type Order = {
  id: string; reference: string; phone: string; channel: 'sms' | 'whatsapp'; language: 'en' | 'ur'
  item: string; amount: string; currency: string; status: string; call_status: string
  attempt_id: string | null; last_error: string | null; message: string; created_at: string
  customer?: { name: string | null; address: string | null; notes: string | null }
  call_mode?: CallMode
  invitationStatus: 'pending' | 'working' | 'done' | 'failed' | 'skipped' | 'processed' | null
}
type CallMode = 'ivr' | 'voice' | 'whatsapp'
type Setup = { enabled: boolean; missing: string[]; configurationError: string; whatsAppReady?: boolean; textAgent?: { enabled: boolean; ready: boolean; model: string }; voice?: { enabled: boolean; ready: boolean }; audio: { en: boolean; ur: boolean }; menus: { en: string; ur: string } }
type Action = { key: string; kind: string; status: string; error?: string }
const invitationLabels = { pending: 'Queued', working: 'Sending', done: 'Provider acknowledged', failed: 'Needs review', skipped: 'Skipped', processed: 'Processed' }

async function json<T>(response: Response): Promise<T> {
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Request failed.')
  return result
}

export function OrdersPage({ admin, selectedOrder }: { admin: boolean; selectedOrder?: string }) {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [controlBusy, setControlBusy] = useState(false)
  const [controlError, setControlError] = useState('')
  const controlRevision = useRef(0)
  const loadRevision = useRef(0)
  const changingControls = useRef(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [consent, setConsent] = useState<Record<string, CallMode>>({})
  const [callMode, setCallMode] = useState<Record<string, CallMode>>({})
  const [log, setLog] = useState<{ id: string; actions: Action[] } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'review'>('all')
  const [queued, setQueued] = useState<Record<string, boolean>>({})

  async function load() {
    const request = ++loadRevision.current
    const revision = controlRevision.current
    const url = selectedOrder ? `/api/orders?order=${encodeURIComponent(selectedOrder)}` : '/api/orders'
    try {
      const [rows, state] = await Promise.all([fetch(url).then(json<Order[]>), fetch('/api/orders/setup').then(json<Setup>)])
      if (request !== loadRevision.current) return
      setOrders(rows)
      if (revision === controlRevision.current && !changingControls.current) setSetup(state)
      setError('')
    } catch (reason) {
      if (request !== loadRevision.current || revision !== controlRevision.current || changingControls.current) return
      setOrders(null); setSetup(null)
      throw reason
    }
  }
  async function toggleControl(key: 'enabled' | 'text' | 'voice', value: boolean) {
    if (!admin || changingControls.current) return
    changingControls.current = true; controlRevision.current++
    setControlBusy(true); setControlError('')
    try {
      const state = await json<Setup>(await fetch('/api/admin/order-controls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) }))
      setSetup(state)
    } catch (reason) { setControlError(reason instanceof Error ? reason.message : 'Could not save automation settings.') }
    finally { changingControls.current = false; controlRevision.current++; setControlBusy(false) }
  }
  useEffect(() => {
    let disposed = false
    const refresh = () => { if (!disposed) load().catch(reason => { if (!disposed) setError(reason.message) }) }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const startConfirmation = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'start'
    setBusy('create'); setError(''); setNotice('')
    try {
      const order = await json<Order>(await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), startConfirmation }) }))
      form.reset()
      setOrders(current => [order, ...(current || [])])
      setNotice(startConfirmation ? 'Order saved and confirmation message queued.' : 'Order saved. You can review its message before sending.')
      await load().catch(() => setError('The order was saved, but the list could not be refreshed. It will refresh automatically; do not create it again.'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the order.') }
    finally { setBusy('') }
  }

  async function action(order: Order, kind: 'invite' | 'call' | 'log') {
    setBusy(order.id); setError(''); setNotice('')
    try {
      if (kind === 'log') {
        const actions = await json<Action[]>(await fetch(`/api/orders/${order.id}/actions`))
        setLog({ id: order.id, actions })
      } else {
        const mode = callMode[order.id] || 'ivr'
        await json(await fetch(`/api/orders/${order.id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, customerRequestedCall: consent[order.id] === mode }) }))
        setQueued(current => ({ ...current, [`${order.id}:${kind}`]: true }))
        setNotice(kind === 'call' ? `Confirmation call queued for ${order.reference}.` : `Confirmation message queued for ${order.reference}.`)
        await load().catch(() => setError('The action was queued, but the list could not be refreshed. Check its action log; do not queue it again.'))
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The action could not be queued.') }
    finally { setBusy('') }
  }

  const callsConfigured = setup && !setup.missing.length && !setup.configurationError
  const whatsAppReady = Boolean(setup?.whatsAppReady)
  const visibleOrders = orders?.filter(order => {
    if (filter === 'pending' && order.status !== 'pending') return false
    if (filter === 'review' && !order.last_error && order.call_status !== 'review' && order.invitationStatus !== 'failed') return false
    return `${order.reference} ${order.phone} ${order.item} ${order.status}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  return (
    <main className="orders-page">
      <PageHeading title="Order confirmations" description={selectedOrder ? undefined : admin ? 'Track confirmation and follow-up across the organization.' : 'Start confirmations and follow up on your orders.'}>
        {selectedOrder ? <a href="#/orders">All orders</a> : null}
        <OrderAutomationMenu admin={admin} setup={setup} controlBusy={controlBusy} controlError={controlError} toggleControl={toggleControl} />
      </PageHeading>

      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!selectedOrder ? <section className="order-create" aria-labelledby="new-order-heading">
        <h2 id="new-order-heading">New order</h2>
        <p>Save the order for review, or start confirmation to queue the first message. Calls require a customer request.</p>
        <form onSubmit={create}>
          <fieldset disabled={Boolean(busy)}>
            <div className="order-fields">
              <label>Order reference<input name="reference" required maxLength={32} pattern="[A-Za-z0-9]([A-Za-z0-9]|-){0,31}" placeholder="ORD-123" /></label>
              <label>Customer phone<input name="phone" type="tel" required pattern="\+[1-9][0-9]{7,14}" placeholder="+923001234567" autoComplete="tel" /></label>
              <label className="order-item">Order details<input name="item" required maxLength={160} placeholder="2 cotton shirts, size medium" /></label>
              <label>Total<input name="amount" type="number" min="0.01" max="99999999.99" step="0.01" required placeholder="2500.00" /></label>
              <label>Currency<input name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" defaultValue="PKR" /></label>
              <label>Message channel<select name="channel" defaultValue="whatsapp"><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></label>
              <label>Language<select name="language" defaultValue="en"><option value="en">English</option><option value="ur">Urdu / اردو</option></select></label>
            </div>
            <div className="order-buttons">
              <button type="submit" value="save">{busy === 'create' ? 'Saving…' : 'Save order'}</button>
              <button className="primary" type="submit" value="start" disabled={!setup?.enabled}>Save and start confirmation</button>
            </div>
          </fieldset>
        </form>
      </section> : null}
      <details className="order-menu-preview">
        <summary>Preview the phone menu</summary>
        <p>The call refers to the details sent by message. Press 1 to confirm, 2 to cancel, or 9 to repeat.</p>
        {(['en', 'ur'] as const).map(language => <div key={language}>
          <h3>{language === 'en' ? 'English' : 'Urdu'}</h3>
          <p lang={language} dir={language === 'ur' ? 'rtl' : 'ltr'}>{setup?.menus[language]}</p>
          {setup?.audio[language] ? <audio controls preload="none" aria-label={`${language === 'en' ? 'English' : 'Urdu'} IVR menu`} src={`/api/order-audio/${language}.wav`} /> : <p>Menu recording has not been prepared yet.</p>}
        </div>)}
      </details>
      <section aria-labelledby="saved-orders-heading" aria-busy={orders === null}>
        <div className="section-head"><h2 id="saved-orders-heading">Saved orders</h2><span className="badge">{orders?.length || 0} orders</span></div>
        {!selectedOrder ? <>
          <div className="filter-tabs" aria-label="Order status filter">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All orders</button>
            <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Pending</button>
            <button type="button" aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>Needs review</button>
          </div>
          <label className="search-field"><span className="sr-only">Search orders</span><Icon name="search" size={16} /><input type="search" placeholder="Find by reference, customer number or item" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </> : null}
        {orders === null ? !error && <p className="waiting">Loading orders…</p> : !orders.length ? selectedOrder ? <p>Order unavailable.</p> : <EmptyState icon="orders" title="Your first order starts above">Register a customer order and start confirmation to queue the first message.</EmptyState> : !visibleOrders?.length ? <p>No orders match this search.</p> : visibleOrders.map(order => <details className="order-card" key={order.id} open={selectedOrder ? true : undefined}>
          <summary>
            <strong>{order.reference}</strong>
            <span className={`order-status order-status-${order.status}`}>{order.status === 'pending' ? 'Awaiting confirmation' : order.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</span>
            <span>{order.amount} {order.currency}</span>
          </summary>
          <p className="order-meta">{order.phone} · {order.channel === 'sms' ? 'SMS' : 'WhatsApp'} · {order.language === 'en' ? 'English' : 'Urdu'}</p>
          <p>{order.item}</p>
          {order.customer ? <div><h3>Customer-provided details</h3>{order.customer.name ? <p>Name: {order.customer.name}</p> : null}{order.customer.address ? <p>Address: {order.customer.address}</p> : null}{order.customer.notes ? <p>Delivery note: {order.customer.notes}</p> : null}</div> : null}
          <h3>{order.status === 'pending' ? 'Message to send' : 'Result receipt'}</h3>
          <pre className="order-message">{order.message}</pre>
          <p>Confirmation request — {order.invitationStatus ? invitationLabels[order.invitationStatus] : 'Not started'}.</p>
          <p>{order.call_mode === 'whatsapp' ? 'WhatsApp call' : order.call_mode === 'voice' ? 'Telnyx voice call' : 'Phone call'}: {order.call_status === 'idle' ? 'Not requested' : order.call_status === 'review' ? 'Needs review' : order.call_status}. {order.attempt_id ? 'One call attempt has been used.' : 'Order details will be sent before dialing.'}</p>
          {order.last_error ? <p className="error" role="status">{order.last_error}</p> : null}
          {order.status === 'pending' && !order.attempt_id ? <>
            {setup?.voice?.ready ? <label className="field">Call type
              <select value={callMode[order.id] || 'ivr'} onChange={event => {
                setCallMode(value => ({ ...value, [order.id]: event.target.value as CallMode }))
                setConsent(value => { const next = { ...value }; delete next[order.id]; return next })
              }}>
                <option value="ivr">Telnyx keypad menu</option>
                <option value="voice">Telnyx voice assistant</option>
                <option value="whatsapp" disabled={!whatsAppReady}>WhatsApp voice assistant</option>
              </select>
            </label> : null}
            <label className="order-consent"><input type="checkbox" checked={consent[order.id] === (callMode[order.id] || 'ivr')} onChange={event => {
              const checked = event.target.checked
              setConsent(value => { const next = { ...value }; if (checked) next[order.id] = callMode[order.id] || 'ivr'; else delete next[order.id]; return next })
            }} />The customer requested a confirmation call on this channel.</label>
          </> : null}
          <div className="order-buttons">
            {!order.invitationStatus && !queued[`${order.id}:invite`] && order.status === 'pending' ? <button type="button" disabled={Boolean(busy) || !setup?.enabled} onClick={() => action(order, 'invite')}>Send confirmation request</button> : null}
            <button type="button" disabled={Boolean(busy) || queued[`${order.id}:call`] || !setup?.enabled || order.invitationStatus === 'failed' || (callMode[order.id] === 'whatsapp' ? !setup.voice?.ready || !whatsAppReady : !callsConfigured || !setup.audio[order.language] || callMode[order.id] === 'voice' && !setup.voice?.ready) || consent[order.id] !== (callMode[order.id] || 'ivr') || order.status !== 'pending' || Boolean(order.attempt_id)} onClick={() => action(order, 'call')}>{queued[`${order.id}:call`] ? 'Call queued' : 'Call customer'}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => action(order, 'log')}>View action log</button>
          </div>
          {log?.id === order.id ? <div className="order-action-log" aria-live="polite"><h3>Action log</h3>{log.actions.length ? <ul>{log.actions.map(item => <li key={item.key}>{item.kind}: {item.status}{item.error ? ` — ${item.error}` : ''}</li>)}</ul> : <p>No messages or calls have been queued.</p>}</div> : null}
        </details>)}
      </section>
      {setup && (!callsConfigured || !setup.audio.en || !setup.audio.ur) ? <p className="order-setup-note">Phone calling needs a public HTTPS endpoint, a Telnyx Call Control connection, calling credit and the selected language’s menu recording.</p> : null}
    </main>
  )
}
