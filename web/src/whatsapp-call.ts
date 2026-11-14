import { useEffect, useRef, useState } from 'react'

type Phase = 'connecting' | 'ringing' | 'answered' | 'ended' | 'failed'

async function connect(jid: string, signal: AbortSignal, status: (phase: Phase) => void) {
  let stream: MediaStream | undefined, audio: AudioContext | undefined, socket: WebSocket | undefined
  let capture: AudioWorkletNode | undefined, answered = false, closed = false, playback = 0
  const cleanup = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', abort)
    stream?.getTracks().forEach(track => track.stop())
    if (capture) { capture.port.onmessage = null; capture.disconnect() }
    socket?.close()
    void audio?.close().catch(() => undefined)
  }
  const finish = (phase: Phase) => { if (!closed) { cleanup(); status(phase) } }
  const abort = () => finish('ended')
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Use a browser with microphone and audio-worklet support.')
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
    if (signal.aborted) { microphone.getTracks().forEach(track => track.stop()); signal.throwIfAborted() }
    stream = microphone
    audio = new AudioContext({ sampleRate: 16000 })
    if (audio.sampleRate !== 16000) throw new Error('This browser cannot provide the audio format needed for WhatsApp calls.')
    await audio.resume()
    await audio.audioWorklet.addModule('/whatsapp-pcm.js')
    signal.throwIfAborted()
    capture = new AudioWorkletNode(audio, 'whatsapp-pcm', { channelCount: 1, channelCountMode: 'explicit' })
    audio.createMediaStreamSource(stream).connect(capture)
    const silent = audio.createGain()
    silent.gain.value = 0
    capture.connect(silent).connect(audio.destination)
    const response = await fetch(`/api/whatsapp/chats/${encodeURIComponent(jid)}/call`, { method: 'POST', signal })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'The WhatsApp call could not start.')
    signal.throwIfAborted()
    const url = new URL(body.path, window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    capture.port.onmessage = event => {
      if (!closed && answered && socket?.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 64000) finish('failed')
        else socket.send(event.data)
      }
    }
    socket.onmessage = event => {
      if (closed) return
      try {
        if (typeof event.data === 'string') {
          const next = JSON.parse(event.data).event
          if (next === 'answered') { answered = true; status('answered') }
          else if (next === 'ringing') status('ringing')
          else if (next === 'ended') finish('ended')
          else if (next === 'error') finish('failed')
          return
        }
        if (!audio || !answered || !(event.data instanceof ArrayBuffer) || event.data.byteLength % 2) return
        const data = new DataView(event.data)
        const buffer = audio.createBuffer(1, data.byteLength / 2, 16000)
        const samples = buffer.getChannelData(0)
        for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 2, true) / 32768
        if (playback - audio.currentTime > 0.5) { finish('failed'); return }
        const source = audio.createBufferSource()
        source.buffer = buffer
        source.connect(audio.destination)
        playback = Math.max(audio.currentTime + 0.02, playback)
        source.start(playback)
        playback += buffer.duration
      } catch { finish('failed') }
    }
    socket.onerror = () => finish('failed')
    socket.onclose = () => finish('ended')
    return { mute: (muted: boolean) => stream?.getAudioTracks().forEach(track => { track.enabled = !muted }) }
  } catch (reason) { cleanup(); throw reason }
}

export function useWhatsAppCall() {
  const [call, setCall] = useState<{ jid: string; name: string; phase: Phase } | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<{ controller: AbortController; mute?: (muted: boolean) => void } | null>(null)
  useEffect(() => () => { active.current?.controller.abort() }, [])
  async function start(jid: string, name: string) {
    if (active.current) return
    const session = { controller: new AbortController(), mute: undefined as ((muted: boolean) => void) | undefined }
    active.current = session
    setError(''); setMuted(false); setCall({ jid, name, phase: 'connecting' })
    try {
      const controls = await connect(jid, session.controller.signal, phase => {
        if (active.current !== session) return
        setCall({ jid, name, phase })
        if (phase === 'ended' || phase === 'failed') {
          active.current = null
          if (phase === 'failed') setError('The WhatsApp call connection failed. Check the voice device and try again.')
        }
      })
      session.mute = controls.mute
    } catch (reason) {
      if (active.current !== session) return
      active.current = null; setCall(null)
      if (!session.controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not start the call.')
    }
  }
  const ongoing = Boolean(call && !['ended', 'failed'].includes(call.phase))
  return {
    call, muted, error, ongoing, start,
    end: () => active.current?.controller.abort(),
    toggleMute: () => { active.current?.mute?.(!muted); setMuted(value => !value) },
  }
}
