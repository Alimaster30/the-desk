import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './ui'
import { confirmWhatsAppSend } from './send-response'

type Draft = { text: string; file?: File; sticker?: boolean; requestId?: string }
const empty: Draft = { text: '' }
const emojis = ['😀', '😊', '😂', '🙂', '😍', '😅', '🙏', '👍', '❤️', '🎉', '✅', '🤝', '👋', '✨', '📦', '📍', '🕒', '👌', '💬', '🙌']

export function WhatsAppComposer({ jid, connected, onSent, channel = 'whatsapp' }: { jid: string; connected: boolean; onSent: (jid: string) => Promise<void>; channel?: 'whatsapp' | 'sms' }) {
  const sms = channel === 'sms'
  const service = sms ? 'Telnyx' : 'WhatsApp'
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [sending, setSending] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const stickers = useRef<HTMLInputElement>(null)
  const draft = drafts[jid] ?? empty
  const patch = (update: Partial<Draft>) => setDrafts(all => ({ ...all, [jid]: { ...(all[jid] ?? empty), ...update, requestId: undefined } }))
  useEffect(() => {
    if (!draft.file || !(draft.file.type.startsWith('image/') || draft.sticker)) { setPreview(''); return }
    const url = URL.createObjectURL(draft.file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [draft.file])
  useEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = Math.min(input.scrollHeight, 110) + 'px'
  }, [draft.text, jid])

  function attach(file?: File, sticker = false) {
    if (!file) return
    if (sms && (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 1024 * 1024)) {
      setErrors(all => ({ ...all, [jid]: 'Choose a PNG or JPEG photo up to 1 MB. MMS carrier support is required.' }))
      return
    }
    if (file.size > (sticker ? 512 * 1024 : 5 * 1024 * 1024)) {
      setErrors(all => ({ ...all, [jid]: sticker ? 'Choose a WebP sticker of up to 512 KB.' : 'Attachments must be 5 MB or smaller.' }))
      return
    }
    if (sticker && !file.name.toLowerCase().endsWith('.webp')) {
      setErrors(all => ({ ...all, [jid]: 'Choose a WebP sticker.' }))
      return
    }
    setErrors(all => ({ ...all, [jid]: '' }))
    patch({ file, sticker })
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!connected || sending || (!draft.text.trim() && !draft.file)) return
    if (draft.sticker && draft.text.trim()) { setErrors(all => ({ ...all, [jid]: 'Send your text separately from the sticker.' })); return }
    const target = jid
    const requestId = draft.requestId || crypto.randomUUID()
    setDrafts(all => ({ ...all, [target]: { ...(all[target] ?? draft), requestId } }))
    setSending(true); setErrors(all => ({ ...all, [target]: '' }))
    try {
      const attachment = draft.file ? {
        kind: draft.sticker ? 'sticker' : ['image/png', 'image/jpeg', 'image/webp'].includes(draft.file.type) ? 'image' : 'document',
        name: draft.file.name,
        data: await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('The attachment could not be read.'))
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.readAsDataURL(draft.file!)
        }),
      } : undefined
      let response: Response
      try {
        response = await fetch(sms ? `/api/sms/conversations/${encodeURIComponent(target)}/send` : `/api/whatsapp/chats/${encodeURIComponent(target)}/send`, {
          method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft.text, attachment, requestId }),
        })
      } catch { throw new Error(`The app server could not confirm delivery. Your draft is kept. Check ${service} before retrying.`) }
      await confirmWhatsAppSend(response, service)
      setDrafts(all => ({ ...all, [target]: empty }))
      try { await onSent(target) }
      catch { setErrors(all => ({ ...all, [target]: 'Message sent. The conversation could not refresh yet.' })) }
    } catch (reason) {
      setErrors(all => ({ ...all, [target]: reason instanceof Error ? reason.message : `Message was not confirmed. Check ${service} before retrying.` }))
    } finally { setSending(false) }
  }

  function insertEmoji(emoji: string) {
    const start = textarea.current?.selectionStart ?? draft.text.length
    const end = textarea.current?.selectionEnd ?? start
    const text = draft.text.slice(0, start) + emoji + draft.text.slice(end)
    if (text.length > 4000) return
    patch({ text })
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(start + emoji.length, start + emoji.length) })
  }

  return (
    <form className="whatsapp-composer" aria-label={`Write a ${sms ? 'Telnyx' : 'WhatsApp'} message`} onSubmit={send}>
      {draft.file ? <div className="attachment-preview">
        {preview ? <img src={preview} alt="Selected attachment preview" /> : <Icon name="attach" />}
        <span>{draft.sticker ? 'Sticker · ' : ''}{draft.file.name}</span>
        <button type="button" className="icon-button" aria-label="Remove attachment" disabled={sending} onClick={() => patch({ file: undefined, sticker: false })}><Icon name="close" /></button>
      </div> : null}
      <fieldset disabled={!connected || sending}>
        <div className="composer-input">
          <button type="button" className="icon-button" aria-label={sms ? 'Attach MMS photo' : 'Attach photo or file'} onClick={() => files.current?.click()}><Icon name="attach" /></button>
          <button type="button" className="icon-button" aria-label="Insert emoji" popoverTarget={`${channel}-emojis`}><Icon name="smile" /></button>
          {!sms && <button type="button" className="icon-button" aria-label="Attach WebP sticker" onClick={() => stickers.current?.click()}><Icon name="sticker" /></button>}
          <textarea ref={textarea} aria-label="Message" title="Enter to send, Shift+Enter for a new line" placeholder={connected ? 'Type a message' : sms ? 'Configure Telnyx and select a sending number' : 'Reconnect WhatsApp to send messages'} rows={1} maxLength={4000} value={draft.text}
            onChange={event => patch({ text: event.target.value })}
            onPaste={event => { const file = event.clipboardData.files[0]; if (file) { event.preventDefault(); attach(file) } }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event) } }} />
          <button type="submit" className="primary composer-send" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!draft.text.trim() && !draft.file}><Icon name="send" /></button>
        </div>
        <input ref={files} className="sr-only" tabIndex={-1} type="file" accept={sms ? 'image/png,image/jpeg' : undefined} aria-label="Photo or file" onChange={event => { attach(event.target.files?.[0]); event.target.value = '' }} />
        {!sms && <input ref={stickers} className="sr-only" tabIndex={-1} type="file" accept="image/webp,.webp" aria-label="WebP sticker" onChange={event => { attach(event.target.files?.[0], true); event.target.value = '' }} />}
      </fieldset>
      <div id={`${channel}-emojis`} className="emoji-picker" popover="auto" aria-label="Emoji picker">
        {emojis.map(emoji => <button key={emoji} type="button" aria-label={`Insert ${emoji}`} disabled={!connected || sending} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
      </div>
      {errors[jid] ? <p className="note" role="alert">{errors[jid]}</p> : null}
    </form>
  )
}
