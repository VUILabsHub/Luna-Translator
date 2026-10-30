// 结束页补译（docs/post-session-language-backfill-plan.md）：把会话录下的原文 WAV
// 解成 16k 单声道 PCM，再按节奏当作「麦克风」推给同传 hook（recorderFactory）。
// 推流默认 2× 加速：每 20ms 的音频块每 10ms 发一块；服务端 VAD/分段仍按音频时间轴工作。
import type { RecorderFactory, RecorderHandle } from '@simultrans/ui-shared/src/audio'

export const BACKFILL_SAMPLE_RATE = 16_000
/** 每块 20ms（与麦克风采集帧一致）。 */
export const BACKFILL_FRAME_MS = 20
export const BACKFILL_DEFAULT_PACE_FACTOR = 2

/**
 * 解析 WAV（PCM 16-bit）为 16k 单声道 s16le。多声道取平均；采样率不同做线性重采样。
 * 只支持无压缩 PCM（历史归档就是 pcmChunksToWav 产出的 16k/16bit/mono）。
 */
export function wavToPCM16Mono16k(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('不是 WAV 文件')
  }
  let offset = 12
  let channels = 1
  let sampleRate = BACKFILL_SAMPLE_RATE
  let bitsPerSample = 16
  let format = 1
  let data: Int16Array | null = null
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      const length = Math.min(size, bytes.byteLength - body)
      if (format !== 1 || bitsPerSample !== 16) throw new Error('只支持 16-bit PCM WAV')
      const samples = Math.floor(length / 2)
      const raw = new Int16Array(samples)
      for (let index = 0; index < samples; index += 1) raw[index] = view.getInt16(body + index * 2, true)
      data = raw
      break
    }
    offset = body + size + (size % 2)
  }
  if (!data) throw new Error('WAV 没有 data 块')
  const mono = channels > 1 ? downmix(data, channels) : data
  return sampleRate === BACKFILL_SAMPLE_RATE ? mono : resample(mono, sampleRate, BACKFILL_SAMPLE_RATE)
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index])
  return text
}

function downmix(samples: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(samples.length / channels)
  const mono = new Int16Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += samples[frame * channels + channel]
    mono[frame] = Math.round(sum / channels)
  }
  return mono
}

function resample(samples: Int16Array, from: number, to: number): Int16Array {
  const length = Math.max(1, Math.round(samples.length * to / from))
  const out = new Int16Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * from / to
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    out[index] = Math.round(samples[left] * (1 - fraction) + samples[right] * fraction)
  }
  return out
}

export type PCMReplayOptions = {
  pcm: Int16Array
  /** 推流加速倍数：2 = 每块 20ms 音频每 10ms 发一块。 */
  paceFactor?: number
  /** 进度 0..1，按已发送样本数计算。 */
  onProgress?: (fraction: number) => void
  /** 全部发完后触发（调用方随后 stop 会话让服务端收尾）。 */
  onDone?: () => void
  /** 测试注入的计时器。 */
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

/**
 * 用一段 PCM 冒充录音设备：返回 useMultilingualRealtimeSession 的 recorderFactory。
 * 每个 tick 发一块 20ms（640 字节）的 s16le；stop() 立即停止。
 */
export function createPCMReplayRecorderFactory(options: PCMReplayOptions): RecorderFactory {
  const paceFactor = options.paceFactor && options.paceFactor > 0 ? options.paceFactor : BACKFILL_DEFAULT_PACE_FACTOR
  const frameSamples = BACKFILL_SAMPLE_RATE * BACKFILL_FRAME_MS / 1000
  const schedule = options.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const cancel = options.clearInterval ?? ((id) => clearInterval(id))
  return async (onPCM): Promise<RecorderHandle> => {
    const total = options.pcm.length
    let cursor = 0
    let timer: ReturnType<typeof setInterval> | null = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (timer !== null) cancel(timer)
      timer = null
      options.onProgress?.(1)
      options.onDone?.()
    }
    const tick = () => {
      if (done) return
      if (cursor >= total) {
        finish()
        return
      }
      const end = Math.min(total, cursor + frameSamples)
      const frame = options.pcm.slice(cursor, end)
      cursor = end
      onPCM(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer)
      options.onProgress?.(cursor / total)
    }
    timer = schedule(tick, Math.max(1, Math.round(BACKFILL_FRAME_MS / paceFactor)))
    return {
      diagnostics: {
        capturePipeline: 'replay',
        inputSampleRate: BACKFILL_SAMPLE_RATE,
      } as unknown as RecorderHandle['diagnostics'],
      stop: async () => {
        done = true
        if (timer !== null) cancel(timer)
        timer = null
      },
    }
  }
}
