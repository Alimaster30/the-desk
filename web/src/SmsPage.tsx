import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon, PageHeading, EmptyState } from './ui'
import { WhatsAppComposer } from './WhatsAppComposer'
import { OrderAutomationMenu, type AutomationSetup } from './OrderAutomationMenu'

type Chat = { id: string; line: string; remote: string; last_at: string; last_text: string }
type Message = { id: string; body: string; timestamp: string; fromMe: boolean; status: string; error?: string; media: { url: string; content_type: string }[] }
type Setup = { lines: string[]; configured: boolean; automation: AutomationSetup }
type Summary = { summaryText: string | null; notice?: string; retryAfterSeconds?: number }
async function json<T>(response: Response): Promise<T> {
  let body
  try { body = await response.json() } catch { throw new Error('The app server did not return a response. Please retry.') }
  if (!response.ok) throw new Error(body.error || 'Request failed.')
  return body
}
const dateTime = (value: string) => new Date(value).toLocaleString()
function shortTime(value: string) {
  const date = new Date(value)
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function mediaUrl(value: string) {
  const token = /\/api\/telnyx-media\/([a-f0-9]{64})$/.exec(value)?.[1]
  return token ? `/api/sms/media/${token}` : value
}

export function SmsPage({ admin }: { admin: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [chatError, setChatError] = useState('')
  const [controlError, setControlError] = useState('')
  const [controlBusy, setControlBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const controlPending = useRef(false)
  const controlRevision = useRef(0)
  const log = useRef<HTMLOListElement>(null)
  const follow = useRef(true)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [line, remote] = selected.split(':')

  useEffect(() => {
    let disposed = false, loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      const revision = controlRevision.current
      try {
        const [state, rows] = await Promise.all([fetch('/api/sms/setup').then(json<Setup>), fetch('/api/sms/conversations').then(json<Chat[]>)])
        if (!disposed) {
          setSetup(current => (controlPending.current || revision !== controlRevision.current) && current ? { ...state, automation: current.automation } : state)
          setChats(rows); setError('')
        }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : 'Could not load SMS conversations.') }
      finally { loading = false }
    }
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    setMessages(null); setSummary(null); setChatError(''); follow.current = true
    if (!selected) return
    let disposed = false, loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const rows = await json<Message[]>(await fetch(`/api/sms/conversations/${encodeURIComponent(selected)}/messages`))
        if (!disposed) { setMessages(rows); setChatError('') }
      } catch (reason) { if (!disposed) setChatError(reason instanceof Error ? reason.message : 'Could not load messages.') }
      finally { loading = false }
    }
    void refresh()
    const timer = window.setInterval(refresh, 4000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [selected])

  const summaryVersion = messages?.map(message => `${message.id}:${message.body}`).join('|') || ''
  useEffect(() => {
    if (!selected || !summaryVersion) return
    let disposed = false, timer: number
    const update = async () => {
      try {
        const result = await json<Summary>(await fetch(`/api/sms/conversations/${encodeURIComponent(selected)}/summary`, { method: 'POST' }))
        if (!disposed) {
          setSummary(result)
          if (result.retryAfterSeconds) timer = window.setTimeout(update, Math.max(60, result.retryAfterSeconds) * 1000)
        }
      } catch { if (!disposed) { setSummary(current => ({ summaryText: current?.summaryText || null, notice: 'Summary is unavailable; it will retry automatically.' })); timer = window.setTimeout(update, 60000) } }
    }
    void update()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [selected, summaryVersion])

  useEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight }, [messages])

  async function toggleControl(key: 'enabled' | 'text' | 'voice', value: boolean) {
    if (!admin || controlPending.current) return
    controlPending.current = true; controlRevision.current++; setControlBusy(true); setControlError('')
    try {
      const automation = await json<AutomationSetup>(await fetch('/api/admin/order-controls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) }))
      setSetup(current => current ? { ...current, automation } : current)
    } catch (reason) { setControlError(reason instanceof Error ? reason.message : 'Could not save assistant settings.') }
    finally { controlPending.current = false; controlRevision.current++; setControlBusy(false) }
  }

  function newConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const destination = String(form.get('phone') || '').trim().replace(/[\s().-]/g, '')
    const sendingLine = String(form.get('line') || '')
    if (!/^\+[1-9]\d{7,14}$/.test(destination) || !setup?.lines.includes(sendingLine)) { setFormError('Enter a phone number including + and its country code, and choose a sending number.'); return }
    setSelected(`${sendingLine}:${destination}`); setFormError('')
    document.getElementById('sms-new-conversation')?.hidePopover()
  }

  async function sent(id: string) {
    const [rows, history] = await Promise.all([fetch('/api/sms/conversations').then(json<Chat[]>), fetch(`/api/sms/conversations/${encodeURIComponent(id)}/messages`).then(json<Message[]>)])
    setChats(rows)
    if (selectedRef.current === id) { follow.current = true; setMessages(history) }
  }

  const visible = chats?.filter(chat => `${chat.remote} ${chat.line} ${chat.last_text}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <main className="inbox-page">
    <PageHeading title="Telnyx conversations" description="Your SMS inbox, with calling one step away.">
      <button type="button" className="primary" popoverTarget="sms-new-conversation" disabled={!setup?.lines.length}><Icon name="plus" size={16} />New message</button>
      <a className="action-link" href="#/dialer"><Icon name="phone" size={16} />Make a call</a>
      <OrderAutomationMenu id="sms-automation-settings" admin={admin} setup={setup?.automation || null} controlBusy={controlBusy} controlError={controlError} toggleControl={toggleControl} telnyx />
    </PageHeading>
    <div id="sms-new-conversation" className="whatsapp-settings sms-new-conversation" popover="auto">
      <h2>New message</h2>
      <form onSubmit={newConversation}>
        <label>Send from<select name="line" required>{setup?.lines.map(number => <option key={number}>{number}</option>)}</select></label>
        <label>Contact number<input name="phone" type="tel" autoComplete="tel" placeholder="+1 415 555 1212" required maxLength={32} /></label>
        {formError ? <p role="alert">{formError}</p> : null}
        <button type="submit" className="primary">Open conversation</button>
      </form>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {setup && !setup.configured ? <p role="alert">Telnyx messaging is not configured. An admin needs to add the API key.</p> : null}
    {setup && !setup.lines.length ? <p className="note">You have no sending number assigned. <a href="#/numbers">Choose a number</a> to start messaging.</p> : null}
    <div className="split">
      <section className="conversation-list">
        <h2>Conversations</h2>
        <label className="search-field"><span className="sr-only">Search SMS conversations</span><Icon name="search" size={16} /><input type="search" placeholder="Search messages" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {chats == null ? <p className="waiting">Loading conversations…</p> : !chats.length ? <p className="note">Start a message, or receive an SMS on your assigned number.</p> : <ul className="chats">{visible?.map(chat => <li key={chat.id}>
          <button type="button" aria-label={`Open SMS chat with ${chat.remote} on ${chat.line}`} aria-current={selected === chat.id ? 'true' : undefined} onClick={() => setSelected(chat.id)}>
            <span className="chat-avatar" aria-hidden="true"><Icon name="message" size={21} /></span>
            <span className="chat-list-content"><span className="chat-list-top"><strong>{chat.remote}</strong><time dateTime={chat.last_at} title={dateTime(chat.last_at)}>{shortTime(chat.last_at)}</time></span><span className="chat-list-preview">{chat.last_text}</span><span className="sms-line-label">Via {chat.line}</span></span>
          </button>
        </li>)}</ul>}
        {chats?.length && !visible?.length ? <p className="note">No conversations match this search.</p> : null}
      </section>
      <section className="conversation">
        <div className="conversation-header"><div><h2>{remote || 'SMS conversations'}</h2>{line ? <span className="note">Via {line}</span> : null}</div>{remote ? <a className="chat-call-button" href={`#/dialer?to=${encodeURIComponent(remote)}`} aria-label={`Call ${remote} with Telnyx`}><Icon name="phone" size={17} />Call</a> : null}</div>
        {chatError ? <p role="alert">{chatError}</p> : null}
        {!selected ? <EmptyState title="Messages and calls, together">Choose a conversation or start a new message. Calls open in your standalone dialer.</EmptyState> : <>
          {messages == null ? !chatError && <p className="waiting">Loading messages…</p> : <ol ref={log} className="log" tabIndex={0} aria-label="SMS messages" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
            {!messages.length ? <li className="sms-empty">No messages yet. Write the first message below.</li> : null}
            {messages.map(message => <li key={message.id} className={message.fromMe ? 'mine' : undefined}>
              <div className="message-meta"><strong>{message.fromMe ? 'You' : remote}</strong><time dateTime={message.timestamp}>{dateTime(message.timestamp)}</time></div>
              {message.body ? <p>{message.body}</p> : null}
              {message.media.map((media, index) => <div className="chat-attachment" key={index}><a href={mediaUrl(media.url)} target="_blank" rel="noreferrer">{media.content_type.startsWith('image/') ? <img src={mediaUrl(media.url)} alt="Message photo" loading="lazy" /> : 'Open attachment'}</a></div>)}
              {message.fromMe ? <small className="sms-delivery">{message.status.replaceAll('_', ' ')}{message.error ? ` · ${message.error}` : ''}</small> : null}
            </li>)}
          </ol>}
          <WhatsAppComposer jid={selected} channel="sms" connected={Boolean(setup?.configured && setup.lines.includes(line))} onSent={sent} />
        </>}
      </section>
      {selected ? <aside className="chat-summary" aria-label="Conversation summary"><h2>Summary</h2><p>{summary?.summaryText || (summary?.notice ? 'No summary available yet.' : messages?.length ? 'Updating summary…' : 'The summary will appear after your first message.')}</p>{summary?.notice ? <p className="note" role="status">{summary.notice}</p> : null}<p className="note">Summaries cover the latest 200 messages. Photos are not analysed.</p></aside> : null}
    </div>
  </main>
}
