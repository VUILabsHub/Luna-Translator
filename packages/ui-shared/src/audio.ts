import { defaultAudioInputKey, getDefaultAudioInput } from './defaultAudioInput'
import { monitorOutputConflict } from './lib/audioMonitorDevices'

export type EchoCancellationSetting = boolean | 'all' | 'remote-only' | null

export type BrowserAudioProcessingOptions = {
  noiseSuppression: boolean
  autoGainControl: boolean
  voiceIsolation: boolean
}

export const defaultBrowserAudioProcessing: BrowserAudioProcessingOptions = {
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
}

export type AudioProcessingDiagnostics = {
  inputDeviceId?: string
  inputDeviceLabel?: string
  inputDeviceGroupId?: string
  defaultInputDeviceKey?: string
  echoCancellation: EchoCancellationSetting
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  voiceIsolation: boolean | null
  capturePipeline: 'audio-worklet' | 'script-processor' | 'rtc-sdk'
  capturePurpose: 'websocket-input' | 'rtc-local-archive'
  applyConstraintsError?: string
  captureError?: string
  /** 采集链路：raw = 关闭浏览器处理（默认）；system = 手机通话模式（系统 AEC/NS/AGC）。 */
  inputProcessing?: 'raw' | 'system'
  /** 浏览器回读的实际采样率 / 声道数（通话模式下常见 48k 或蓝牙窄带）。 */
  inputSampleRate?: number
  inputChannelCount?: number
}

export type RecorderOptions = {
  /** Cancels late permission/context work and already acquired tracks. */
  signal?: AbortSignal
  /**
   * 'system'：手机通话模式——请求 echoCancellation/noiseSuppression/autoGainControl，
   * iOS WebKit 会走 VoiceProcessingIO，Android Chrome 会进 MODE_IN_COMMUNICATION
   * （docs/web-phone-call-mode-plan.md）。默认 'raw'：关闭全部浏览器处理。
   */
  processing?: 'raw' | 'system'
  browserAudioProcessing?: BrowserAudioProcessingOptions
}

export function echoCancellationSetting(value: unknown): EchoCancellationSetting {
  if (typeof value === 'boolean' || value === 'all' || value === 'remote-only') return value
  return null
}

type VoiceIsolationConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean
  /** TS 的 lib.dom 没有收录，但 Chrome/Safari 都支持。 */
  latency?: ConstrainDouble
}

type VoiceIsolationSettings = MediaTrackSettings & {
  voiceIsolation?: boolean
}

export type RecorderHandle = {
  diagnostics: AudioProcessingDiagnostics
  inputTrack?: MediaStreamTrack
  stop: () => Promise<void>
}

export type RecorderFactory = (onPCM: (buffer: ArrayBuffer) => void) => Promise<RecorderHandle>

export type PCMTrackReaderHandle = {
  capturePipeline: AudioProcessingDiagnostics['capturePipeline']
  stop: () => Promise<void>
}

export function pcm16Peak(pcm: Uint8Array) {
  const byteLength = pcm.byteLength - (pcm.byteLength % 2)
  const view = new DataView(pcm.buffer, pcm.byteOffset, byteLength)
  let peak = 0
  for (let offset = 0; offset < byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)))
  }
  return peak
}

export function pcm16HasSignal(pcm: Uint8Array, minimumPeak = 8) {
  return pcm16Peak(pcm) >= minimumPeak
}

export function pcm16DurationMs(byteLength: number, sampleRate: number) {
  if (!Number.isFinite(byteLength) || byteLength < 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null
  }
  const sampleCount = Math.floor(byteLength / 2)
  const durationMs = sampleCount / sampleRate * 1000
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null
}

export function accumulatePCM16SegmentDurationMs(
  byteTotalsBySegment: Map<string, number>,
  segmentId: string,
  chunkByteLength: number,
  sampleRate: number,
) {
  if (!segmentId || !Number.isFinite(chunkByteLength) || chunkByteLength < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null
  }
  const totalBytes = (byteTotalsBySegment.get(segmentId) || 0) + Math.floor(chunkByteLength)
  byteTotalsBySegment.set(segmentId, totalBytes)
  return pcm16DurationMs(totalBytes, sampleRate)
}

export type PCMPlaybackCallbacks = {
  onStart?: (startedAt: number) => void
  onEnded?: () => void
}

export type PCMStreamPlayer = {
  getBufferedDurationMs?: () => number
  clearBuffer?: () => void
  push: (pcm: Uint8Array, sampleRate: number, callbacks?: PCMPlaybackCallbacks) => number | null
  setMuted: (muted: boolean) => void
  /** Local translated playback gain (0–1), independent of microphone capture and muting. */
  setVolume?: (volume: number) => void
  setOutputDevice: (outputDeviceId: string) => Promise<void>
  /** Optional local monitor; never changes the primary output or publishes PCM. */
  setMonitorOutput?: (deviceId: string | null, onError?: (message: string) => void) => Promise<void>
  setMonitorVolume?: (volume: number) => void
  drain: () => Promise<void>
  close: () => Promise<void>
}

export type PCMStreamTrackPlayer = PCMStreamPlayer & {
  mediaStreamTrack: MediaStreamTrack
}

type SinkSelectableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>
}

const CONTEXT_OPERATION_TIMEOUT_MS = 5_000
const DRAIN_GRACE_MS = 5_000

export type PCMOutputChannel = 'both' | 'left' | 'right'

export async function createPCMStreamPlayer(outputDeviceId = 'default', outputChannel: PCMOutputChannel = 'both'): Promise<PCMStreamPlayer> {
  return createPCMStreamOutput(outputDeviceId, false, outputChannel)
}

export async function createPCMStreamTrackPlayer(): Promise<PCMStreamTrackPlayer> {
  const player = await createPCMStreamOutput('default', true)
  if (!player.mediaStreamTrack) {
    await player.close()
    throw new Error('浏览器无法创建火山 RTC 翻译音轨。')
  }
  return player as PCMStreamTrackPlayer
}

async function createPCMStreamOutput(
  outputDeviceId: string,
  publishTrack: boolean,
  outputChannel: PCMOutputChannel = 'both',
): Promise<PCMStreamPlayer & { mediaStreamTrack?: MediaStreamTrack }> {
  const context = new AudioContext()
  const mediaDestination = publishTrack ? context.createMediaStreamDestination() : null
  const mediaStreamTrack = mediaDestination?.stream.getAudioTracks()[0]
  const selectOutputDevice = async (deviceId: string) => {
    if (mediaDestination) return
    const selectableContext = context as SinkSelectableAudioContext
    if (!selectableContext.setSinkId) {
      throw new Error('当前浏览器不支持指定音频输出设备，请改用系统默认输出。')
    }
    try {
      await withTimeout(
        selectableContext.setSinkId(deviceId === 'default' ? '' : deviceId),
        CONTEXT_OPERATION_TIMEOUT_MS,
        '浏览器无法在 5 秒内切换音频输出设备。',
      )
    } catch {
      throw new Error('无法使用所选音频输出设备，请确认设备仍已连接。')
    }
  }
  if (outputDeviceId !== 'default') {
    try {
      await selectOutputDevice(outputDeviceId)
    } catch (caught) {
      await closeAudioContextBestEffort(context)
      throw caught
    }
  }
  try {
    await withTimeout(
      context.resume(),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器无法在 5 秒内启动音频输出。',
    )
  } catch (caught) {
    await closeAudioContextBestEffort(context)
    throw caught
  }
  let nextStartTime = 0
  let latestObservedStartTime = -Infinity
  let trailingByte: number | null = null
  let trailingSampleRate: number | null = null
  let invalidPCMReason = ''
  let closed = false
  let closePromise: Promise<void> | null = null
  let resumePromise: Promise<void> | null = null
  let signalClosed: () => void = () => undefined
  const closedSignal = new Promise<void>((resolve) => {
    signalClosed = resolve
  })
  const pendingSources = new Set<AudioBufferSourceNode>()
  const drainWaiters = new Set<() => void>()
  const startTimers = new Set<number>()
  const outputGain = context.createGain()
  let playbackVolume = 1
  let playbackMuted = false
  outputGain.gain.value = 1
  outputGain.connect(mediaDestination || context.destination)

  type Monitor = {
    deviceId: string
    gain: GainNode
    destination: MediaStreamAudioDestinationNode
    audio: HTMLAudioElement
    connected: boolean
    cancelled: Promise<void>
    cancel: () => void
    onError?: (message: string) => void
  }
  let primaryDeviceId = outputDeviceId
  let pendingPrimaryDeviceId: string | null = null
  let monitorGeneration = 0
  let monitorVolume = 1
  let monitor: Monitor | null = null
  const monitorBranches = new Set<Monitor>()
  const releaseMonitor = (branch: Monitor) => {
    branch.cancel()
    branch.audio.onerror = null
    branch.audio.muted = true
    branch.audio.pause()
    branch.audio.srcObject = null
    if (branch.connected) {
      try { outputGain.disconnect(branch.gain) } catch { /* Already detached. */ }
      branch.connected = false
    }
    try { branch.gain.disconnect() } catch { /* Already detached. */ }
    branch.destination.stream.getTracks().forEach((track) => track.stop())
    monitorBranches.delete(branch)
    if (monitor === branch) monitor = null
  }
  const disableMonitor = () => {
    monitorGeneration += 1
    for (const branch of [...monitorBranches]) releaseMonitor(branch)
  }
  const reportMonitorError = (callback: Monitor['onError'], message: string) => {
    try { callback?.(message) } catch { /* A UI callback must not interrupt primary audio. */ }
  }
  const setMonitorOutput = async (deviceId: string | null, onError?: Monitor['onError']) => {
    if (deviceId && monitor?.deviceId === deviceId && monitor.connected && !closed) {
      monitor.onError = onError
      return
    }
    disableMonitor()
    if (deviceId === null) return
    if (closed || context.state === 'closed') throw new Error('音频播放器已经关闭。')
    if (!deviceId.trim() || deviceId === 'default' || deviceId === 'communications' || deviceId === primaryDeviceId || deviceId === pendingPrimaryDeviceId) {
      throw new Error('请为本地监听选择与主输出不同的明确耳机设备。')
    }
    const generation = monitorGeneration
    const audio = new Audio()
    if (typeof audio.setSinkId !== 'function') throw new Error('当前浏览器不支持独立耳机监听。')
    const destination = context.createMediaStreamDestination()
    const gain = context.createGain()
    gain.gain.value = monitorVolume
    gain.connect(destination)
    let cancel: () => void = () => undefined
    const cancelled = new Promise<void>((resolve) => { cancel = resolve })
    const branch: Monitor = { deviceId, audio, destination, gain, connected: false, cancelled, cancel, onError }
    monitorBranches.add(branch)
    const assertCurrent = () => {
      if (closed || monitorGeneration !== generation || !monitorBranches.has(branch)) throw new Error('本地监听设置已取消。')
      if (deviceId === primaryDeviceId || deviceId === pendingPrimaryDeviceId) throw new Error('本地监听与主输出相同，已关闭监听以避免重复播放。')
    }
    audio.autoplay = false
    audio.muted = true
    audio.srcObject = destination.stream
    audio.onerror = () => {
      if (!monitorBranches.has(branch)) return
      releaseMonitor(branch)
      reportMonitorError(branch.onError, '耳机监听已中断，主输出保持播放；请重新选择监听设备。')
    }
    try {
      await withTimeout(Promise.race([audio.setSinkId(deviceId), cancelled]), CONTEXT_OPERATION_TIMEOUT_MS, '无法在 5 秒内连接耳机监听。')
      assertCurrent()
      await withTimeout(Promise.race([audio.play(), cancelled]), CONTEXT_OPERATION_TIMEOUT_MS, '无法在 5 秒内启动耳机监听。')
      assertCurrent()
      // Teams can restore the system-default route while sink/play is pending.
      // Re-read the aliases immediately before connecting; a stale UI selection
      // must not turn the restored primary headphones into duplicate playback.
      const devices = await withTimeout(Promise.race([navigator.mediaDevices.enumerateDevices(), cancelled]), CONTEXT_OPERATION_TIMEOUT_MS, '无法确认耳机监听设备。')
      assertCurrent()
      if (!devices?.some((device) => device.kind === 'audiooutput' && device.deviceId === deviceId)) throw new Error('监听设备已断开。')
      if ([primaryDeviceId, pendingPrimaryDeviceId].some((mainDeviceId) => mainDeviceId !== null && monitorOutputConflict({ monitorDeviceId: deviceId, mainDeviceId, rawDevices: devices }))) {
        throw new Error('本地监听与主输出相同，已关闭监听以避免重复播放。')
      }
      // Attach only after the explicit sink and playback have both succeeded.
      // A pending/failed monitor must never briefly play through system default.
      outputGain.connect(gain)
      branch.connected = true
      audio.muted = playbackMuted
      monitor = branch
    } catch (caught) {
      releaseMonitor(branch)
      if (closed || monitorGeneration !== generation) throw new Error('本地监听设置已取消。')
      throw new Error(caught instanceof Error && caught.message === '本地监听与主输出相同，已关闭监听以避免重复播放。'
        ? caught.message : '无法启用耳机监听，主输出保持播放；请检查设备和浏览器播放权限。')
    }
  }

  const isPaused = () => {
    const state = String(context.state)
    return state === 'suspended' || state === 'interrupted'
  }

  const resumeIfNeeded = async () => {
    if (closed || context.state === 'closed' || !isPaused()) return
    if (!resumePromise) resumePromise = context.resume()
    const currentResume = resumePromise
    try {
      await currentResume
    } finally {
      if (resumePromise === currentResume) resumePromise = null
    }
  }

  const requestResume = () => {
    void resumeIfNeeded().catch(() => undefined)
  }

  const settleDrainWaiters = () => {
    if (pendingSources.size > 0) return
    const waiters = [...drainWaiters]
    drainWaiters.clear()
    waiters.forEach((resolve) => resolve())
  }

  const finishSource = (source: AudioBufferSourceNode) => {
    if (!pendingSources.delete(source)) return
    source.onended = null
    try {
      source.disconnect?.()
    } catch {
      // The source may already be disconnected by a forced close.
    }
    settleDrainWaiters()
  }

  const onStateChange = () => {
    if (isPaused()) requestResume()
  }
  context.addEventListener?.('statechange', onStateChange)

  return {
    ...(mediaStreamTrack ? { mediaStreamTrack } : {}),
    ...(!publishTrack ? {
      setMonitorOutput,
      setMonitorVolume: (volume: number) => {
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('监听音量必须在 0 到 1 之间。')
        monitorVolume = volume
        for (const branch of monitorBranches) branch.gain.gain.value = volume
      },
    } : {}),
    getBufferedDurationMs: () => closed ? 0 : Math.max(0, nextStartTime - context.currentTime) * 1000,
    clearBuffer: () => {
      if (closed) return
      // Recreate the monitor stream to discard its separate media-element queue.
      const previousMonitor = monitor
      disableMonitor()
      if (previousMonitor) void setMonitorOutput(previousMonitor.deviceId, previousMonitor.onError).catch((caught) => {
        if (!closed && monitorGeneration === clearGeneration) reportMonitorError(previousMonitor.onError, caught instanceof Error ? caught.message : '耳机监听恢复失败。')
      })
      const clearGeneration = monitorGeneration
      startTimers.forEach(timer => window.clearTimeout(timer))
      startTimers.clear()
      for (const source of [...pendingSources]) {
        source.onended = null
        try { source.stop() } catch { /* Already ended. */ }
        finishSource(source)
      }
      nextStartTime = context.currentTime
      latestObservedStartTime = -Infinity
      trailingByte = null
      trailingSampleRate = null
      invalidPCMReason = ''
      requestResume()
    },
    setMuted: (muted) => {
      playbackMuted = muted
      outputGain.gain.value = muted ? 0 : playbackVolume
      if (monitor) monitor.audio.muted = muted
    },
    setVolume: (volume) => {
      if (!Number.isFinite(volume)) return
      playbackVolume = Math.max(0, Math.min(1, volume))
      outputGain.gain.value = playbackMuted ? 0 : playbackVolume
    },
    setOutputDevice: async (deviceId) => {
      if (closed || context.state === 'closed') throw new Error('音频播放器已经关闭。')
      // Remove an explicit collision before routing primary audio there, so the
      // browser cannot briefly play both paths through the same headphones.
      for (const branch of [...monitorBranches]) {
        if (branch.deviceId !== deviceId) continue
        releaseMonitor(branch)
        reportMonitorError(branch.onError, '本地监听与主输出相同，已关闭监听以避免重复播放。')
      }
      pendingPrimaryDeviceId = deviceId
      try {
        await selectOutputDevice(deviceId)
        primaryDeviceId = deviceId
      } finally {
        pendingPrimaryDeviceId = null
      }
    },
    push: (pcm, sampleRate, callbacks) => {
      if (closed || context.state === 'closed') return null
      requestResume()

      let completeBytes = pcm
      if (trailingByte !== null) {
        if (trailingSampleRate !== sampleRate) {
          invalidPCMReason = '翻译音频在不完整的 PCM16 采样之间切换了采样率。'
        } else {
          const combined = new Uint8Array(pcm.byteLength + 1)
          combined[0] = trailingByte
          combined.set(pcm, 1)
          completeBytes = combined
        }
        trailingByte = null
        trailingSampleRate = null
      }
      if (completeBytes.byteLength % 2 !== 0) {
        trailingByte = completeBytes[completeBytes.byteLength - 1]
        trailingSampleRate = sampleRate
        completeBytes = completeBytes.subarray(0, completeBytes.byteLength - 1)
      }

      const samples = pcm16BytesToFloat32(completeBytes)
      if (samples.length === 0) return null
      // Stereo buffers leave the other channel silent; do not let mono upmix
      // duplicate one participant's speech into both ears.
      const buffer = context.createBuffer(outputChannel === 'both' ? 1 : 2, samples.length, sampleRate)
      buffer.copyToChannel(samples, outputChannel === 'right' ? 1 : 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(outputGain)
      const startTime = Math.max(context.currentTime + 0.03, nextStartTime)
      const timestamp = context.getOutputTimestamp?.()
      const scheduledAt = timestamp && timestamp.performanceTime !== undefined && timestamp.contextTime !== undefined
        ? timestamp.performanceTime + Math.max(0, startTime - timestamp.contextTime) * 1000
        : performance.now() + Math.max(0, startTime - context.currentTime) * 1000
      pendingSources.add(source)
      let startTimer: number | null = null
      let startObserved = false
      let renderEnded = false
      const endTime = startTime + buffer.duration
      const playbackTime = () => {
        const output = publishTrack ? undefined : context.getOutputTimestamp?.()
        return output && typeof output.contextTime === 'number' && Number.isFinite(output.contextTime)
          && (output.contextTime > 0 || (output.performanceTime || 0) > 0)
          ? Math.min(context.currentTime, output.contextTime)
          : context.currentTime
      }
      const scheduleStartObservation = (delayMs: number) => {
        const timer = window.setTimeout(() => {
          startTimers.delete(timer)
          if (startTimer === timer) startTimer = null
          if (closed) return
          const playedTime = playbackTime()
          if (context.state === 'running') {
            if (!startObserved && playedTime >= startTime) {
              startObserved = true
              // Delayed timer/onended tasks can arrive out of order. A chunk
              // already passed by the output clock must not steal the highlight.
              if (startTime > latestObservedStartTime && playedTime < endTime) {
                latestObservedStartTime = startTime
                callbacks?.onStart?.(performance.now())
              }
            }
            if (renderEnded && playedTime >= endTime) {
              finishSource(source)
              callbacks?.onEnded?.()
              return
            }
          }
          if (startObserved && !renderEnded) return
          if (isPaused()) requestResume()
          const remainingMs = Math.max(0, (startObserved ? endTime : startTime) - playedTime) * 1000
          scheduleStartObservation(remainingMs > 0 ? remainingMs : 10)
        }, Math.max(0, delayMs))
        startTimer = timer
        startTimers.add(timer)
      }
      scheduleStartObservation(Math.max(0, startTime - playbackTime()) * 1000)
      const clearStartTimer = () => {
        if (startTimer === null) return
        window.clearTimeout(startTimer)
        startTimers.delete(startTimer)
        startTimer = null
      }
      source.onended = () => {
        // Rendering can end before a short chunk reaches a Bluetooth device.
        // Observe both notifications on the output clock, preserving start.
        renderEnded = true
        clearStartTimer()
        scheduleStartObservation(0)
      }
      try {
        source.start(startTime)
      } catch (error) {
        clearStartTimer()
        finishSource(source)
        throw error
      }
      nextStartTime = startTime + buffer.duration
      return scheduledAt
    },
    drain: async () => {
      if (closed || context.state === 'closed') return
      await Promise.race([
        withTimeout(
          resumeIfNeeded(),
          CONTEXT_OPERATION_TIMEOUT_MS,
          '浏览器无法在 5 秒内恢复音频输出。',
        ),
        closedSignal,
      ])
      if (closed) return
      if (isPaused()) throw new Error('浏览器音频输出仍处于暂停状态。')
      if (pendingSources.size > 0) {
        const remainingMs = Number.isFinite(nextStartTime) && Number.isFinite(context.currentTime)
          ? Math.max(0, nextStartTime - context.currentTime) * 1000
          : 0
        let resolveDrain: (() => void) | null = null
        const pendingDrain = new Promise<void>((resolve) => {
          resolveDrain = resolve
          if (closed || pendingSources.size === 0) {
            resolve()
            return
          }
          drainWaiters.add(resolve)
        })
        try {
          await withTimeout(
            pendingDrain,
            Math.max(CONTEXT_OPERATION_TIMEOUT_MS, remainingMs + DRAIN_GRACE_MS),
            '翻译音频播放队列未能在预计时间内排空。',
          )
        } finally {
          if (resolveDrain) drainWaiters.delete(resolveDrain)
        }
      }
      if (invalidPCMReason) throw new Error(invalidPCMReason)
      if (trailingByte !== null) throw new Error('翻译音频包含不完整的 PCM16 采样。')
      if (monitor && !closed) {
        // Media-element/physical-device latency is not observable through the
        // primary AudioContext clock. Allow a bounded tail, never a second PCM
        // scheduling queue or a claim of sample-perfect device synchronization.
        let timer: ReturnType<typeof window.setTimeout> | undefined
        try {
          await Promise.race([
            new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 500) }),
            closedSignal,
          ])
        } finally {
          window.clearTimeout(timer)
        }
      }
    },
    close: () => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closed = true
        disableMonitor()
        signalClosed()
        trailingByte = null
        trailingSampleRate = null
        invalidPCMReason = ''
        context.removeEventListener?.('statechange', onStateChange)
        startTimers.forEach((timer) => window.clearTimeout(timer))
        startTimers.clear()
        pendingSources.forEach((source) => {
          source.onended = null
          try {
            source.stop?.()
          } catch {
            // A source which already ended cannot be stopped again.
          }
          try {
            source.disconnect?.()
          } catch {
            // The source may already be disconnected.
          }
        })
        pendingSources.clear()
        settleDrainWaiters()
        try {
          outputGain.disconnect()
        } catch {
          // The gain node may already have been disconnected by the browser.
        }
        mediaStreamTrack?.stop()
        if (context.state !== 'closed') {
          await withTimeout(
            context.close(),
            CONTEXT_OPERATION_TIMEOUT_MS,
            '浏览器音频输出未能及时关闭。',
          )
        }
      })()
      return closePromise
    },
  }
}

export async function createRecorder(
  onPCM: (buffer: ArrayBuffer) => void,
  inputDeviceId = 'default',
  options: RecorderOptions = {},
): Promise<RecorderHandle> {
  const assertActive = () => { if (options.signal?.aborted) throw new DOMException('麦克风采集已取消。', 'AbortError') }
  assertActive()
  const systemProcessing = options.processing === 'system'
  const browserProcessing = options.browserAudioProcessing ?? defaultBrowserAudioProcessing
  const defaultInput = inputDeviceId === 'default' ? await getDefaultAudioInput() : null
  assertActive()
  // Before permission, some browsers expose no device IDs. Request permission
  // normally in that case; the returned track remains the source of truth.
  const captureDeviceId = inputDeviceId === 'default' ? defaultInput?.deviceId : inputDeviceId
  let stream: MediaStream
  try {
    const audioConstraints: VoiceIsolationConstraints = systemProcessing
      ? {
          ...(captureDeviceId ? { deviceId: { exact: captureDeviceId } } : {}),
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          latency: { ideal: 0.02 },
        }
      : {
          ...(captureDeviceId ? { deviceId: { exact: captureDeviceId } } : {}),
          channelCount: 1,
          echoCancellation: { exact: false },
          ...browserProcessing,
        }
    if (systemProcessing) requestPlayAndRecordAudioSession()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    })
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'NotFoundError') {
      throw new Error('找不到所选麦克风，请重新选择或改用系统默认麦克风。')
    }
    if (caught instanceof DOMException && (caught.name === 'NotAllowedError' || caught.name === 'SecurityError')) {
      throw new Error('麦克风权限未开启，请在浏览器地址栏允许后重试。')
    }
    throw caught
  }
  let context: AudioContext | null = null
  let streamStopped = false
  const stopStream = () => {
    if (streamStopped) return
    streamStopped = true
    stopMediaStream(stream)
  }
  const abortCapture = () => {
    stopStream()
    try { if (context && context.state !== 'closed') void context.close().catch(() => undefined) } catch { /* Physical tracks are stopped. */ }
  }
  options.signal?.addEventListener('abort', abortCapture, { once: true })
  try {
    // getUserMedia cannot itself be aborted. Dispose its late permission result
    // before waiting for constraints, AudioContext.resume or worklet setup.
    if (options.signal?.aborted) abortCapture()
    assertActive()
    const inputTrack = stream.getAudioTracks?.()[0] || stream.getTracks()[0]
    let applyConstraintsError = ''
    if (inputTrack?.applyConstraints && !systemProcessing) {
      try {
        const processingConstraints: VoiceIsolationConstraints = {
          echoCancellation: { exact: false },
          ...browserProcessing,
        }
        await inputTrack.applyConstraints(processingConstraints)
      } catch (caught) {
        applyConstraintsError = caught instanceof Error ? caught.message : '浏览器拒绝应用输入音频处理设置。'
      }
    }
    assertActive()
    const settings = inputTrack?.getSettings?.() as VoiceIsolationSettings | undefined
    if (captureDeviceId && captureDeviceId !== 'default' && settings?.deviceId && settings.deviceId !== captureDeviceId) {
      throw new Error('实际麦克风与所选设备不一致，请重新选择输入设备。')
    }
    const setting = (value: unknown) => typeof value === 'boolean' ? value : null
    const actualEchoCancellation = setting(settings?.echoCancellation)
    if (actualEchoCancellation === true && !systemProcessing) {
      throw new Error('浏览器仍在启用 AEC，已拒绝开始录音；请关闭浏览器音频处理后重试。')
    }
    context = new AudioContext()
    await withTimeout(
      context.resume(),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器无法在 5 秒内启动麦克风音频上下文。',
    )
    assertActive()
    const source = context.createMediaStreamSource(stream)
    let capturePipeline: AudioProcessingDiagnostics['capturePipeline']
    let stopCapture: () => Promise<void>
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      await withTimeout(
        context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-capture-worklet.js`),
        CONTEXT_OPERATION_TIMEOUT_MS,
        '浏览器无法加载连续录音处理器。',
      )
      assertActive()
      const processor = new AudioWorkletNode(context, 'pcm-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      })
      let resolveFlush: (() => void) | null = null
      processor.port.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          onPCM(event.data)
          return
        }
        if (event.data?.type === 'flushed') resolveFlush?.()
      }
      source.connect(processor)
      capturePipeline = 'audio-worklet'
      stopCapture = async () => {
        const flushed = new Promise<void>((resolve) => {
          resolveFlush = resolve
          processor.port.postMessage({ type: 'flush' })
        })
        try {
          await withTimeout(flushed, 1_000, '连续录音处理器未能及时排空。')
        } finally {
          processor.port.onmessage = null
          processor.port.close()
          try {
            processor.disconnect()
          } catch {
            // Continue releasing the microphone if the node was already disconnected.
          }
        }
      }
    } else {
      const processor = context.createScriptProcessor(4096, 1, 1)
      const silent = context.createGain()
      silent.gain.value = 0
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const resampled = resample(input, context!.sampleRate, 16000)
        onPCM(floatToPCM16(resampled).buffer)
      }
      source.connect(processor)
      processor.connect(silent)
      silent.connect(context.destination)
      capturePipeline = 'script-processor'
      stopCapture = async () => {
        processor.onaudioprocess = null
        try {
          processor.disconnect()
        } catch {
          // Continue releasing the microphone if the node was already disconnected.
        }
        try {
          silent.disconnect()
        } catch {
          // Continue releasing the microphone if the node was already disconnected.
        }
      }
    }
    const diagnostics: AudioProcessingDiagnostics = {
      inputDeviceId: settings?.deviceId,
      inputDeviceLabel: inputTrack?.label,
      inputDeviceGroupId: settings?.groupId,
      defaultInputDeviceKey: inputDeviceId === 'default' ? defaultAudioInputKey(defaultInput) : undefined,
      echoCancellation: actualEchoCancellation,
      noiseSuppression: setting(settings?.noiseSuppression),
      autoGainControl: setting(settings?.autoGainControl),
      voiceIsolation: setting(settings?.voiceIsolation),
      capturePipeline,
      capturePurpose: 'websocket-input',
      applyConstraintsError: applyConstraintsError || undefined,
      inputProcessing: systemProcessing ? 'system' : 'raw',
      inputSampleRate: typeof settings?.sampleRate === 'number' ? settings.sampleRate : undefined,
      inputChannelCount: typeof settings?.channelCount === 'number' ? settings.channelCount : undefined,
    }

    let stopPromise: Promise<void> | null = null
    return {
      diagnostics,
      inputTrack,
      stop: () => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
          try { await stopCapture() } finally {
            try { source.disconnect() } catch { /* A node may already be disconnected. */ }
            stopStream()
            options.signal?.removeEventListener('abort', abortCapture)
            if (context!.state !== 'closed') {
              await withTimeout(
                context!.close(),
                CONTEXT_OPERATION_TIMEOUT_MS,
                '浏览器未能及时关闭麦克风音频上下文。',
              )
            }
          }
        })()
        return stopPromise
      },
    }
  } catch (caught) {
    stopStream()
    options.signal?.removeEventListener('abort', abortCapture)
    if (context) await closeAudioContextBestEffort(context)
    throw caught
  }
}

/**
 * Safari 16.4+：提前声明「录音 + 播放」，让系统在拿麦克风前就切到 play-and-record
 * 音频会话（其它浏览器没有这个 API，忽略）。
 */
function requestPlayAndRecordAudioSession() {
  const session = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession
  if (!session) return
  try {
    session.type = 'play-and-record'
  } catch {
    // 只读或不支持的取值：不影响后续 getUserMedia。
  }
}

export async function createStereoRecorder(
  onLeftPCM: (buffer: ArrayBuffer) => void,
  onRightPCM: (buffer: ArrayBuffer) => void,
  inputDeviceId: string,
): Promise<RecorderHandle> {
  if (!navigator.mediaDevices.getSupportedConstraints().channelCount) {
    throw new Error('当前浏览器不支持请求双声道麦克风，请改用最新版 Chrome。')
  }
  let stream: MediaStream
  try {
    const audioConstraints: VoiceIsolationConstraints = {
      deviceId: { exact: inputDeviceId },
      channelCount: { exact: 2 },
      echoCancellation: { exact: false },
      noiseSuppression: false,
      autoGainControl: false,
      voiceIsolation: false,
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'OverconstrainedError') {
      throw new Error('所选设备没有向浏览器提供双声道音频，请确认 DJI Mic 3 已设置为 S（Stereo）模式。')
    }
    if (caught instanceof DOMException && caught.name === 'NotFoundError') {
      throw new Error('找不到所选双声道接收器，请重新连接后再试。')
    }
    if (caught instanceof DOMException && (caught.name === 'NotAllowedError' || caught.name === 'SecurityError')) {
      throw new Error('麦克风权限未开启，请在浏览器地址栏允许后重试。')
    }
    throw caught
  }
  let context: AudioContext | null = null
  try {
    const inputTrack = stream.getAudioTracks()[0]
    const settings = inputTrack?.getSettings() as VoiceIsolationSettings | undefined
    if (typeof settings?.channelCount === 'number' && settings.channelCount < 2) {
      throw new Error('DJI Mic 3 当前被系统下混为单声道，请检查接收器 S 模式和系统音频设置。')
    }
    if (!globalThis.AudioWorkletNode) {
      throw new Error('当前浏览器不支持双声道连续采集，请改用最新版 Chrome。')
    }
    context = new AudioContext()
    await withTimeout(
      context.resume(),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器无法在 5 秒内启动双声道音频上下文。',
    )
    await withTimeout(
      context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-stereo-capture-worklet.js`),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器无法加载双声道录音处理器。',
    )
    const source = context.createMediaStreamSource(stream)
    const processor = new AudioWorkletNode(context, 'pcm-stereo-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
    })
    let resolveChannels: ((count: number) => void) | null = null
    let resolveFlush: (() => void) | null = null
    const channelCount = new Promise<number>((resolve) => { resolveChannels = resolve })
    processor.port.onmessage = (event) => {
      if (event.data?.type === 'channel-count') {
        resolveChannels?.(Number(event.data.channelCount) || 0)
        resolveChannels = null
        return
      }
      if (event.data?.type === 'stereo-pcm' && event.data.left instanceof ArrayBuffer && event.data.right instanceof ArrayBuffer) {
        onLeftPCM(event.data.left)
        onRightPCM(event.data.right)
        return
      }
      if (event.data?.type === 'flushed') resolveFlush?.()
    }
    source.connect(processor)
    const actualChannels = await withTimeout(
      channelCount,
      1_000,
      '未能确认双声道输入。',
    )
    if (actualChannels < 2) {
      throw new Error('浏览器只收到了单声道音频，请确认 DJI Mic 3 已设置为 S（Stereo）模式。')
    }
    const setting = (value: unknown) => typeof value === 'boolean' ? value : null
    const diagnostics: AudioProcessingDiagnostics = {
      echoCancellation: setting(settings?.echoCancellation),
      noiseSuppression: setting(settings?.noiseSuppression),
      autoGainControl: setting(settings?.autoGainControl),
      voiceIsolation: setting(settings?.voiceIsolation),
      capturePipeline: 'audio-worklet',
      capturePurpose: 'websocket-input',
    }
    let stopPromise: Promise<void> | null = null
    return {
      diagnostics,
      stop: () => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
          const flushed = new Promise<void>((resolve) => {
            resolveFlush = resolve
            processor.port.postMessage({ type: 'flush' })
          })
          try {
            await withTimeout(flushed, 1_000, '双声道录音处理器未能及时排空。')
          } finally {
            processor.port.onmessage = null
            processor.port.close()
            try { processor.disconnect() } catch { /* Node may already be disconnected. */ }
            try { source.disconnect() } catch { /* Source may already be disconnected. */ }
            stopMediaStream(stream)
            if (context!.state !== 'closed') {
              await withTimeout(context!.close(), CONTEXT_OPERATION_TIMEOUT_MS, '浏览器未能及时关闭双声道音频上下文。')
            }
          }
        })()
        return stopPromise
      },
    }
  } catch (caught) {
    stopMediaStream(stream)
    if (context) await closeAudioContextBestEffort(context)
    throw caught
  }
}

export async function createPCMTrackReader(
  track: MediaStreamTrack,
  sampleRate: number,
  onPCM: (pcm: Uint8Array) => void,
): Promise<PCMTrackReaderHandle> {
  const context = new AudioContext()
  try {
    await withTimeout(
      context.resume(),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器无法在 5 秒内启动 WebRTC 音频处理。',
    )
    const stream = new MediaStream([track])
    const source = context.createMediaStreamSource(stream)
    let capturePipeline: AudioProcessingDiagnostics['capturePipeline'] = 'script-processor'
    let stopCapture: () => Promise<void>
    let workletProcessor: AudioWorkletNode | null = null
    if (
      context.audioWorklet &&
      typeof AudioWorkletNode !== 'undefined' &&
      context.sampleRate >= sampleRate
    ) {
      try {
        await withTimeout(
          context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-capture-worklet.js`),
          CONTEXT_OPERATION_TIMEOUT_MS,
          '浏览器无法加载 WebRTC 本地归档处理器。',
        )
        const processor = new AudioWorkletNode(context, 'pcm-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          processorOptions: { targetSampleRate: sampleRate },
        })
        workletProcessor = processor
        let resolveFlush: (() => void) | null = null
        processor.port.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            onPCM(new Uint8Array(event.data))
            return
          }
          if (event.data?.type === 'flushed') resolveFlush?.()
        }
        source.connect(processor)
        capturePipeline = 'audio-worklet'
        stopCapture = async () => {
          const flushed = new Promise<void>((resolve) => {
            resolveFlush = resolve
            processor.port.postMessage({ type: 'flush' })
          })
          try {
            await withTimeout(flushed, 1_000, 'WebRTC 本地归档处理器未能及时排空。')
          } finally {
            processor.port.onmessage = null
            processor.port.close()
            try {
              processor.disconnect()
            } catch {
              // Continue closing the audio context if the node is already disconnected.
            }
          }
        }
      } catch {
        if (workletProcessor) {
          try {
            source.disconnect(workletProcessor)
          } catch {
            // The source may not have completed its connection.
          }
          workletProcessor.port.onmessage = null
          workletProcessor.port.close()
          try {
            workletProcessor.disconnect()
          } catch {
            // Continue with the compatible ScriptProcessor path.
          }
          workletProcessor = null
        }
      }
    }
    if (capturePipeline === 'script-processor') {
      const processor = context.createScriptProcessor(1024, 1, 1)
      const silent = context.createGain()
      silent.gain.value = 0
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const converted = floatToPCM16(resample(input, context.sampleRate, sampleRate))
        onPCM(new Uint8Array(converted.buffer, converted.byteOffset, converted.byteLength))
      }
      source.connect(processor)
      processor.connect(silent)
      silent.connect(context.destination)
      stopCapture = async () => {
        processor.onaudioprocess = null
        try {
          processor.disconnect()
        } catch {
          // Continue closing the remaining nodes.
        }
        try {
          silent.disconnect()
        } catch {
          // Continue closing the audio context.
        }
      }
    }
    let stopPromise: Promise<void> | null = null
    return {
      capturePipeline,
      stop: () => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
          let stopError: unknown = null
          try {
            await stopCapture()
          } catch (caught) {
            stopError = caught
          }
          try {
            source.disconnect()
          } catch {
            // The source can already be disconnected when its WebRTC track ended.
          }
          if (context.state !== 'closed') {
            try {
              await withTimeout(
                context.close(),
                CONTEXT_OPERATION_TIMEOUT_MS,
                '浏览器未能及时关闭 WebRTC 音频处理。',
              )
            } catch (caught) {
              if (!stopError) stopError = caught
            }
          }
          if (stopError) throw stopError
        })()
        return stopPromise
      },
    }
  } catch (caught) {
    await closeAudioContextBestEffort(context)
    throw caught
  }
}

export function resample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const output = new Float32Array(Math.round(input.length / ratio))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const before = Math.floor(position)
    const after = Math.min(before + 1, input.length - 1)
    const fraction = position - before
    output[index] = input[before] * (1 - fraction) + input[after] * fraction
  }
  return output
}

export function floatToPCM16(input: Float32Array) {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output
}

export function pcm16BytesToFloat32(input: Uint8Array) {
  const sampleCount = Math.floor(input.byteLength / 2)
  const output = new Float32Array(sampleCount)
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true)
    output[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
  }
  return output
}

export function pcmChunksToWav(chunks: Uint8Array[], sampleRate: number) {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  writeASCII(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeASCII(view, 8, 'WAVE')
  writeASCII(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeASCII(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  const output = new Uint8Array(buffer, 44)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  return new Blob([buffer], { type: 'audio/wav' })
}

function writeASCII(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: number | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
}

function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => {
    try {
      track.stop()
    } catch {
      // Continue stopping the remaining tracks.
    }
  })
}

async function closeAudioContextBestEffort(context: AudioContext) {
  if (context.state === 'closed') return
  try {
    await withTimeout(
      context.close(),
      CONTEXT_OPERATION_TIMEOUT_MS,
      '浏览器音频上下文未能及时关闭。',
    )
  } catch {
    // Preserve the original startup error after attempting to release resources.
  }
}
