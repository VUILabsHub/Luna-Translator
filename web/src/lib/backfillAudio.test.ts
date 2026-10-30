import { describe, expect, it, vi } from 'vitest'
import { BACKFILL_FRAME_MS, createPCMReplayRecorderFactory, wavToPCM16Mono16k } from './backfillAudio'

function wav(samples: Int16Array, sampleRate = 16_000, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, dataBytes, true)
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true))
  return new Uint8Array(buffer)
}

describe('wavToPCM16Mono16k', () => {
  it('16k 单声道原样返回', () => {
    const samples = new Int16Array([1, -2, 3, -4])
    expect(Array.from(wavToPCM16Mono16k(wav(samples)))).toEqual([1, -2, 3, -4])
  })

  it('双声道取平均，8k 重采样到 16k', () => {
    const stereo = wavToPCM16Mono16k(wav(new Int16Array([10, 20, 30, 50]), 16_000, 2))
    expect(Array.from(stereo)).toEqual([15, 40])
    const up = wavToPCM16Mono16k(wav(new Int16Array([0, 100]), 8_000))
    expect(up.length).toBe(4)
    expect(up[0]).toBe(0)
    expect(up[1]).toBe(50)
  })

  it('非 WAV 报错', () => {
    expect(() => wavToPCM16Mono16k(new Uint8Array([1, 2, 3]))).toThrow('不是 WAV 文件')
  })
})

describe('createPCMReplayRecorderFactory', () => {
  it('按 20ms 一块、2× 节奏推送，发完回调 onDone，stop 后不再推送', async () => {
    vi.useFakeTimers()
    try {
      const pcm = new Int16Array(320 * 3 + 100) // 3 整块 + 1 尾块
      pcm.fill(7)
      const frames: number[] = []
      const progress: number[] = []
      const onDone = vi.fn()
      const factory = createPCMReplayRecorderFactory({ pcm, paceFactor: 2, onProgress: (f) => progress.push(f), onDone })
      const handle = await factory((buffer) => frames.push(buffer.byteLength))
      expect(frames).toEqual([])
      vi.advanceTimersByTime(BACKFILL_FRAME_MS / 2)
      expect(frames).toEqual([640])
      vi.advanceTimersByTime(BACKFILL_FRAME_MS / 2 * 3)
      expect(frames).toEqual([640, 640, 640, 200])
      expect(onDone).not.toHaveBeenCalled()
      vi.advanceTimersByTime(BACKFILL_FRAME_MS / 2)
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(progress[progress.length - 1]).toBe(1)
      await handle.stop()
      vi.advanceTimersByTime(1000)
      expect(frames).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop 后不再推送也不回调 onDone', async () => {
    vi.useFakeTimers()
    try {
      const onDone = vi.fn()
      const factory = createPCMReplayRecorderFactory({ pcm: new Int16Array(320 * 10), paceFactor: 1, onDone })
      const frames: number[] = []
      const handle = await factory((buffer) => frames.push(buffer.byteLength))
      vi.advanceTimersByTime(BACKFILL_FRAME_MS * 2)
      expect(frames).toHaveLength(2)
      await handle.stop()
      vi.advanceTimersByTime(BACKFILL_FRAME_MS * 20)
      expect(frames).toHaveLength(2)
      expect(onDone).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
