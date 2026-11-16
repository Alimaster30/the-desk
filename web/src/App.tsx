import { useEffect, useRef, useState } from 'react'
import { readJson } from './api-response'
import { mapState, onCallUpdate, resetPhone } from './phone'
import { Dialer } from './Dialer'
import { AdminPage, AuthScreen, BillingPage, Dashboard, NumbersPage, type SessionUser } from './desk'
import { OrdersPage } from './OrdersPage'
import { OrderStaffPage } from './OrderStaffPage'
import { AnalyticsPage } from './AnalyticsPage'
import { Icon, PageHeading, EmptyState, type IconName } from './ui'
import { WhatsAppComposer } from './WhatsAppComposer'
import { useWhatsAppCall } from './whatsapp-call'
import { SmsPage } from './SmsPage'

type CallRecord = {
  id: number
  direction: string | null
  from: string | null
  to: string | null
  status: string
  startedAt: string | null
  durationSeconds: number | null
  costAmount: string | null
  currency: string | null
}

type Chat = {
  jid: string
  displayName: string | null
  messageCount: number
  transcriptCount: number
  firstMessageAt: string
  lastMessageAt: string
  lastText: string
  summaryText: string | null
  summaryAt: string | null
  summaryMessageCount: number | null
  summaryStale: boolean
}

type Message = {
  id: number
  pushName: string | null
  body: string
  timestamp: string
  fromMe: boolean
  attachment?: { kind: string; name: string; mimetype: string; url: string }
}

type ReplyState = {
  enabled: boolean
  paused?: boolean
  pattern: string
  exampleCount: number
  ready: boolean
  updatedAt: string | null
}

type WaLink = {
  connection: string
  qrDataUrl: string | null
  error: string | null
  type?: string
}

function minutes(seconds: number | null) {
  if (seconds == null) return '—'
  return `${(seconds / 60).toFixed(1)} min`
}

function money(amount: string | null, currency: string | null) {
  if (!amount) return 'Pending'
  return currency ? `${currency} ${Number(amount).toFixed(4)}` : Number(amount).toFixed(4)
}

function when(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function chatLabel(chat: Chat) {
  return chat.displayName || chat.jid.replace(/@.*/, '')
}

function chatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function ChatAvatar({ chat }: { chat: Chat }) {
  const [failed, setFailed] = useState(false)
  const name = chatLabel(chat)
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase()
  return <span className="chat-avatar" aria-hidden="true">
    {chat.jid.endsWith('@g.us') ? <Icon name="people" size={21} /> : initials}
    {!failed ? <img src={`/api/whatsapp/chats/${encodeURIComponent(chat.jid)}/avatar`} alt="" loading="lazy" onError={() => setFailed(true)} /> : null}
  </span>
}

export function App() {
  const hash = useHash()
  const [route, query] = hash.split('?')
  const adminRoute = route === '#/admin' || route === '#/whatsapp' || route === '#/staff' || route === '#/analytics'
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [authError, setAuthError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const [ongoingCall, setOngoingCall] = useState(false)
  const [mobileNav, setMobileNav] = useState(() => window.matchMedia('(max-width: 760px)').matches)

  useEffect(() => {
    fetch('/api/auth/me').then(async (response) => {
      if (response.status === 401) {
        setMe(null)
        return
      }
      setMe(await readJson<SessionUser>(response))
    }).catch(() => setMe(null))
  }, [])

  useEffect(() => {
    if (me && ((me.role !== 'admin' && adminRoute) || (!me.orderAccess && route === '#/orders'))) {
      window.location.hash = '#/'
    }
  }, [me, route, adminRoute])
  useEffect(() => {
    setMenuOpen(false)
    const content = document.querySelector<HTMLElement>('.workspace-scroll')
    content?.scrollTo(0, 0); content?.focus({ preventScroll: true })
    const titles: Record<string, string> = { '#/': 'Overview', '#/calls': 'Calls', '#/sms': 'Telnyx', '#/dialer': 'Make a call', '#/numbers': 'Numbers', '#/billing': 'Billing', '#/admin': 'Approvals', '#/whatsapp': 'WhatsApp', '#/orders': 'Orders', '#/staff': 'Staff access', '#/analytics': 'Analytics', '#/login': 'Sign in', '#/signup': 'Create account' }
    document.title = `${me === null ? route === '#/signup' ? 'Create account' : 'Sign in' : titles[route] || 'Overview'} · Desk`
  }, [hash, me?.id, me === null])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => { setMobileNav(media.matches); setMenuOpen(false) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!menuOpen) return
    document.querySelector<HTMLElement>('.side nav a')?.focus()
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu() }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [menuOpen])
  useEffect(() => {
    const stop = onCallUpdate(call => setOngoingCall(!['hangup', 'failed'].includes(mapState(call.state))))
    return () => { stop() }
  }, [])

  function closeMenu() {
    setMenuOpen(false)
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus())
  }

  if (me === undefined) return <p className="waiting page-wait">Loading.</p>
  if (!me) return <AuthScreen onSuccess={setMe} />

  async function signOut() {
    setSigningOut(true); setAuthError('')
    try {
      await resetPhone()
      await readJson(await fetch('/api/auth/logout', { method: 'POST' }))
      setMe(null)
      window.location.hash = '#/'
    } catch { setAuthError('Could not sign out. Please try again.') }
    finally { setSigningOut(false) }
  }

  const isAdmin = me.role === 'admin' && (adminRoute || route === '#/orders')
  const navigation: { href: string; label: string; icon: IconName }[] = isAdmin
    ? [{ href: '#/analytics', label: 'Analytics', icon: 'grid' }, { href: '#/orders', label: 'Orders', icon: 'orders' }, { href: '#/whatsapp', label: 'WhatsApp', icon: 'message' }, { href: '#/admin', label: 'Approvals', icon: 'wallet' }, { href: '#/staff', label: 'Staff access', icon: 'shield' }]
    : [{ href: '#/', label: 'Overview', icon: 'grid' }, ...(me.orderAccess && me.role === 'user' ? [{ href: '#/orders', label: 'Orders', icon: 'orders' as const }] : []), { href: '#/calls', label: 'Calls', icon: 'phone' }, { href: '#/sms', label: 'Telnyx', icon: 'message' }, { href: '#/numbers', label: 'Numbers', icon: 'numbers' }, { href: '#/billing', label: 'Billing', icon: 'wallet' }]
  const selectedOrder = new URLSearchParams(query).get('order') || undefined
  const page = route === '#/orders' && me.orderAccess ? <OrdersPage key={selectedOrder || 'orders'} admin={me.role === 'admin'} selectedOrder={selectedOrder} />
    : isAdmin
    ? route === '#/analytics' ? <AnalyticsPage /> : route === '#/whatsapp' ? <WhatsApp /> : route === '#/staff' ? <OrderStaffPage /> : <AdminPage />
    : route === '#/numbers'
      ? <NumbersPage />
      : route === '#/billing'
        ? <BillingPage />
        : <Dashboard />

  return (
    <div className={`shell${isAdmin ? ' shell-admin' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <a className="skip-link" inert={mobileNav && menuOpen} href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus() }}>Skip to content</a>
      {menuOpen ? <button className="nav-scrim" tabIndex={-1} aria-label="Close navigation" onClick={closeMenu} /> : null}
      <aside className="side" id="workspace-navigation" inert={mobileNav && !menuOpen} onKeyDown={event => {
        if (!mobileNav || !menuOpen || event.key !== 'Tab') return
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <button type="button" className="icon-button drawer-close" aria-label="Close navigation" onClick={closeMenu}><Icon name="close" /></button>
        <a className="mark" href={isAdmin ? '#/analytics' : '#/'}><span className="brand-symbol"><Icon name="message" size={21} /></span>Desk<span className="brand-label">workspace</span></a>
        <a className="side-primary" href={isAdmin ? '#/orders' : '#/dialer'}><Icon name="plus" />{isAdmin ? 'Create an order' : 'Make a call'}</a>
        <p className="nav-label">{isAdmin ? 'Administration' : 'Your workspace'}</p>
        <nav aria-label={isAdmin ? 'Admin navigation' : 'Workspace navigation'}>
          {navigation.map(item => <a key={item.href} href={item.href} aria-current={(route === item.href || item.href === '#/' && route === '') ? 'page' : undefined}><Icon name={item.icon} />{item.label}<span className="nav-selected-dot" /></a>)}
        </nav>
        <div className="side-foot">
          {me.role === 'admin' ? <a className="workspace-switch" href={isAdmin ? '#/' : '#/analytics'}><Icon name={isAdmin ? 'grid' : 'shield'} />{isAdmin ? 'Personal workspace' : 'Admin workspace'}<Icon name="arrow" size={16} /></a> : null}
          <div className="account"><span className="avatar">{me.name.trim().slice(0, 2).toUpperCase()}</span><span><strong>{me.name}</strong><small>{me.email}</small></span><button type="button" className="icon-button" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={signOut}><Icon name="logout" size={18} /></button></div>
        </div>
      </aside>
      <div className="workspace" inert={mobileNav && menuOpen}>
        <div className="workspace-toolbar"><button type="button" className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(value => !value)}><Icon name={menuOpen ? 'close' : 'menu'} /></button><span>Workspace <span className="toolbar-divider">/</span> {route === '#/dialer' ? 'Make a call' : navigation.find(item => item.href === route)?.label || 'Overview'}</span><span className="workspace-role"><Icon name={isAdmin ? 'shield' : 'grid'} size={14} />{isAdmin ? 'Admin workspace' : 'Personal workspace'}</span></div>
        <div className="workspace-scroll" id="workspace-content" tabIndex={-1}>
          <div className="wrap">
            {authError && <p role="alert">{authError}</p>}
            {ongoingCall && route !== '#/dialer' && <a className="active-call-notice" href="#/dialer"><Icon name="phone" size={16} />Call in progress — return to call controls<Icon name="arrow" size={16} /></a>}
            <div hidden={route !== '#/dialer'}><Dialer visible={route === '#/dialer'} destination={new URLSearchParams(query).get('to') || undefined} /></div>
            {route === '#/sms' ? <SmsPage admin={me.role === 'admin'} /> : route === '#/calls' ? <Calls /> : route === '#/dialer' ? null : page}
          </div>
        </div>
      </div>
    </div>
  )
}

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

function Calls() {
  const [error, setError] = useState('')
  const [calls, setCalls] = useState<CallRecord[] | null>(null)
  const [refreshing, setRefreshing] = useState<number | null>(null)

  async function load() {
    const rows = await readJson<CallRecord[]>(await fetch('/api/calls'))
    setCalls(rows)
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message))
    const stop = onCallUpdate(() => {
      load().catch(() => undefined)
    })
    return () => {
      stop()
    }
  }, [])

  async function refresh(id: number) {
    setRefreshing(id)
    setError('')
    try {
      await readJson(await fetch(`/api/calls/${id}/refresh-cost`, { method: 'POST' }))
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Cost refresh failed.')
    } finally {
      setRefreshing(null)
    }
  }

  return (
    <main>
      <PageHeading title="Calls" description="A direct line to your customers."><a className="primary" href="#/dialer"><Icon name="phone" size={16} />Make a call</a></PageHeading>
      {error ? <p role="alert">{error}</p> : null}
      <p className="note">Call costs appear once Telnyx has priced the call. Use Refresh cost to check an ended call.</p>
      <h2>Call history</h2>
      {calls == null ? !error && <p className="waiting">Loading calls.</p> : calls.length === 0 ? (
        <EmptyState icon="phone" title="Your next conversation starts here">Enter a number with its country code to make your first call. Minutes and costs will appear here.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Direction</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Minutes</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
                <th scope="col">Price</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id}>
                  <td>{when(call.startedAt)}</td>
                  <td>{call.direction || '—'}</td>
                  <td>{call.from || '—'}</td>
                  <td>{call.to || '—'}</td>
                  <td>{minutes(call.durationSeconds)}</td>
                  <td>{money(call.costAmount, call.currency)}</td>
                  <td>{call.status}</td>
                  <td>
                    <button type="button" disabled={refreshing === call.id} onClick={() => refresh(call.id)}>
                      {refreshing === call.id ? 'Refreshing' : 'Refresh cost'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

function WhatsApp() {
  const personalCall = useWhatsAppCall()
  const [link, setLink] = useState<WaLink | null>(null)
  const [voiceLink, setVoiceLink] = useState<{ state: string; enabled: boolean; qrDataUrl: string | null } | null>(null)
  const [linkError, setLinkError] = useState('')
  const [linkAction, setLinkAction] = useState<'connect' | 'disconnect' | null>(null)
  const linkRequest = useRef({ revision: 0, changing: false })
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [summary, setSummary] = useState<Pick<Chat, 'summaryText' | 'summaryAt' | 'summaryMessageCount' | 'summaryStale'> | null>(null)
  const [error, setError] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [summaryRetryAt, setSummaryRetryAt] = useState<string | null>(null)
  const [reply, setReply] = useState<ReplyState | null>(null)
  const [replyBusy, setReplyBusy] = useState(false)
  const [replyError, setReplyError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const selectedRef = useRef('')
  const chatRevision = useRef(0)
  const conversationHeading = useRef<HTMLHeadingElement>(null)
  const messageLog = useRef<HTMLOListElement>(null)
  const followMessages = useRef(true)

  function resetInbox() {
    chatRevision.current++
    selectedRef.current = ''
    setSelected(''); setChats([]); setMessages(null); setSummary(null)
    setSummaryError(''); setSummaryRetryAt(null); setError(''); setChatQuery('')
    setReply(null)
    setVoiceLink({ state: 'off', enabled: false, qrDataUrl: null })
    personalCall.end()
  }

  async function loadReply() {
    const revision = chatRevision.current
    setReplyError('')
    try { const result = await readJson<ReplyState>(await fetch('/api/whatsapp/reply')); if (revision === chatRevision.current) setReply(result) }
    catch { setReplyError('Auto-reply settings are unavailable. Try loading them again.') }
  }

  async function loadChats() {
    const revision = chatRevision.current
    const rows = await readJson<Chat[]>(await fetch('/api/whatsapp/chats'))
    if (revision !== chatRevision.current) return []
    setChats(rows)
    return rows
  }

  async function openChat(jid: string, known?: Chat) {
    const revision = chatRevision.current
    followMessages.current = true
    selectedRef.current = jid
    setSelected(jid)
    setMessages(null)
    setError('')
    setSummaryError('')
    setSummaryRetryAt(null)
    const chat = known ?? chats?.find((item) => item.jid === jid)
    setSummary(chat ? {
      summaryText: chat.summaryText,
      summaryAt: chat.summaryAt,
      summaryMessageCount: chat.summaryMessageCount,
      summaryStale: chat.summaryStale,
    } : null)
    try {
      const loaded = await readJson<Message[]>(await fetch(`/api/whatsapp/chats/${encodeURIComponent(jid)}/messages`))
      if (revision === chatRevision.current && selectedRef.current === jid) setMessages(loaded)
    } catch (reason) {
      if (selectedRef.current === jid) setError(reason instanceof Error ? reason.message : 'Could not load texts.')
    }
  }

  useEffect(() => {
    selectedRef.current = selected
    if (selected && window.matchMedia('(max-width: 760px)').matches) {
      conversationHeading.current?.focus({ preventScroll: true })
    }
  }, [selected])

  useEffect(() => {
    if (followMessages.current && messageLog.current) messageLog.current.scrollTop = messageLog.current.scrollHeight
  }, [messages])

  useEffect(() => {
    loadChats().catch((reason: Error) => setError(reason.message))
    let disposed = false
    const refreshLink = async () => {
      if (linkRequest.current.changing) return
      const revision = ++linkRequest.current.revision
      try {
        const next = await readJson<WaLink>(await fetch('/api/whatsapp/status', { signal: AbortSignal.timeout(4500) }))
        if (!disposed && revision === linkRequest.current.revision) { setLink(next); setLinkError('') }
      } catch {
        if (!disposed && revision === linkRequest.current.revision) {
          setLink(null)
          setLinkError('The app server is unavailable. Checking again automatically.')
        }
      }
    }
    void refreshLink()
    const refreshVoiceLink = async () => {
      try {
        const next = await readJson<NonNullable<typeof voiceLink>>(await fetch('/api/whatsapp/voice-status', { signal: AbortSignal.timeout(4000) }))
        if (!disposed) setVoiceLink(next)
      } catch { if (!disposed) setVoiceLink({ state: 'unavailable', enabled: false, qrDataUrl: null }) }
    }
    void refreshVoiceLink()
    const timer = window.setInterval(() => { void refreshLink(); void refreshVoiceLink() }, 5000)
    void loadReply()
    const source = new EventSource('/api/whatsapp/events')
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as WaLink
      if (next.type === 'logout') { setLink(next); resetInbox(); return }
      if (!next.type) {
        linkRequest.current.revision++
        setLink(next); setLinkError('')
      }
      if (next.type !== 'message') return
      const jid = selectedRef.current
      const revision = chatRevision.current
      loadChats().then(async (rows) => {
        if (!jid) return
        const chat = rows.find((item) => item.jid === jid)
        const loaded = await readJson<Message[]>(await fetch(`/api/whatsapp/chats/${encodeURIComponent(jid)}/messages`))
        if (revision !== chatRevision.current || selectedRef.current !== jid) return
        if (chat) {
          setSummary({
            summaryText: chat.summaryText,
            summaryAt: chat.summaryAt,
            summaryMessageCount: chat.summaryMessageCount,
            summaryStale: chat.summaryStale,
          })
        }
        setMessages(loaded)
        const replyState = await readJson<ReplyState>(await fetch('/api/whatsapp/reply'))
        if (revision === chatRevision.current && selectedRef.current === jid) setReply(replyState)
      }).catch(() => undefined)
    }
    source.onerror = () => { void refreshLink() }
    return () => { disposed = true; source.close(); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (link?.connection === 'open') { void loadChats().catch(() => undefined); void loadReply() }
    else if (link?.connection === 'paused' || link?.connection === 'qr') resetInbox()
  }, [link?.connection])

  const current = chats?.find((chat) => chat.jid === selected) ?? null
  const visibleChats = chats?.filter(chat => `${chatLabel(chat)} ${chat.lastText}`.toLowerCase().includes(chatQuery.toLowerCase())) || []

  async function changeLink(action: 'connect' | 'disconnect') {
    if (linkRequest.current.changing) return
    linkRequest.current.changing = true
    const revision = ++linkRequest.current.revision
    setLinkAction(action); setLinkError('')
    if (action === 'disconnect') resetInbox()
    try {
      const next = await readJson<WaLink>(await fetch(`/api/whatsapp/${action}`, { method: 'POST', signal: AbortSignal.timeout(action === 'disconnect' ? 120000 : 10000) }))
      if (revision === linkRequest.current.revision) setLink(next)
    } catch (reason) {
      setLinkError(reason instanceof Error ? reason.message : `Could not ${action} WhatsApp.`)
      if (action === 'disconnect') void loadChats().catch(() => undefined)
    } finally { linkRequest.current.changing = false; setLinkAction(null) }
  }

  useEffect(() => {
    if (!selected || !messages?.length) { setSummarizing(false); return }
    let disposed = false
    let timer: number
    const controller = new AbortController()
    let failures = 0
    setSummaryError('')
    setSummaryRetryAt(null)
    setSummarizing(true)
    const update = async () => {
      try {
        const result = await readJson<NonNullable<typeof summary> & { summaryNotice?: string; retryAfterSeconds?: number }>(await fetch(`/api/whatsapp/chats/${encodeURIComponent(selected)}/summary`, { method: 'POST', signal: controller.signal }))
        if (disposed || selectedRef.current !== selected) return
        setSummary(result)
        failures = 0
        setSummaryError(result.summaryNotice || '')
        setSummaryRetryAt(null)
        setChats(rows => rows?.map(chat => chat.jid === selected ? { ...chat, ...result } : chat) ?? null)
        if (result.retryAfterSeconds) {
          const delay = Math.min(86400, Math.max(1, result.retryAfterSeconds)) * 1000
          setSummaryRetryAt(new Date(Date.now() + delay).toISOString())
          setSummarizing(false)
          timer = window.setTimeout(update, Math.min(delay, 60000))
        } else if (result.summaryStale) timer = window.setTimeout(update, 1500)
        else setSummarizing(false)
      } catch {
        if (!disposed) {
          setSummarizing(false)
          failures++
          if (failures <= 3) {
            const delay = failures * 30000
            setSummaryError('The summary service is temporarily unavailable. Retrying automatically.')
            setSummaryRetryAt(new Date(Date.now() + delay).toISOString())
            timer = window.setTimeout(update, delay)
          } else {
            setSummaryRetryAt(null)
            setSummaryError('The summary service could not be reached. Reopen this chat to retry.')
          }
        }
      }
    }
    timer = window.setTimeout(update, 500)
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer) }
  }, [selected, messages])

  async function toggleReply() {
    if (!reply || replyBusy) return
    setReplyBusy(true); setReplyError('')
    const revision = chatRevision.current
    try {
      const result = await readJson<ReplyState>(await fetch('/api/whatsapp/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !reply.enabled }),
      }))
      if (revision === chatRevision.current) setReply(result)
    } catch (reason) { setReplyError(reason instanceof Error ? reason.message : 'Could not change auto-reply.') }
    finally { setReplyBusy(false) }
  }

  const canDisconnect = link?.connection === 'open' || link?.connection === 'qr' || link?.connection === 'starting'
  async function manualMessageSent(jid: string) {
    await loadChats()
    if (selectedRef.current !== jid) return
    const loaded = await readJson<Message[]>(await fetch(`/api/whatsapp/chats/${encodeURIComponent(jid)}/messages`))
    if (selectedRef.current === jid) { followMessages.current = true; setMessages(loaded) }
  }
  return (
    <main className="inbox-page">
      <PageHeading title="Customer conversations" description="Your shared WhatsApp inbox, with the context to reply well.">
        <span className="connection-status" role="status">{link ? linkLabel(link.connection) : linkError ? 'Unavailable' : 'Checking…'}</span>
          <button type="button" className={canDisconnect ? undefined : 'primary'} disabled={Boolean(linkAction || !link)} onClick={() => void changeLink(canDisconnect ? 'disconnect' : 'connect')}>
            {linkAction === 'connect' ? 'Connecting…' : linkAction === 'disconnect' ? 'Disconnecting…' : canDisconnect ? 'Disconnect' : link?.connection === 'paused' ? 'Reconnect' : 'Connect to WhatsApp'}
          </button>
        <button type="button" className="icon-button" aria-label="WhatsApp settings" popoverTarget="whatsapp-settings"><Icon name="more" /></button>
      </PageHeading>
      <div id="whatsapp-settings" className="whatsapp-settings" popover="auto">
        <p className="note">WhatsApp automation</p>
        <button type="button" role="switch" className="settings-toggle" aria-checked={reply?.enabled ?? false} disabled={!reply || replyBusy || reply.paused} onClick={toggleReply}>
          Auto-reply settings <span className="toggle-track" data-on={reply?.enabled ?? false} aria-hidden="true" />
        </button>
        <p className="note">Replies automatically use your learned writing style.</p>
        {replyBusy ? <p role="status">Saving auto-reply…</p> : null}
        {reply?.paused ? <p className="note">Auto-reply is paused by the server.</p> : null}
        {replyError ? <p role="alert">{replyError} <button type="button" onClick={loadReply}>Retry</button></p> : null}
      </div>
        {linkError ? <p role="alert">{linkError}</p> : null}
        {link?.error ? <p role="alert">{link.error}</p> : null}
        {link?.qrDataUrl ? (
          <section className="pairing-panel" aria-label="Link WhatsApp">
            <p>Open WhatsApp on your phone, then Linked devices, then scan this code.</p>
            <img src={link.qrDataUrl} alt="WhatsApp link code" width="280" height="280" />
          </section>
        ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {personalCall.ongoing && personalCall.call ? <div className="whatsapp-call-bar" role="status">
        <span><Icon name="phone" size={16} />{personalCall.call.name} · {personalCall.call.phase === 'answered' ? 'On the call' : personalCall.call.phase === 'ringing' ? 'Ringing' : 'Connecting'}</span>
        <button type="button" disabled={personalCall.call.phase !== 'answered'} onClick={personalCall.toggleMute}>{personalCall.muted ? 'Unmute' : 'Mute'}</button>
        <button type="button" className="stop" onClick={personalCall.end}>Hang up</button>
      </div> : null}
      {personalCall.error ? <p role="alert">{personalCall.error}</p> : null}
      <div className="split">
        <section className="conversation-list">
          <h2>Conversations</h2>
          <label className="search-field"><span className="sr-only">Search conversations</span><Icon name="search" size={16} /><input type="search" placeholder="Search chats" value={chatQuery} onChange={event => setChatQuery(event.target.value)} /></label>
          {chats == null ? !error && <p className="waiting">Loading chats.</p> : chats.length === 0 ? (
            <p>No texts yet. Messages that arrive after you link show up here.</p>
          ) : (
            <ul className="chats">
              {visibleChats.map((chat) => (
                <li key={chat.jid}>
                  <button type="button" aria-label={`Open chat with ${chatLabel(chat)}`} aria-current={chat.jid === selected ? 'true' : undefined} onClick={() => openChat(chat.jid, chat)}>
                    <ChatAvatar chat={chat} />
                    <span className="chat-list-content">
                      <span className="chat-list-top"><strong>{chatLabel(chat)}</strong><time dateTime={chat.lastMessageAt} title={when(chat.lastMessageAt)}>{chatTime(chat.lastMessageAt)}</time></span>
                      <span className="chat-list-preview">{chat.lastText}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chats?.length && !visibleChats.length ? <p>No conversations match this search.</p> : null}
        </section>
        <section className="conversation">
          <div className="conversation-header">
            <h2 ref={conversationHeading} tabIndex={-1}>{current ? chatLabel(current) : 'Conversation history'}</h2>
            {current ? <button type="button" className="chat-call-button" aria-label={`Call ${chatLabel(current)} on WhatsApp`} title={voiceLink?.state !== 'ready' ? 'Connect WhatsApp to call.' : current.jid.endsWith('@g.us') ? 'Group calls are not supported.' : 'Personal call using your browser microphone'}
              disabled={personalCall.ongoing || voiceLink?.state !== 'ready' || !/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(current.jid)}
              onClick={() => void personalCall.start(current.jid, chatLabel(current))}><Icon name="phone" size={17} /><span>Call</span></button> : null}
          </div>
          {!current ? <EmptyState title="Every conversation, in context">Choose a customer to read their messages and see the latest summary.</EmptyState> : (
            <>
              {messages == null ? <p className="waiting">Loading texts.</p> : (
                <ol ref={messageLog} className="log" tabIndex={0} aria-label="Chat messages" onScroll={event => { const log = event.currentTarget; followMessages.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80 }}>
                  {messages.map((message) => (
                    <li key={message.id} className={message.fromMe ? 'mine' : undefined}>
                      <div className="message-meta">
                        <strong>{message.fromMe ? 'You' : message.pushName || 'Unknown'}</strong>
                        <time dateTime={message.timestamp}>{when(message.timestamp)}</time>
                      </div>
                      <p>{message.body}</p>
                      {message.attachment ? <div className="chat-attachment">
                        {message.attachment.kind !== 'document' ? <a href={message.attachment.url} target="_blank" rel="noreferrer"><img src={message.attachment.url} alt={message.attachment.kind === 'sticker' ? 'Sticker' : message.attachment.name} loading="lazy" /></a> : null}
                        <a href={message.attachment.url} download={message.attachment.name}>{message.attachment.name}</a>
                      </div> : null}
                    </li>
                  ))}
                </ol>
              )}
              <WhatsAppComposer jid={current.jid} connected={link?.connection === 'open'} onSent={manualMessageSent} />
            </>
          )}
        </section>
        {current ? <aside className="chat-summary" aria-label="Conversation summary">
          <h2>Summary</h2>
          {summary?.summaryText ? <p>{summary.summaryText}</p> : !summaryError ? <p>{summarizing ? 'Updating summary…' : 'The summary will appear automatically.'}</p> : null}
          {summary?.summaryStale && summary.summaryText && summary.summaryMessageCount != null ? <p className="note">This summary covers {summary.summaryMessageCount} of {current.transcriptCount} messages.</p> : null}
          {summarizing && summary?.summaryText ? <p className="note" role="status">Updating summary…</p> : null}
          {summaryError ? <p className="note" role="status">{summaryError}</p> : null}
          {summaryRetryAt ? <p className="note">Next check: <time dateTime={summaryRetryAt}>{when(summaryRetryAt)}</time></p> : null}
        </aside> : null}
      </div>
    </main>
  )
}

function linkLabel(connection: string) {
  if (connection === 'open') return 'Linked'
  if (connection === 'qr') return 'Waiting for the scan'
  if (connection === 'starting') return 'Starting'
  if (connection === 'close' || connection === 'paused') return 'Disconnected'
  if (connection === 'error') return 'Connection failed'
  return connection
}
