import type { AudioFrameData, AutoPlayFailedEvent, IRTCEngine } from '@volcengine/rtc'
import {
  createPCMStreamTrackPlayer,
  echoCancellationSetting,
  type BrowserAudioProcessingOptions,
  floatToPCM16,
  pcm16HasSignal,
  resample,
  type PCMPlaybackCallbacks,
  type PCMStreamPlayer,
  type RecorderHandle,
} from '../audio'
import { apiFetch } from './apiFetch'

const VOLC_RTC_PLAYOUT_GRACE_MS = 500
const VOLC_RTC_OPERATION_TIMEOUT_MS = 10_000
let volcRTCModulePromise: Promise<typeof import('@volcengine/rtc')> | null = null
let volcRTCSupportPromise: Promise<boolean> | null = null

type VolcRTCParticipant = {
  identity: string
  token: string
}

type VolcRTCSession = {
  appId: string
  roomId: string
  expiresAt: string
  user: VolcRTCParticipant
  bridge: VolcRTCParticipant
}

type VolcRTCPlaybackChunk = {
  callbacks?: PCMPlaybackCallbacks
  eligibleAt: number
  hasSignal: boolean
  remainingMs: number
  started: boolean
}

export type VolcRTCBridge = {
  player: PCMStreamPlayer
  createRecorder: (onPCM: (buffer: ArrayBuffer) => void, inputDeviceId?: string) => Promise<RecorderHandle>
  resumeAudioPlayback: () => Promise<void>
}

export type VolcRTCMultilingualRuntime = {
  players: Map<string, PCMStreamPlayer>
  createRecorder: (onPCM: (buffer: ArrayBuffer) => void, inputDeviceId?: string) => Promise<RecorderHandle>
}

export async function createVolcRTCBridge(options: {
  provider: string
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation?: boolean
  browserAudioProcessing?: BrowserAudioProcessingOptions
  /** Optional caller lease; checked before/after asynchronous RTC capture work. */
  isCaptureAuthorized?: () => boolean
  publishOutputImmediately?: boolean
  onAudioPlaybackBlocked?: () => void
}): Promise<VolcRTCBridge> {
  const echoCancellation = options.echoCancellation ?? true
  const authorized = () => { try { return options.isCaptureAuthorized?.() !== false } catch { return false } }
  const assertAuthorized = () => { if (!authorized()) throw new Error('AI 数据授权已变化，已停止火山 RTC 收音。') }
  assertAuthorized()
  const response = await withVolcRTCTimeout(apiFetch('/api/volc-rtc/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: options.provider }),
  }), '创建会话')
  assertAuthorized()
  const payload = await readJSON(response)
  assertAuthorized()
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : '无法创建火山 RTC 会话。')
  }
  const session = parseSession(payload)
  volcRTCModulePromise ||= import('@volcengine/rtc')
  const rtc = await volcRTCModulePromise
  assertAuthorized()
  volcRTCSupportPromise ||= Promise.resolve(rtc.default.isSupported())
  if (!await withVolcRTCTimeout(volcRTCSupportPromise, '检查浏览器兼容性')) {
    throw new Error('当前浏览器不支持火山 RTC，请使用最新版 Chrome。')
  }
  assertAuthorized()

  const trackPlayer = await withVolcRTCTimeout(createPCMStreamTrackPlayer(), '创建音频通道')
  let bridgeEngine: IRTCEngine | null = null
  let userEngine: IRTCEngine | null = null
  let bridgeJoined = false
  let userJoined = false
  let bridgePublished = false
  let userPublished = false
  let captureStarted = false
  let receivePCM: ((buffer: ArrayBuffer) => void) | null = null
  let closePromise: Promise<void> | null = null
  let blockedPlayback: AutoPlayFailedEvent | null = null
  let playbackMuted = false
  let playbackVolume = 1
  const applyPlaybackVolume = () => {
    if (closePromise || !userEngine) return
    // Change only the receiver's output, never the bridge's published PCM or
    // microphone capture. A volume change must not undo a language mute.
    userEngine.setPlaybackVolume(session.bridge.identity, rtc.StreamIndex.STREAM_INDEX_MAIN,
      playbackMuted ? 0 : Math.round(playbackVolume * 100))
  }
  const playbackChunks: VolcRTCPlaybackChunk[] = []
  const clearPlaybackChunks = () => {
    const pending = playbackChunks.splice(0)
    pending.forEach((chunk) => chunk.callbacks?.onEnded?.())
  }
  const observeBridgePlayback = (frame: AudioFrameData) => {
    if (closePromise || frame.channels.length === 0 || frame.sampleRate <= 0) return
    const sampleCount = Math.min(...frame.channels.map((channel) => channel.length))
    if (sampleCount <= 0) return
    const observedAt = performance.now()
    const hasSignal = audioFrameHasSignal(frame, sampleCount)
    let observedMs = sampleCount / frame.sampleRate * 1000
    while (observedMs > 0 && playbackChunks.length > 0) {
      const chunk = playbackChunks[0]
      if (observedAt < chunk.eligibleAt) return
      if (!chunk.started) {
        if (chunk.hasSignal && !hasSignal) return
        chunk.started = true
        chunk.callbacks?.onStart?.(observedAt)
      }
      const consumedMs = Math.min(observedMs, chunk.remainingMs)
      observedMs -= consumedMs
      chunk.remainingMs -= consumedMs
      if (chunk.remainingMs > 0) return
      playbackChunks.shift()
      chunk.callbacks?.onEnded?.()
    }
  }
  const handleAutoplayFailed = (event: AutoPlayFailedEvent) => {
    if (event.kind === 'audio' && event.userId === session.bridge.identity) {
      blockedPlayback = event
      options.onAudioPlaybackBlocked?.()
    }
  }

  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      playbackMuted = true
      if (bridgeEngine) {
        bridgeEngine.setAudioFrameCallback(
          rtc.StreamIndex.STREAM_INDEX_MAIN,
          session.user.identity,
          undefined,
        )
      }
      if (userEngine) {
        userEngine.setAudioFrameCallback(
          rtc.StreamIndex.STREAM_INDEX_MAIN,
          session.bridge.identity,
          undefined,
        )
      }
      clearPlaybackChunks()
      receivePCM = null
      blockedPlayback = null
      userEngine?.off(rtc.default.events.onAutoplayFailed, handleAutoplayFailed)
      if (captureStarted && userEngine) {
        captureStarted = false
        // Local capture must stop before waiting for a remote unpublish ACK;
        // pagehide/lock can freeze the page during that network round trip.
        await bestEffort(() => userEngine!.stopAudioCapture())
      }
      if (userPublished && userEngine) {
        userPublished = false
        await bestEffort(() => userEngine!.unpublishStream(rtc.MediaType.AUDIO))
      }
      if (bridgePublished && bridgeEngine) {
        await bestEffort(() => bridgeEngine!.unpublishStream(rtc.MediaType.AUDIO))
        bridgePublished = false
      }
      if (userJoined && userEngine) {
        await bestEffort(() => userEngine!.leaveRoom())
        userJoined = false
      }
      if (bridgeJoined && bridgeEngine) {
        await bestEffort(() => bridgeEngine!.leaveRoom())
        bridgeJoined = false
      }
      await bestEffort(() => trackPlayer.close())
      if (userEngine) {
        bestEffortSync(() => rtc.default.destroyEngine(userEngine!))
        userEngine = null
      }
      if (bridgeEngine) {
        bestEffortSync(() => rtc.default.destroyEngine(bridgeEngine!))
        bridgeEngine = null
      }
    })()
    return closePromise
  }

  try {
    assertAuthorized()
    bridgeEngine = rtc.default.createEngine(session.appId, {
      autoPlayPolicy: rtc.RTCAutoPlayPolicy.VIDEO_ONLY,
    })
    userEngine = rtc.default.createEngine(session.appId)
    userEngine.on(rtc.default.events.onAutoplayFailed, handleAutoplayFailed)
    await bridgeEngine.setAudioSourceType(
      rtc.StreamIndex.STREAM_INDEX_MAIN,
      rtc.AudioSourceType.AUDIO_SOURCE_TYPE_EXTERNAL,
    )
    assertAuthorized()
    await bridgeEngine.setExternalAudioTrack(
      rtc.StreamIndex.STREAM_INDEX_MAIN,
      trackPlayer.mediaStreamTrack,
    )
    assertAuthorized()
    bridgeEngine.setAudioFrameCallback(
      rtc.StreamIndex.STREAM_INDEX_MAIN,
      session.user.identity,
      (frame) => { if (authorized()) receiveRemotePCM(frame, receivePCM) },
      1024,
    )
    userEngine.setAudioFrameCallback(
      rtc.StreamIndex.STREAM_INDEX_MAIN,
      session.bridge.identity,
      observeBridgePlayback,
      1024,
    )
    const joinResults = await Promise.allSettled([
      withVolcRTCTimeout(bridgeEngine.joinRoom(session.bridge.token, session.roomId, {
        userId: session.bridge.identity,
      }, {
        isAutoPublish: false,
        isAutoSubscribeAudio: true,
        isAutoSubscribeVideo: false,
      }), '桥接端入会').then(() => { bridgeJoined = true }),
      withVolcRTCTimeout(userEngine.joinRoom(session.user.token, session.roomId, {
        userId: session.user.identity,
      }, {
        isAutoPublish: false,
        isAutoSubscribeAudio: true,
        isAutoSubscribeVideo: false,
      }), '用户端入会').then(() => { userJoined = true }),
    ])
    const failedJoin = joinResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failedJoin) throw failedJoin.reason
    assertAuthorized()
    if (options.outputDeviceId !== 'default') {
      await userEngine.setAudioPlaybackDevice(options.outputDeviceId)
      assertAuthorized()
    }
    if (options.publishOutputImmediately) {
      await withVolcRTCTimeout(bridgeEngine.publishStream(rtc.MediaType.AUDIO), '发布翻译音频')
      bridgePublished = true
      assertAuthorized()
    }
  } catch (caught) {
    await close()
    throw caught
  }

  const player: PCMStreamPlayer = {
    push: (pcm, sampleRate, callbacks) => {
      const scheduledAt = trackPlayer.push(pcm, sampleRate)
      const durationMs = Math.floor(pcm.byteLength / 2) / sampleRate * 1000
      if (!playbackMuted && typeof scheduledAt === 'number' && Number.isFinite(scheduledAt) && Number.isFinite(durationMs) && durationMs > 0) {
        playbackChunks.push({ callbacks, eligibleAt: scheduledAt, hasSignal: pcm16HasSignal(pcm), remainingMs: durationMs, started: false })
      } else if (playbackMuted) {
        callbacks?.onEnded?.()
      }
      // The local AudioContext only schedules the RTC publishing track. Keep
      // returning null; callbacks are emitted after the user engine observes
      // the corresponding remote PCM instead of at local publication time.
      return null
    },
    setMuted: (muted) => {
      playbackMuted = muted
      trackPlayer.setMuted(muted)
      applyPlaybackVolume()
      if (muted) clearPlaybackChunks()
    },
    setVolume: (volume) => {
      if (!Number.isFinite(volume)) return
      playbackVolume = Math.max(0, Math.min(1, volume))
      applyPlaybackVolume()
    },
    setOutputDevice: async (deviceId) => {
      if (!userEngine) throw new Error('火山 RTC 会话已经关闭。')
      await userEngine.setAudioPlaybackDevice(deviceId)
    },
    drain: async () => {
      await trackPlayer.drain()
      // Give the final published frames a bounded window to cross the RTC
      // jitter buffer before unpublishing and leaving the room.
      await new Promise((resolve) => setTimeout(resolve, VOLC_RTC_PLAYOUT_GRACE_MS))
    },
    close,
  }

  return {
    player,
    resumeAudioPlayback: async () => {
      if (!userEngine || closePromise) throw new Error('火山 RTC 会话已经关闭。')
      const event = blockedPlayback
      await userEngine.play(
        event?.userId || session.bridge.identity,
        event?.mediaType || rtc.MediaType.AUDIO,
        event?.streamIndex ?? rtc.StreamIndex.STREAM_INDEX_MAIN,
        event?.playerId,
      )
      applyPlaybackVolume()
      blockedPlayback = null
    },
    createRecorder: async (onPCM, inputDeviceId = options.inputDeviceId) => {
      if (!userEngine || !bridgeEngine || closePromise) {
        throw new Error('火山 RTC 会话已经关闭。')
      }
      assertAuthorized()
      receivePCM = onPCM
      try {
        await userEngine.setAudioCaptureConfig({
          channelCount: 1,
          echoCancellation: { exact: echoCancellation },
          noiseSuppression: false,
          autoGainControl: false,
          ...options.browserAudioProcessing,
        })
        assertAuthorized()
        if (closePromise) throw new Error('火山 RTC 会话已经关闭。')
        const settings = await withVolcRTCTimeout(userEngine.startAudioCapture(
          inputDeviceId === 'default' ? undefined : inputDeviceId,
        ), '启动麦克风')
        captureStarted = true
        assertAuthorized()
        if (closePromise) throw new Error('火山 RTC 会话已经关闭。')
        const actualEchoCancellation = echoCancellationSetting(settings.echoCancellation)
        if (echoCancellation && actualEchoCancellation !== true && typeof actualEchoCancellation !== 'string') {
          await bestEffort(() => userEngine!.stopAudioCapture())
          captureStarted = false
          throw new Error('未确认浏览器 AEC 已开启，已拒绝开始火山 RTC 录音。')
        }
        if (!echoCancellation && actualEchoCancellation !== false) {
          await bestEffort(() => userEngine!.stopAudioCapture())
          captureStarted = false
          throw new Error('未确认浏览器 AEC 已关闭，已拒绝开始火山 RTC 录音。')
        }
        await withVolcRTCTimeout(userEngine.publishStream(rtc.MediaType.AUDIO), '发布麦克风音频')
        userPublished = true
        assertAuthorized()
        if (closePromise) throw new Error('火山 RTC 会话已经关闭。')
        if (!bridgePublished) {
          await withVolcRTCTimeout(bridgeEngine.publishStream(rtc.MediaType.AUDIO), '发布翻译音频')
          bridgePublished = true
          assertAuthorized()
        }

        let stopPromise: Promise<void> | null = null
        return {
          diagnostics: {
            echoCancellation: actualEchoCancellation,
            noiseSuppression: booleanSetting(settings.noiseSuppression),
            autoGainControl: booleanSetting(settings.autoGainControl),
            voiceIsolation: booleanSetting((settings as MediaTrackSettings & { voiceIsolation?: boolean }).voiceIsolation),
            capturePipeline: 'rtc-sdk',
            capturePurpose: 'websocket-input',
          },
          stop: () => {
            if (stopPromise) return stopPromise
            stopPromise = (async () => {
              bridgeEngine?.setAudioFrameCallback(
                rtc.StreamIndex.STREAM_INDEX_MAIN,
                session.user.identity,
                undefined,
              )
              receivePCM = null
              if (captureStarted && userEngine) {
                captureStarted = false
                await bestEffort(() => userEngine!.stopAudioCapture())
              }
              if (userPublished && userEngine) {
                userPublished = false
                await bestEffort(() => userEngine!.unpublishStream(rtc.MediaType.AUDIO))
              }
            })()
            return stopPromise
          },
        }
      } catch (caught) {
        if (options.isCaptureAuthorized && !authorized()) {
          receivePCM = null
          await close()
        }
        throw caught
      }
    },
  }
}

export async function createVolcRTCMultilingualRuntime(options: {
  provider: string
  targetLanguages: string[]
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation?: boolean
  browserAudioProcessing?: BrowserAudioProcessingOptions
  isCaptureAuthorized?: () => boolean
  onAudioPlaybackBlocked?: () => void
}): Promise<VolcRTCMultilingualRuntime> {
  if (options.targetLanguages.length === 0) throw new Error('请至少选择一种目标语言。')
  const bridges: Array<readonly [string, VolcRTCBridge]> = []
  try {
    const results = await Promise.allSettled(options.targetLanguages.map(async (targetLanguage) => [
      targetLanguage,
      await createVolcRTCBridge({
        provider: options.provider,
        inputDeviceId: options.inputDeviceId,
        outputDeviceId: options.outputDeviceId,
        echoCancellation: options.echoCancellation,
        browserAudioProcessing: options.browserAudioProcessing,
        isCaptureAuthorized: options.isCaptureAuthorized,
        publishOutputImmediately: true,
        onAudioPlaybackBlocked: options.onAudioPlaybackBlocked,
      }),
    ] as const))
    results.forEach((result) => {
      if (result.status === 'fulfilled') bridges.push(result.value)
    })
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  } catch (caught) {
    await Promise.all(bridges.map(([, bridge]) => bridge.player.close().catch(() => undefined)))
    throw caught
  }
  const captureBridge = bridges[0][1]
  return {
    players: new Map(bridges.map(([targetLanguage, bridge]) => [targetLanguage, bridge.player])),
    createRecorder: (onPCM, inputDeviceId) => captureBridge.createRecorder(onPCM, inputDeviceId),
  }
}

function audioFrameHasSignal(frame: AudioFrameData, sampleCount: number) {
  const minimumAmplitude = 8 / 32768
  return frame.channels.some((channel) => {
    for (let index = 0; index < sampleCount; index += 1) {
      if (Math.abs(channel[index]) >= minimumAmplitude) return true
    }
    return false
  })
}

function receiveRemotePCM(
  frame: AudioFrameData,
  receivePCM: ((buffer: ArrayBuffer) => void) | null,
) {
  if (!receivePCM || frame.channels.length === 0 || frame.sampleRate <= 0) return
  let mono = frame.channels[0]
  if (frame.channels.length > 1) {
    const sampleCount = Math.min(...frame.channels.map((channel) => channel.length))
    mono = new Float32Array(sampleCount)
    for (let channelIndex = 0; channelIndex < frame.channels.length; channelIndex += 1) {
      const channel = frame.channels[channelIndex]
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        mono[sampleIndex] += channel[sampleIndex] / frame.channels.length
      }
    }
  }
  const pcm = floatToPCM16(resample(mono, frame.sampleRate, 16_000))
  receivePCM(pcm.buffer as ArrayBuffer)
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseSession(payload: Record<string, unknown>): VolcRTCSession {
  const user = payload.user as Partial<VolcRTCParticipant> | undefined
  const bridge = payload.bridge as Partial<VolcRTCParticipant> | undefined
  if (
    typeof payload.appId !== 'string' || !payload.appId
    || typeof payload.roomId !== 'string' || !payload.roomId
    || typeof payload.expiresAt !== 'string' || !payload.expiresAt
    || typeof user?.identity !== 'string' || !user.identity
    || typeof user.token !== 'string' || !user.token
    || typeof bridge?.identity !== 'string' || !bridge.identity
    || typeof bridge.token !== 'string' || !bridge.token
  ) {
    throw new Error('火山 RTC 会话响应无效。')
  }
  return {
    appId: payload.appId,
    roomId: payload.roomId,
    expiresAt: payload.expiresAt,
    user: { identity: user.identity, token: user.token },
    bridge: { identity: bridge.identity, token: bridge.token },
  }
}

function booleanSetting(value: unknown) {
  return typeof value === 'boolean' ? value : null
}

async function withVolcRTCTimeout<T>(operation: Promise<T>, phase: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`火山 RTC ${phase}超过 10 秒，请检查网络或部署安全策略。`)), VOLC_RTC_OPERATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function bestEffort(action: () => Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      action(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000)
      }),
    ])
  } catch {
    // Continue releasing the other RTC resources.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function bestEffortSync(action: () => void) {
  try {
    action()
  } catch {
    // Continue releasing the other RTC resources.
  }
}
