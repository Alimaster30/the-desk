import { useEffect, useRef, useState, type FormEvent } from 'react'
import { mapState, onCallUpdate, placeCall, setCallHold, stateLabel, type TelnyxCall } from './phone'
import { Icon, PageHeading } from './ui'

const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', ''], ['#', '']]

export function Dialer({ visible, destination }: { visible: boolean; destination?: string }) {
  const [number, setNumber] = useState('')
  const [call, setCall] = useState<TelnyxCall | null>(null)
  const [live, setLive] = useState<string>()
  const [cause, setCause] = useState('')
  const [pending, setPending] = useState(false)
  const [holdPending, setHoldPending] = useState(false)
  const [ending, setEnding] = useState(false)
  const [muted, setMuted] = useState(false)
  const [recording, setRecording] = useState(false)
  const [files, setFiles] = useState<{ url: string; extension: string }[]>([])
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const downloads = useRef<string[]>([])
  const mounted = useRef(false)
  const connected = live === 'active' || live === 'answered'
  const held = live === 'held'
  const controls = Boolean(call && (connected || held))

  useEffect(() => {
    if (visible && !call && !pending && destination && /^\+[1-9]\d{7,14}$/.test(destination)) setNumber(destination)
  }, [visible, destination])

  useEffect(() => {
    mounted.current = true
    const stopRecording = () => { if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop() }
    const unsubscribe = onCallUpdate(next => {
      const state = mapState(next.state)
      const ended = state === 'hangup' || state === 'failed'
      setLive(next.state || 'requesting')
      setCause(next.cause || next.hangupCause || '')
      setCall(ended ? null : next)
      if (ended) {
        setMuted(false); setEnding(false)
        stopRecording()
      } else if (next.state === 'held' && recorder.current?.state === 'recording') {
        recorder.current.pause()
      } else if (next.state === 'active' && recorder.current?.state === 'paused') {
        recorder.current.resume()
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
      stopRecording()
      for (const url of downloads.current.splice(0)) URL.revokeObjectURL(url)
    }
  }, [])

  useEffect(() => {
    if (!visible || call) return
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [visible, Boolean(call)])

  async function dial(event: FormEvent) {
    event.preventDefault()
    if (pending || call) return
    const trimmed = number.trim()
    const digits = trimmed.replace(/\D/g, '')
    if (!/^\+?[\d\s().-]+$/.test(trimmed) || !/^[1-9]\d{7,14}$/.test(digits)) {
      setError('Enter a phone number with its country code (8 to 15 digits).')
      input.current?.focus()
      return
    }
    setError(''); setCause(''); setLive(undefined); setPending(true)
    try { await placeCall(`+${digits}`) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The call did not start.') }
    finally { setPending(false) }
  }

  function digit(key: string) {
    if (call) {
      if (connected) {
        setError('')
        try { call.dtmf?.(key) }
        catch { setError('Could not send that keypad tone.') }
      }
    } else if (!pending) setNumber(value => value + key)
  }

  async function toggleHold() {
    if (!call || holdPending) return
    setError(''); setHoldPending(true)
    try { await setCallHold(call, !held) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not change hold status.') }
    finally { setHoldPending(false) }
  }

  function toggleMute() {
    if (!call) return
    const action = muted ? call.unmuteAudio : call.muteAudio
    if (!action) return
    setError('')
    try { action.call(call); setMuted(!muted) }
    catch { setError('Could not change microphone status.') }
  }

  async function hangUp() {
    if (!call?.hangup || ending) return
    setEnding(true); setError('')
    try { await call.hangup() }
    catch { setEnding(false); setError('Could not end the call. Try again.') }
  }

  function toggleRecording() {
    setError('')
    if (recorder.current) {
      if (recorder.current.state !== 'inactive') recorder.current.stop()
      return
    }
    if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      setError('This browser does not support call recording.')
      return
    }
    const local = call?.localStream, remote = call?.remoteStream
    if (!local?.getAudioTracks().length || !remote?.getAudioTracks().length) {
      setError('Wait for both sides of the call to connect before recording.')
      return
    }
    let audio: AudioContext | undefined
    let mixed: MediaStream | undefined
    const release = () => {
      mixed?.getTracks().forEach(track => track.stop())
      void audio?.close().catch(() => undefined)
    }
    try {
      audio = new AudioContext()
      const destination = audio.createMediaStreamDestination()
      mixed = destination.stream
      for (const stream of [local, remote]) {
        const gain = audio.createGain()
        gain.gain.value = 0.5
        audio.createMediaStreamSource(stream).connect(gain).connect(destination)
      }
      const media = new MediaRecorder(mixed)
      const chunks: Blob[] = []
      media.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      media.onerror = () => setError('The recording stopped because of a browser error.')
      media.onstop = () => {
        release()
        if (!mounted.current) return
        recorder.current = null; setRecording(false)
        if (!chunks.length) { setError('The browser did not capture any audio.'); return }
        const type = media.mimeType || chunks[0].type
        const url = URL.createObjectURL(new Blob(chunks, { type }))
        downloads.current.push(url)
        setFiles(previous => [...previous, { url, extension: type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm' }])
      }
      media.start()
      recorder.current = media; setRecording(true)
      void audio.resume().catch(() => {
        if (media.state === 'recording') media.stop()
        setError('Could not start recording audio.')
      })
    } catch {
      release()
      setError('Could not start recording audio.')
    }
  }

  return (
    <main>
      <PageHeading title="Make a call" description="Enter a number with its country code to call with Telnyx."><a href="#/calls">Call history</a></PageHeading>
      <form className="dialer" onSubmit={dial}>
        <label htmlFor="dial-number">Phone number</label>
        <div className="dialer-number">
          <input ref={input} id="dial-number" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} readOnly={Boolean(call) || pending} value={number || call?.options?.destinationNumber || ''} onChange={event => setNumber(event.target.value)} placeholder="+1 415 555 1212" />
          <button type="button" aria-label="Delete last digit" disabled={!number || Boolean(call) || pending} onClick={() => setNumber(value => value.slice(0, -1))}>⌫</button>
        </div>
        <p className="dialer-status" role="status">{ending ? 'Ending call' : pending && !call ? 'Connecting to Telnyx' : stateLabel(live)}{recording ? held ? ' · Recording paused' : ' · Recording' : ''}{cause && !call ? ` · ${cause}` : ''}</p>
        <div className="dialer-pad" role="group" aria-label={call ? 'In-call keypad' : 'Number keypad'}>
          {keys.map(([key, letters]) => <button type="button" key={key} aria-label={key === '*' ? 'Star' : key === '#' ? 'Pound' : key} disabled={pending || Boolean(call && (!connected || !call.dtmf))} onClick={() => digit(key)}>{key}{letters && <small aria-hidden="true">{letters}</small>}</button>)}
        </div>
        {controls && <div className="dialer-controls" role="group" aria-label="Call controls">
          <button type="button" disabled={!controls || !call?.muteAudio || ending} onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
          <button type="button" disabled={!controls || !call?.hold || holdPending || ending} onClick={toggleHold}>{held ? 'Resume' : 'Hold'}</button>
          <button type="button" disabled={!recording && (!connected || ending)} onClick={toggleRecording}>{recording ? 'Stop recording' : 'Record'}</button>
        </div>}
        {call ? <button key="hangup" type="button" className="stop dialer-main" disabled={ending} onClick={event => { event.preventDefault(); void hangUp() }}><Icon name="phone" size={17} /> Hang up</button>
          : <button key="call" type="submit" className="primary dialer-main" disabled={pending}><Icon name="phone" size={17} /> Call</button>}
        {error && <p role="alert">{error}</p>}
        {files.map((file, i) => <a key={file.url} className="action-link" href={file.url} download={`call-recording-${i + 1}.${file.extension}`}>Download recording {i + 1}</a>)}
        <p className="note">{call ? 'Recordings are saved here for download until you leave the app.' : 'Your browser may ask for microphone access.'}</p>
      </form>
    </main>
  )
}
