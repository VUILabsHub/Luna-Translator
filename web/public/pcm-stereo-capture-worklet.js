class PCMStereoCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
    this.frameSize = Math.max(1, Math.round(this.targetRate / 50))
    this.leftFrame = new Int16Array(this.frameSize)
    this.rightFrame = new Int16Array(this.frameSize)
    this.frameOffset = 0
    this.ratePhase = 0
    this.channelCountReported = false
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
    const channels = inputs[0] || []
    if (!this.channelCountReported) {
      this.channelCountReported = true
      this.port.postMessage({ type: 'channel-count', channelCount: channels.length })
    }
    const left = channels[0]
    const right = channels[1]
    if (!left || !right) return true
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      this.ratePhase += this.targetRate
      if (this.ratePhase < sampleRate) continue
      this.ratePhase -= sampleRate
      this.leftFrame[this.frameOffset] = this.toPCM16(left[index])
      this.rightFrame[this.frameOffset] = this.toPCM16(right[index])
      this.frameOffset += 1
      if (this.frameOffset === this.frameSize) this.flush()
    }
    return true
  }

  toPCM16(value) {
    const sample = Math.max(-1, Math.min(1, value))
    return sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  flush() {
    if (this.frameOffset === 0) return
    const left = this.frameOffset === this.frameSize ? this.leftFrame : this.leftFrame.slice(0, this.frameOffset)
    const right = this.frameOffset === this.frameSize ? this.rightFrame : this.rightFrame.slice(0, this.frameOffset)
    this.port.postMessage({ type: 'stereo-pcm', left: left.buffer, right: right.buffer }, [left.buffer, right.buffer])
    this.leftFrame = new Int16Array(this.frameSize)
    this.rightFrame = new Int16Array(this.frameSize)
    this.frameOffset = 0
  }
}

registerProcessor('pcm-stereo-capture-processor', PCMStereoCaptureProcessor)
