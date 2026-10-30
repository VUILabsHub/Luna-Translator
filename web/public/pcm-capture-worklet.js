class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requestedRate = Number(options?.processorOptions?.targetSampleRate)
    this.targetRate = Number.isFinite(requestedRate) && requestedRate > 0
      ? Math.round(requestedRate)
      : 16000
    this.frameSize = Math.max(1, Math.round(this.targetRate / 50))
    this.frame = new Int16Array(this.frameSize)
    this.frameOffset = 0
    this.ratePhase = 0
    this.stopped = false
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return
      this.stopped = true
      this.flush()
      this.port.postMessage({ type: 'flushed' })
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (!input) return true
    for (let index = 0; index < input.length; index += 1) {
      this.ratePhase += this.targetRate
      if (this.ratePhase < sampleRate) continue
      this.ratePhase -= sampleRate
      const sample = Math.max(-1, Math.min(1, input[index]))
      this.frame[this.frameOffset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.frameOffset += 1
      if (this.frameOffset === this.frame.length) this.flush()
    }
    return true
  }

  flush() {
    if (this.frameOffset === 0) return
    const pcm = this.frameOffset === this.frame.length
      ? this.frame
      : this.frame.slice(0, this.frameOffset)
    this.port.postMessage(pcm.buffer, [pcm.buffer])
    this.frame = new Int16Array(this.frameSize)
    this.frameOffset = 0
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor)
