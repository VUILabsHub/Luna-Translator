// WebRTC bridge event semantics shared by every client. Moved verbatim from
// frontend/src/hooks/useLiveKitRealtimeSession.ts under contract v1
// (docs/protocol/realtime-text-sync-v1.md §1.1, R10-R13).
import { joinTranscriptFragment, splitCompletedSentences, translationUnitSeparator } from './textJoin'
import type { TranslationDisplayUnit } from './types'

export type BridgeEvent = {
  inputOrigin?: 'system' | 'microphone'
  type: string
  state?: string
  sessionId?: string
  providerId?: string
  index?: number
  text?: string
  epochText?: string
  modelOutputStable?: boolean
  modelOutputAuthoritative?: boolean
  message?: string
  error?: string
  /**
   * 生命周期原因（只加不改）：`session_ending` / `session_closed` 事件携带的
   * 后端 completionReason（见 @simultrans/core/sessionCompletion）。
   */
  reason?: string
  /** 非致命告警通道（如 `asr_error`）：不终止会话，只在 UI 上提示一次。 */
  warning?: string
  /** 服务端错误帧自带的机器可读 code（protocol-x2）。 */
  code?: string
  /** WS 关闭帧的数值 code（1000 正常 / 1006 等异常）。 */
  closeCode?: number
  segmentId?: string
  segmentText?: string
  replaceSegmentIds?: string[]
  utteranceId?: string
  speechEpoch?: number
  durationMs?: number
  sequence?: number
  queueWaitMs?: number
  startMs?: number
  endMs?: number
  start_ms?: number
  end_ms?: number
  ttsError?: string
  tts_error?: string
  latency?: Record<string, unknown>
  engineFirstModelTokenMs?: number
  engineFirstTextMs?: number
  engineFirstTTSReadyMs?: number
  engineAudioToModelFeedMs?: number
  engineModelFeedToFirstOutputMs?: number
  engineModelFeedToStableTextMs?: number
  engineModelFeedToTTSReadyMs?: number
  engineFirstModelSubmitUnixUs?: number
  engineFirstTTSReadyUnixUs?: number
  bridgeFirstInputToFirstOutputMs?: number
  providerLagMs?: number
  synthesisDurationMs?: number
  eventSchemaVersion?: number
  agentBuildSha?: string
  mediaClock?: string
  mediaSampleRateHz?: number
  mediaStartSample?: number
  mediaEndSample?: number
  firstFrameSequence?: number
  rangeState?: string
}

export type BridgeTranslationState = {
  text: string
  units: TranslationDisplayUnit[]
}

export type BridgePlaybackMarker = {
  providerSegmentId: string
  sequence: number
  durationMs: number
  mediaSampleRateHz?: number
  mediaStartSample?: number
  mediaEndSample?: number
  firstFrameSequence?: number
}

export type BridgeMediaRange = Required<Pick<
  BridgePlaybackMarker,
  'mediaSampleRateHz' | 'mediaStartSample' | 'mediaEndSample' | 'firstFrameSequence'
>>

export function bridgeMediaRange(event: BridgeEvent): BridgeMediaRange | null {
  if (event.mediaClock !== 'agent_pcm_samples' || event.rangeState !== 'planned') return null
  const mediaSampleRateHz = Number(event.mediaSampleRateHz)
  const mediaStartSample = Number(event.mediaStartSample)
  const mediaEndSample = Number(event.mediaEndSample)
  const firstFrameSequence = Number(event.firstFrameSequence)
  if (
    !Number.isInteger(mediaSampleRateHz) || mediaSampleRateHz <= 0 ||
    !Number.isInteger(mediaStartSample) || mediaStartSample < 0 ||
    !Number.isInteger(mediaEndSample) || mediaEndSample <= mediaStartSample ||
    !Number.isInteger(firstFrameSequence) || firstFrameSequence <= 0
  ) return null
  return { mediaSampleRateHz, mediaStartSample, mediaEndSample, firstFrameSequence }
}

export function bridgePlaybackMarker(event: BridgeEvent): BridgePlaybackMarker | null {
  if (event.type !== 'audio_playout_started') return null
  const providerSegmentId = event.segmentId?.trim() || ''
  const sequence = Number(event.sequence)
  const durationMs = Number(event.durationMs)
  if (
    !providerSegmentId || !Number.isInteger(sequence) || sequence <= 0 ||
    !Number.isFinite(durationMs) || durationMs <= 0
  ) return null
  const mediaRange = bridgeMediaRange(event)
  return {
    providerSegmentId,
    sequence,
    durationMs: Math.min(30_000, Math.max(80, durationMs)),
    ...(mediaRange || {}),
  }
}

export function bridgeScheduledPlaybackAtMs(
  firstNativePlaybackAtMs: number | null,
  mediaStartSample: number | undefined,
  mediaSampleRateHz: number | undefined,
) {
  if (
    firstNativePlaybackAtMs === null || !Number.isFinite(firstNativePlaybackAtMs) || firstNativePlaybackAtMs < 0 ||
    !Number.isInteger(mediaStartSample) || (mediaStartSample ?? -1) < 0 ||
    !Number.isInteger(mediaSampleRateHz) || (mediaSampleRateHz ?? 0) <= 0
  ) return null
  return firstNativePlaybackAtMs + (mediaStartSample! * 1000 / mediaSampleRateHz!)
}

export function nextBridgePlaybackMarker(event: BridgeEvent, lastSequence: number) {
  const marker = bridgePlaybackMarker(event)
  return marker && marker.sequence > lastSequence ? marker : null
}

export function canStartBridgePlaybackHighlight(
  generation: number,
  currentGeneration: number,
  activeSegmentId: string | null,
  nativePlaybackStarted: boolean,
  outputSignalSeen: boolean,
) {
  return generation === currentGeneration && activeSegmentId === null &&
    nativePlaybackStarted && outputSignalSeen
}

export type BridgeParticipant = {
  identity: string
  kind: number
}

export function shouldAcceptBridgeEvent(
  event: BridgeEvent,
  participant: BridgeParticipant | undefined,
  expectedSessionId: string,
  agentKind: number,
) {
  if (!expectedSessionId || event.sessionId !== expectedSessionId) return false
  if (!participant) return event.type === 'bridge_ready'
  return participant.kind === agentKind || participant.identity.startsWith('agent-')
}

export function reconcileBridgeTranslation(
  current: BridgeTranslationState,
  event: BridgeEvent,
): BridgeTranslationState {
  if (event.type === 'translation_update') {
    const text = (event.text || event.segmentText || '').trim()
    return text ? { text, units: current.units } : current
  }

  if (event.type === 'translation_delta') {
    const delta = event.text || event.segmentText || ''
    return delta ? { text: current.text + delta, units: current.units } : current
  }

  if (event.type === 'translation_done') {
    // On the VUILabs relay, translation_done confirms the latest token/word,
    // while event.text (or the preceding translation_update) is the
    // authoritative cumulative translation. Visible transcript rows must
    // therefore be derived from completed sentences, not provider word IDs.
    const confirmedText = (event.text || event.segmentText || '').trim()
    const currentText = current.text.trim()
    const accumulatedText = currentText.length >= confirmedText.length ? currentText : confirmedText
    if (!accumulatedText) return current
    return {
      text: accumulatedText,
      units: bridgeSentenceUnits(accumulatedText, false),
    }
  }

  if (event.type === 'translation') {
    const segmentText = (event.segmentText || event.text || '').trim()
    if (!segmentText) return current
    const segmentId = event.segmentId?.trim() || `webrtc-translation-${event.index ?? current.units.length}`
    const units = upsertBridgeTextUnit(current.units, segmentId, segmentText, event.index)
    return { text: joinBridgeTextUnits(units), units }
  }

  return current
}

export function finalizeBridgeTranslation(current: BridgeTranslationState): BridgeTranslationState {
  if (!current.text.trim()) return current
  return {
    text: current.text.trim(),
    units: bridgeSentenceUnits(current.text, true),
  }
}

export function bridgeSentenceUnits(text: string, includeRemainder: boolean): TranslationDisplayUnit[] {
  const { completed, remainder } = splitCompletedSentences(text.trim())
  const sentences = includeRemainder && remainder ? [...completed, remainder] : completed
  return sentences.map((sentence, index) => ({
    id: `webrtc-translation-sentence-${index}`,
    text: sentence,
  }))
}

// Fallback playout→sentence attribution for the WebRTC path. Display unit ids
// are sentence ordinals that never equal the playback marker's provider segment
// id, so map the k-th distinct playout segment (in sequence order) onto the
// k-th sentence unit and expose it via memberIds for highlight matching.
// Assumes TTS playout segments correspond 1:1, in order, to displayed
// sentences; when the relay chunks audio differently a sentence may stay lit
// past its own audio. Replace this heuristic once the bridge event carries an
// explicit sentence key (index/text/shared id).
export function attributePlayoutSegmentsToUnits(
  units: TranslationDisplayUnit[],
  playoutOrder: string[],
): TranslationDisplayUnit[] {
  let changed = false
  const next = units.map((unit, index) => {
    const segmentId = playoutOrder[index]
    if (!segmentId || (unit.memberIds?.length === 1 && unit.memberIds[0] === segmentId)) return unit
    changed = true
    return { ...unit, memberIds: [segmentId] }
  })
  return changed ? next : units
}

export function nextBridgeSourceSnapshot(current: string, event: BridgeEvent) {
  if (event.type === 'source_delta') {
    return current + (event.text || event.segmentText || '')
  }
  if (event.type === 'source_update' || event.type === 'source_done') {
    return (event.text || event.segmentText || '').trim()
  }
  if (event.type === 'source' || event.type === 'transcription') {
    return joinTranscriptFragment(current, (event.segmentText || event.text || '').trim())
  }
  return current
}

function upsertBridgeTextUnit(
  current: TranslationDisplayUnit[],
  id: string,
  text: string,
  ordinal?: number,
) {
  const providerIndex = typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0
    ? ordinal
    : undefined
  const existingIndex = current.findIndex((unit) => unit.id === id)
  const previous = existingIndex >= 0 ? current[existingIndex] : undefined
  const nextUnit = { id, text, providerIndex: providerIndex ?? previous?.providerIndex }
  if (previous?.text === text && previous.providerIndex === nextUnit.providerIndex) return current
  const next = existingIndex < 0
    ? [...current, nextUnit]
    : current.map((unit, index) => index === existingIndex ? nextUnit : unit)
  return next.sort((left, right) => {
    if (left.providerIndex === undefined && right.providerIndex === undefined) return 0
    if (left.providerIndex === undefined) return 1
    if (right.providerIndex === undefined) return -1
    return left.providerIndex - right.providerIndex
  })
}

function joinBridgeTextUnits(units: TranslationDisplayUnit[]) {
  return units.reduce(
    (value, unit) => value + translationUnitSeparator(value, unit.text) + unit.text,
    '',
  )
}
