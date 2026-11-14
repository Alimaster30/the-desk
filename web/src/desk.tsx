import { useEffect, useState, type FormEvent } from 'react'
import { validateAuth, type AuthFields, type AuthMode } from './auth-validation'
import { PageHeading, EmptyState, Icon } from './ui'

export type SessionUser = {
  id: number
  email: string
  name: string
  role: 'admin' | 'user'
  orderAccess: boolean
  balanceUnits: number
}

type DashboardData = {
  balance: string
  spent: string
  durationSeconds: number
  pendingCostCount: number
  byDestination: { destination: string, calls: number, durationSeconds: number, amount: string }[]
  ledger: { id: number, kind: string, amount: string, note: string | null, createdAt: string }[]
}

type GalleryNumber = {
  phoneNumber: string
  type: string
  region: string
  upfrontCost: string
  monthlyCost: string
  currency: string
  features: string[]
}

type OwnedNumber = {
  phone_number: string
  region: string | null
  upfront_cost: string | null
  monthly_cost: string | null
  currency: string | null
  ordered_at: string
  order_status?: string
}

type CreditRequest = {
  id: number
  email: string | null
  name: string | null
  amount: string
  note: string | null
  status: string
  createdAt: string
}

const countries = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['AU', 'Australia'],
  ['PK', 'Pakistan'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['AE', 'United Arab Emirates'],
] as const

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'Request failed.')
  return body
}

function dollars(value: string, digits = 2) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function minutes(seconds: number) {
  return `${(seconds / 60).toFixed(1)} min`
}

function when(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function AuthScreen({ onSuccess }: { onSuccess: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<AuthMode>(window.location.hash === '#/signup' ? 'signup' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [touched, setTouched] = useState<Partial<Record<keyof AuthFields, boolean>>>({})
  const validation = validateAuth(mode, { name, email, password })
  const fieldError = (field: keyof AuthFields) => touched[field] ? validation[field] : undefined
  const touch = (field: keyof AuthFields) => setTouched(current => ({ ...current, [field]: true }))
  const signup = mode === 'signup'

  useEffect(() => {
    function changeMode() {
      setMode(window.location.hash === '#/signup' ? 'signup' : 'login')
      setError('')
      setTouched({})
      setPassword('')
      setShowPassword(false)
    }
    window.addEventListener('hashchange', changeMode)
    return () => window.removeEventListener('hashchange', changeMode)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    setTouched({ name: true, email: true, password: true })
    const firstInvalid = (Object.keys(validation) as (keyof AuthFields)[])[0]
    if (firstInvalid) {
      const input = event.currentTarget.elements.namedItem(firstInvalid)
      if (input instanceof HTMLInputElement) input.focus()
      return
    }
    setBusy(true)
    try {
      const user = await readJson<SessionUser>(await fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password }),
      }))
      window.location.hash = '#/'
      onSuccess(user)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not connect. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <aside className="auth-welcome" aria-label="Welcome to Desk">
          <div className="auth-brand">
            <span className="auth-brand-icon" aria-hidden="true">
              <svg viewBox="0 0 40 40" fill="none"><path d="M10 8h20a5 5 0 0 1 5 5v13a5 5 0 0 1-5 5H19l-9 6v-6a5 5 0 0 1-5-5V13a5 5 0 0 1 5-5Z" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" /><path d="M14 17h12M14 23h8" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" /></svg>
            </span>
            <span>Desk</span>
          </div>
          <p className="auth-welcome-copy">Your calls, messages,<br /> and conversations. All together.</p>
          <div className="auth-welcome-foot"><span>Calls</span><span>Messages</span><span>One desk</span></div>
        </aside>
        <section className="auth-content" aria-labelledby="auth-title">
          <nav className="auth-tabs" aria-label="Account access">
            <a href="#/login" aria-current={!signup ? 'page' : undefined} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }}>Sign in</a>
            <a href="#/signup" aria-current={signup ? 'page' : undefined} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }}>Sign up</a>
          </nav>
          <header className="auth-heading">
            <h1 id="auth-title">{signup ? 'Create your account' : 'Welcome back'}</h1>
            <p>{signup ? 'A new home for your conversations.' : 'Sign in to pick up where you left off.'}</p>
          </header>
          <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy}>
            <fieldset disabled={busy}>
              {signup ? (
                <div className="auth-field">
                  <label htmlFor="auth-name">Full name</label>
                  <input id="auth-name" name="name" value={name} onChange={event => setName(event.target.value)} onBlur={() => touch('name')} autoComplete="name" placeholder="Enter your name" required minLength={2} aria-invalid={!!fieldError('name')} aria-describedby={fieldError('name') ? 'auth-name-error' : undefined} />
                  {fieldError('name') ? <p id="auth-name-error" className="auth-field-error">{fieldError('name')}</p> : null}
                </div>
              ) : null}
              <div className="auth-field">
                <label htmlFor="auth-email">Email address</label>
                <input id="auth-email" name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} onBlur={() => touch('email')} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" required aria-invalid={!!fieldError('email')} aria-describedby={fieldError('email') ? 'auth-email-error' : undefined} />
                {fieldError('email') ? <p id="auth-email-error" className="auth-field-error">{fieldError('email')}</p> : null}
              </div>
              <div className="auth-field">
                <label htmlFor="auth-password">Password</label>
                <div className="auth-password">
                  <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} onBlur={() => touch('password')} autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? 'Create a password' : 'Enter your password'} required minLength={signup ? 8 : undefined} aria-invalid={!!fieldError('password')} aria-describedby={fieldError('password') ? 'auth-password-error' : signup ? 'auth-password-hint' : undefined} />
                  <button className="auth-password-toggle" type="button" onClick={() => setShowPassword(current => !current)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} aria-controls="auth-password">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{showPassword ? <path d="m3 3 18 18" /> : null}</svg>
                  </button>
                </div>
                {fieldError('password') ? <p id="auth-password-error" className="auth-field-error">{fieldError('password')}</p> : signup ? <p id="auth-password-hint" className="auth-hint">Use at least 8 characters.</p> : null}
              </div>
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button className="auth-submit" type="submit">{busy ? (signup ? 'Creating account…' : 'Signing in…') : signup ? 'Create account' : 'Sign in'}<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></button>
            </fieldset>
          </form>
          <p className="auth-switch">
            {signup ? 'Already have an account?' : 'New to Desk?'}{' '}
            <a href={signup ? '#/login' : '#/signup'} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }}>{signup ? 'Sign in' : 'Create an account'}</a>
          </p>
        </section>
      </div>
    </main>
  )
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/api/dashboard').then((response) => readJson<DashboardData>(response)).then(setData).catch((reason: Error) => setError(reason.message))
  }, [])
  return (
    <main>
      <PageHeading title="Your workspace" description="A clear view of your calls, credit and numbers."><a href="#/billing">Request credit</a><a href="#/dialer" className="primary"><Icon name="phone" size={16} />Make a call</a></PageHeading>
      {error ? <p role="alert">{error}</p> : null}
      {!data ? !error && <p className="waiting">Loading your account.</p> : (
        <>
          <dl className="ledger">
            <div><dt>Available balance</dt><dd>{dollars(data.balance)}</dd></div>
            <div><dt>Total spent</dt><dd>{dollars(data.spent, 4)}</dd></div>
            <div><dt>Call minutes</dt><dd>{minutes(data.durationSeconds)}</dd></div>
          </dl>
          {data.pendingCostCount > 0 ? <p>{data.pendingCostCount} ended {data.pendingCostCount === 1 ? 'call is' : 'calls are'} still waiting on a Telnyx price.</p> : null}
          <div className="section-head"><h2>Calls by destination</h2><a href="#/calls">View call history</a></div>
          {data.byDestination.length === 0 ? <EmptyState icon="phone" title="Ready for your first conversation">Make a call to start your history. Minutes and provider costs will be kept here.</EmptyState> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Number</th><th>Calls</th><th>Minutes</th><th>Spent</th></tr></thead>
                <tbody>
                  {data.byDestination.map((row) => (
                    <tr key={row.destination}>
                      <td>{row.destination}</td>
                      <td>{row.calls}</td>
                      <td>{minutes(row.durationSeconds)}</td>
                      <td>{dollars(row.amount, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="section-head"><h2>Recent transactions</h2><a href="#/billing">View credit requests</a></div>
          {data.ledger.length === 0 ? <EmptyState icon="wallet" title="A fresh start">Approved credit and charges for calls or numbers will appear here.</EmptyState> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Kind</th><th>Note</th><th>Amount</th></tr></thead>
                <tbody>
                  {data.ledger.map((row) => (
                    <tr key={row.id}>
                      <td>{when(row.createdAt)}</td>
                      <td>{row.kind}</td>
                      <td>{row.note || '—'}</td>
                      <td>{dollars(row.amount, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  )
}

function chargeUnits(item: GalleryNumber) {
  const upfront = Number(item.upfrontCost)
  const monthly = Number(item.monthlyCost)
  const charge = Number.isFinite(upfront) && upfront > 0 ? upfront : monthly
  if (!Number.isFinite(charge) || charge < 0) return null
  return Math.round(charge * 10000)
}

export function NumbersPage() {
  const [country, setCountry] = useState('US')
  const [area, setArea] = useState('')
  const [contains, setContains] = useState('')
  const [results, setResults] = useState<GalleryNumber[] | null>(null)
  const [owned, setOwned] = useState<OwnedNumber[]>([])
  const [balanceUnits, setBalanceUnits] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [resultCountry, setResultCountry] = useState('US')
  const [purchase, setPurchase] = useState('')
  const [notice, setNotice] = useState('')

  async function loadOwned() {
    setOwned(await readJson<OwnedNumber[]>(await fetch('/api/numbers')))
  }
  async function loadBalance() {
    const user = await readJson<SessionUser>(await fetch('/api/auth/me'))
    setBalanceUnits(user.balanceUnits)
  }

  useEffect(() => {
    loadOwned().catch((reason: Error) => setError(reason.message))
    loadBalance().catch(() => setError('Your balance could not be loaded. Refresh this page before purchasing.'))
  }, [])

  async function search(event: FormEvent) {
    event.preventDefault()
    if (searching) return
    setError('')
    setNotice(''); setPurchase(''); setSearching(true)
    setResults(null)
    const requestedCountry = country
    const params = new URLSearchParams({ country, area, contains })
    try {
      setResults(await readJson<GalleryNumber[]>(await fetch(`/api/numbers/available?${params}`)))
      setResultCountry(requestedCountry)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The gallery did not load.')
    } finally { setSearching(false) }
  }

  async function buy(phoneNumber: string) {
    if (busy) return
    setBusy(phoneNumber)
    setError('')
    try {
      await readJson(await fetch('/api/numbers/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, country: resultCountry }),
      }))
      setPurchase(''); setNotice(`${phoneNumber} was ordered.`)
      setResults((current) => current?.filter((item) => item.phoneNumber !== phoneNumber) ?? null)
      await Promise.all([loadOwned(), loadBalance()]).catch(() => {
        setBalanceUnits(null)
        setError('The order succeeded, but account details could not be refreshed. Refresh the page before another purchase.')
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The number was not purchased.')
      await loadOwned().catch(() => undefined)
    } finally {
      setBusy(null)
    }
  }

  return (
    <main>
      <PageHeading title="Find your number" description="Choose a number from Telnyx inventory and make it yours."><a href="#/billing"><Icon name="wallet" size={16} />{balanceUnits == null ? 'Balance unavailable' : dollars(String(balanceUnits / 10000)) + ' available'}</a></PageHeading>
      <p className="note">The upfront cost is charged to your balance, or the monthly cost when there is no upfront fee. Review the price before confirming a purchase.</p>
      {balanceUnits === 0 ? <p role="alert">Your balance is $0.00. <a href="#/billing">Request credit</a> before buying a number.</p> : null}
      <form className="dial" onSubmit={search}>
        <label className="field">Country
          <select value={country} disabled={searching || Boolean(busy)} onChange={(event) => setCountry(event.target.value)}>
            {countries.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
        <label className="field">Area code
          <input value={area} disabled={searching || Boolean(busy)} onChange={(event) => setArea(event.target.value)} inputMode="numeric" placeholder="415" />
        </label>
        <label className="field">Contains
          <input value={contains} disabled={searching || Boolean(busy)} onChange={(event) => setContains(event.target.value)} placeholder="202" />
        </label>
        <button className="primary" type="submit" disabled={searching || Boolean(busy)}><Icon name="search" size={16} />{searching ? 'Searching…' : 'Find numbers'}</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {owned.length > 0 ? (
        <>
          <h2>Your numbers</h2>
          <ul className="gallery">
            {owned.map((item) => (
              <li key={item.phone_number}>
                <strong>{item.phone_number}</strong>
                <span>{item.region || 'Purchased'}</span>
                <span className={`badge badge-${item.order_status || 'ordered'}`}>{item.order_status === 'review' ? 'Needs review — contact an admin' : item.order_status === 'pending' ? 'Order processing' : 'Ordered'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {results == null && !error ? searching ? <p className="waiting" role="status">Searching Telnyx inventory…</p> : <EmptyState icon="numbers" title="A number that fits your business">Choose a country and search for available numbers. You can narrow the results by area code or digits.</EmptyState> : results == null ? null : results.length === 0 ? <EmptyState icon="search" title="No numbers matched">Try another area code or remove the digit filter.</EmptyState> : (
        <><h2>Available numbers</h2><ul className="gallery">
          {results.map((item) => {
            const cost = chargeUnits(item)
            const short = balanceUnits == null || balanceUnits <= 0 || (cost != null && balanceUnits < cost)
            return (
              <li key={item.phoneNumber}>
                <strong>{item.phoneNumber}</strong>
                <span>{item.region || item.type || country}</span>
                <span>{dollars(item.upfrontCost)} up front · {dollars(item.monthlyCost)} / month</span>
                {purchase === item.phoneNumber ? <div className="inline-confirm"><p>Order this number for {dollars(String((cost || 0) / 10000))}? Monthly charges shown above still apply.</p><div><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => buy(item.phoneNumber)}>{busy === item.phoneNumber ? 'Ordering…' : 'Confirm purchase'}</button><button type="button" disabled={Boolean(busy)} onClick={() => setPurchase('')}>Cancel</button></div></div> : <button type="button" className="primary" disabled={short || Boolean(busy)} onClick={() => setPurchase(item.phoneNumber)}>{short ? 'Credit required' : 'Choose number'}</button>}
              </li>
            )
          })}
        </ul></>
      )}
    </main>
  )
}

export function BillingPage() {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<CreditRequest[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  async function load() {
    setRows(await readJson<CreditRequest[]>(await fetch('/api/billing/requests')))
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message))
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await readJson(await fetch('/api/billing/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, note }),
      }))
      setAmount('')
      setNote('')
      setNotice('Credit request sent. Your balance will update when an admin approves it.')
      await load().catch(() => setError('Your request was saved, but the history could not be refreshed. Refresh the page to see it.'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request was not sent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <PageHeading title="Billing & credit" description="Keep your conversations moving. Request credit and track each decision." />
      <form className="dial" onSubmit={submit}>
        <label className="field">Amount in USD
          <input type="number" min="1" max="10000" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="25.00" required disabled={busy} />
        </label>
        <label className="field">Note
          <input value={note} maxLength={280} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="What is this credit for? (optional)" />
        </label>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Sending' : 'Request credit'}</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <h2>Credit requests</h2>
      {rows == null ? !error && <p className="waiting">Loading requests.</p> : rows.length === 0 ? <EmptyState icon="wallet" title="Your credit history starts here">Send a request above. An admin reviews it before the amount is added to your balance.</EmptyState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Amount</th><th>Note</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{when(row.createdAt)}</td>
                  <td>{dollars(row.amount)}</td>
                  <td>{row.note || '—'}</td>
                  <td><span className={`badge badge-${row.status}`}>{row.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

export function AdminPage() {
  const [rows, setRows] = useState<CreditRequest[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [showAll, setShowAll] = useState(false)

  async function load() {
    setRows(await readJson<CreditRequest[]>(await fetch('/api/billing/requests')))
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message))
  }, [])

  async function decide(id: number, approve: boolean) {
    if (busy !== null) return
    setError('')
    setNotice(''); setBusy(id)
    try {
      await readJson(await fetch(`/api/billing/requests/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' }))
      setRows(current => current?.map(row => row.id === id ? { ...row, status: approve ? 'approved' : 'rejected' } : row) ?? null)
      setNotice(`Credit request ${approve ? 'approved and added to the account' : 'rejected'}.`)
      await load().catch(() => setError('The decision was saved, but the list could not be refreshed. Use Refresh requests to update it.'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The decision was not saved.')
    } finally { setBusy(null) }
  }

  const pending = rows?.filter((row) => row.status === 'pending') ?? []
  const visible = showAll ? rows || [] : pending
  return (
    <main>
      <PageHeading title="Credit approvals" description="Review requests and keep your team's conversations moving."><button type="button" disabled={busy !== null} onClick={() => { setError(''); load().catch(reason => setError(reason.message)) }}>Refresh requests</button></PageHeading>
      <div className="filter-tabs" aria-label="Credit request filter"><button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>Pending <span>{pending.length}</span></button><button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>All requests <span>{rows?.length || 0}</span></button></div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {rows == null ? !error && <p className="waiting">Loading requests.</p> : visible.length === 0 ? <EmptyState icon="check" title={showAll ? 'No requests yet' : 'You’re all caught up'}>{showAll ? 'Credit requests from your users will appear here.' : 'There are no credit requests waiting for a decision.'}</EmptyState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Requested by</th><th>Amount</th><th>Note</th><th>Decision</th></tr></thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}<br />{row.email}</td>
                  <td>{dollars(row.amount)}</td>
                  <td>{row.note || '—'}</td>
                  <td>{row.status === 'pending' ? <div className="actions"><button type="button" className="primary" disabled={busy !== null} onClick={() => decide(row.id, true)}>{busy === row.id ? 'Saving…' : 'Approve credit'}</button><button type="button" disabled={busy !== null} onClick={() => decide(row.id, false)}>Reject</button></div> : <span className={`badge badge-${row.status}`}>{row.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
