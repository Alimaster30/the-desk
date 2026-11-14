class WhatsAppPCM extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new ArrayBuffer(640)
    this.offset = 0
  }
  process(inputs) {
    const audio = inputs[0]?.[0]
    if (audio) for (const value of audio) {
      new DataView(this.buffer).setInt16(this.offset * 2, Math.max(-1, Math.min(1, value)) * 32767, true)
      if (++this.offset === 320) {
        this.port.postMessage(this.buffer, [this.buffer])
        this.buffer = new ArrayBuffer(640)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('whatsapp-pcm', WhatsAppPCM)
