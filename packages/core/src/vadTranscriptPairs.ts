import { translationUnitSeparator } from './textJoin'

export type VadTranscriptEvent = {
  type: string
  modelOutputAuthoritative?: boolean
  state?: string
  text?: string
  epochText?: string
  segmentId?: string
  segmentText?: string
  index?: number
  replaceSegmentIds?: string[]
  utteranceId?: string
  speechEpoch?: number
  startMs?: number
  endMs?: number
}

type VadTranslationUnit = {
  id: string
  providerSegmentId: string
  text: string
  providerIndex?: number
  startMs?: number
  endMs?: number
  firstSeenOrder: number
  eventSnapshot: string
}

export type VadTranscriptPair = {
  id: string
  speechEpoch: number
  source: string
  translation: string
  startMs: number
  sourceVadStartMs?: number
  provisionalStartMs?: number
  endMs?: number
  committed: boolean
  sourceFinal: boolean
  sourceStableText: string
  sourceSnapshot?: string
  translationPreviewSnapshot?: string
  translationSegmentIds: string[]
  translationRetiredSegmentIds: string[]
  translationSeenDoneKeys: string[]
  translationUnits: VadTranslationUnit[]
  translationEpochText: string
  translationEpochEndMs?: number
  translationEpochPriority: number
  translationStableEpochText: string
  translationModelAuthoritative?: boolean
  translationStableEpochEndMs?: number
}

export type VadTranscriptPairState = {
  pairs: VadTranscriptPair[]
}

export function sourceVadStartMsForEvent(
  pairs: VadTranscriptPair[],
  event: Pick<VadTranscriptEvent, 'utteranceId' | 'speechEpoch'>,
) {
  const utteranceId = event.utteranceId?.trim()
  const pair = (utteranceId ? pairs.find((candidate) => candidate.id === utteranceId) : undefined)
    ?? pairs.find((candidate) => event.speechEpoch && candidate.speechEpoch === event.speechEpoch)
  return pair?.sourceVadStartMs
}

export function emptyVadTranscriptPairState(): VadTranscriptPairState {
  return { pairs: [] }
}

function validStartMs(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function earliestStartMs(current: number | undefined, candidate: number) {
  return current === undefined ? candidate : Math.min(current, candidate)
}

function withSourceVadStart(pair: VadTranscriptPair, candidate: number | undefined) {
  if (!validStartMs(candidate)) return pair
  const sourceVadStartMs = earliestStartMs(pair.sourceVadStartMs, candidate)
  // Identity preservation: a repeated VAD frame carries no new information.
  // Returning the same object lets hosts skip a re-render (RN re-lays out the
  // whole transcript on every new state object).
  if (pair.sourceVadStartMs === sourceVadStartMs && pair.startMs === sourceVadStartMs) return pair
  return { ...pair, sourceVadStartMs, startMs: sourceVadStartMs }
}

function withProvisionalStart(pair: VadTranscriptPair, candidate: number | undefined) {
  if (!validStartMs(candidate)) return pair
  const provisionalStartMs = earliestStartMs(pair.provisionalStartMs, candidate)
  const startMs = pair.sourceVadStartMs ?? provisionalStartMs
  if (pair.provisionalStartMs === provisionalStartMs && pair.startMs === startMs) return pair
  return { ...pair, provisionalStartMs, startMs }
}

function isSourceVadStartEvent(event: VadTranscriptEvent) {
  return (event.type === 'source_vad_state' && event.state === 'speech_start')
    || event.type === 'source_vad_segment'
}

function providesProvisionalStart(event: VadTranscriptEvent) {
  return event.type === 'source_delta'
    || event.type === 'source_update'
    || event.type === 'source_done'
    || event.type === 'model_output'
    || event.type === 'translation'
    || event.type === 'translation_done'
}

function eventPairID(event: VadTranscriptEvent) {
  const utteranceID = event.utteranceId?.trim()
  if (utteranceID) return utteranceID
  return typeof event.speechEpoch === 'number' && event.speechEpoch > 0
    ? `vad-${event.speechEpoch}`
    : ''
}

function ensurePair(state: VadTranscriptPairState, event: VadTranscriptEvent) {
  const id = eventPairID(event)
  if (!id) return { state, index: -1 }
  const existing = state.pairs.findIndex((pair) => pair.id === id)
  if (existing >= 0) return { state, index: existing }
  const pair: VadTranscriptPair = {
    id,
    speechEpoch: event.speechEpoch || 0,
    source: '',
    translation: '',
    startMs: 0,
    committed: false,
    sourceFinal: false,
    sourceStableText: '',
    translationSegmentIds: [],
    translationRetiredSegmentIds: [],
    translationSeenDoneKeys: [],
    translationUnits: [],
    translationEpochText: '',
    translationEpochPriority: 0,
    translationStableEpochText: '',
  }
  return {
    state: { ...state, pairs: [...state.pairs, pair] },
    index: state.pairs.length,
  }
}

function joinTranslationUnits(units: VadTranslationUnit[]) {
  return units.reduce(
    (value, unit) => value + translationUnitSeparator(value, unit.text) + unit.text,
    '',
  )
}

function upsertTranslationUnit(
  current: VadTranslationUnit[],
  id: string,
  text: string,
  providerIndex?: number,
  startMs?: number,
  endMs?: number,
  firstSeenOrder?: number,
) {
  const normalizedIndex = typeof providerIndex === 'number' && Number.isInteger(providerIndex) && providerIndex >= 0
    ? providerIndex
    : undefined
  const next = [...current]
  const existingIndex = next.findIndex((unit) => unit.id === id)
  const previous = existingIndex >= 0 ? next[existingIndex] : undefined
  const unit = {
    id,
    providerSegmentId: id,
    text,
    providerIndex: normalizedIndex ?? previous?.providerIndex,
    startMs: typeof startMs === 'number' && Number.isFinite(startMs) && startMs >= 0
      ? startMs
      : previous?.startMs,
    endMs: typeof endMs === 'number' && Number.isFinite(endMs) && endMs >= 0
      ? endMs
      : previous?.endMs,
    firstSeenOrder: previous?.firstSeenOrder ?? firstSeenOrder ?? current.length,
    eventSnapshot: previous?.eventSnapshot || '',
  }
  if (existingIndex >= 0) next[existingIndex] = unit
  else next.push(unit)
  return next.sort((left, right) => {
    if (left.providerIndex !== undefined && right.providerIndex !== undefined) {
      return left.providerIndex - right.providerIndex
    }
    if (left.startMs !== undefined && right.startMs !== undefined && left.startMs !== right.startMs) {
      return left.startMs - right.startMs
    }
    return left.firstSeenOrder - right.firstSeenOrder
  })
}

function appendTranslationUnit(
  current: VadTranslationUnit[],
  providerSegmentId: string,
  text: string,
  providerIndex?: number,
  startMs?: number,
  endMs?: number,
  firstSeenOrder?: number,
  eventSnapshot = '',
) {
  const snapshot = eventSnapshot.trim()
  if (current.some((unit) => (
    unit.providerSegmentId === providerSegmentId
    && unit.text === text
    && unit.eventSnapshot === snapshot
  ))) return current
  const nextOrder = current.reduce((maximum, unit) => Math.max(maximum, unit.firstSeenOrder + 1), 0)
  const normalizedIndex = typeof providerIndex === 'number' && Number.isInteger(providerIndex) && providerIndex >= 0
    ? providerIndex
    : undefined
  const next = [...current, {
    id: `${providerSegmentId}#${firstSeenOrder ?? nextOrder}`,
    providerSegmentId,
    text,
    providerIndex: normalizedIndex,
    startMs: typeof startMs === 'number' && Number.isFinite(startMs) && startMs >= 0 ? startMs : undefined,
    endMs: typeof endMs === 'number' && Number.isFinite(endMs) && endMs >= 0 ? endMs : undefined,
    firstSeenOrder: firstSeenOrder ?? nextOrder,
    eventSnapshot: snapshot,
  }]
  return next.sort((left, right) => {
    if (left.providerIndex !== undefined && right.providerIndex !== undefined && left.providerIndex !== right.providerIndex) {
      return left.providerIndex - right.providerIndex
    }
    if (left.startMs !== undefined && right.startMs !== undefined && left.startMs !== right.startMs) {
      return left.startMs - right.startMs
    }
    return left.firstSeenOrder - right.firstSeenOrder
  })
}

function epochTextShouldAdvance(
  pair: VadTranscriptPair,
  nextText: string,
  nextEndMs: number | undefined,
  nextPriority: number,
  explicitReplacement = false,
) {
  if (explicitReplacement) return true
  if (!pair.translationEpochText) return true
  if (nextPriority < pair.translationEpochPriority) return false
  const currentEndMs = pair.translationEpochEndMs
  if (nextEndMs !== undefined && currentEndMs !== undefined) {
    if (nextEndMs !== currentEndMs) return nextEndMs > currentEndMs
    if (nextPriority > pair.translationEpochPriority) return true
    // model_output is a revisable preview delivered in order on both the
    // WebSocket and reliable WebRTC data channels. Before a stable unit exists,
    // the latest revision owns the same provider-audio watermark even when it
    // shortens or rewrites the previous preview.
    if (nextPriority === 1 && pair.translationEpochPriority === 1) return true
    if (pair.translationEpochText === nextText) return true
    if (pair.translationEpochText.startsWith(nextText)) return false
    if (nextText.startsWith(pair.translationEpochText)) return true
    if (nextText.length !== pair.translationEpochText.length) {
      return nextText.length > pair.translationEpochText.length
    }
    return true
  }
  if (currentEndMs !== undefined) {
    return nextPriority > pair.translationEpochPriority
  }
  if (nextEndMs !== undefined && nextPriority > pair.translationEpochPriority) return true
  if (nextPriority !== pair.translationEpochPriority) {
    return nextPriority > pair.translationEpochPriority
  }
  if (nextPriority === 1) return true
  if (pair.translationEpochText === nextText) return true
  if (pair.translationEpochText.startsWith(nextText)) return false
  if (nextText.startsWith(pair.translationEpochText)) return true
  if (nextText.length !== pair.translationEpochText.length) {
    return nextText.length > pair.translationEpochText.length
  }
  return nextPriority >= pair.translationEpochPriority
}

function modelEpochTextShouldAdvance(
  pair: VadTranscriptPair,
  nextText: string,
  nextEndMs: number | undefined,
) {
  const stableText = pair.translationStableEpochText
  if (!stableText) return epochTextShouldAdvance(pair, nextText, nextEndMs, 1)
  const stableEndMs = pair.translationStableEpochEndMs
  // A preview may extend a stable block only when both sides expose a provider
  // audio watermark and the preview covers newer audio. Exact stable-prefix
  // matching prevents a late or revised cumulative snapshot from taking the
  // row backwards across the Gateway VAD boundary.
  if (stableEndMs === undefined || nextEndMs === undefined || nextEndMs <= stableEndMs) return false
  if (pair.translationEpochEndMs !== undefined && nextEndMs < pair.translationEpochEndMs) return false
  return nextText !== stableText && nextText.startsWith(stableText)
}

function updatePair(
  state: VadTranscriptPairState,
  index: number,
  update: (pair: VadTranscriptPair) => VadTranscriptPair,
) {
  if (index < 0) return state
  const pair = update(state.pairs[index])
  // An update that changes nothing keeps the whole state identical, so hosts
  // can compare by reference instead of diffing the pair list.
  if (pair === state.pairs[index]) return state
  const pairs = [...state.pairs]
  pairs[index] = pair
  return { ...state, pairs }
}

export function reduceVadTranscriptPairEvent(
  current: VadTranscriptPairState,
  event: VadTranscriptEvent,
): VadTranscriptPairState {
  const relevant = event.type === 'source_vad_state'
    || event.type === 'source_vad_segment'
    || event.type === 'source_vad_commit'
    || event.type === 'source_delta'
    || event.type === 'source_update'
    || event.type === 'source_done'
    || event.type === 'model_output'
    || event.type === 'model_output_reset'
    || event.type === 'translation'
    || event.type === 'translation_done'
  if (!relevant || !eventPairID(event)) return current

  const ensured = ensurePair(current, event)
  let state = ensured.state
  const index = ensured.index

  if (isSourceVadStartEvent(event)) {
    state = updatePair(state, index, (pair) => withSourceVadStart(pair, event.startMs))
  } else if (providesProvisionalStart(event)) {
    state = updatePair(state, index, (pair) => withProvisionalStart(pair, event.startMs))
  }

  if (event.type === 'source_vad_state' && event.state === 'speech_start') {
    return updatePair(state, index, (pair) => {
      const speechEpoch = event.speechEpoch || pair.speechEpoch
      return speechEpoch === pair.speechEpoch ? pair : { ...pair, speechEpoch }
    })
  }

  if (event.type === 'source_vad_segment') {
    return updatePair(state, index, (pair) => {
      const speechEpoch = event.speechEpoch || pair.speechEpoch
      const endMs = event.endMs ?? pair.endMs
      return speechEpoch === pair.speechEpoch && endMs === pair.endMs
        ? pair
        : { ...pair, speechEpoch, endMs }
    })
  }

  if (event.type === 'source_vad_commit') {
    return updatePair(state, index, (pair) => ({
      ...pair,
      speechEpoch: event.speechEpoch || pair.speechEpoch,
      endMs: event.endMs ?? pair.endMs,
      committed: true,
    }))
  }

  if (event.type === 'source_delta' || event.type === 'source_update' || event.type === 'source_done') {
    const source = (event.epochText || event.segmentText || event.text || '').trim()
    if (!source) return state
    const previous = state.pairs[index - 1]
    const repeatedSnapshot = Boolean((event.epochText || event.segmentText) && event.text && previous?.sourceSnapshot
      && previous.sourceSnapshot !== previous.source
      && event.text.trim() === previous.sourceSnapshot
      && source === previous.source)
    return updatePair(state, index, (pair) => {
      const sourceStableText = event.type !== 'source_done'
        ? pair.sourceStableText
        : !pair.sourceStableText || source.startsWith(pair.sourceStableText)
          ? source
          : pair.sourceStableText
      const nextSource = event.type === 'source_done'
        ? sourceStableText
        : !sourceStableText || source.startsWith(sourceStableText)
          ? source
          : pair.source || sourceStableText
      return {
        ...pair,
        speechEpoch: event.speechEpoch || pair.speechEpoch,
        source: repeatedSnapshot ? '' : nextSource,
        sourceFinal: pair.sourceFinal || event.type === 'source_done',
        sourceStableText: repeatedSnapshot ? '' : sourceStableText,
        sourceSnapshot: event.text?.trim(),
        endMs: event.endMs ?? pair.endMs,
      }
    })
  }

  if (event.type === 'model_output') {
    // model_output.text is a revisable, session-cumulative snapshot. Prefix or
    // punctuation-based slicing can silently move words across VAD boundaries.
    // Only consume it when the backend explicitly supplies utterance-local text.
    const translation = (event.epochText || '').trim()
    if (!translation) return state
    const endMs = typeof event.endMs === 'number' && Number.isFinite(event.endMs) ? event.endMs : undefined
    if (event.modelOutputAuthoritative) {
      return updatePair(state, index, (pair) => {
        // This is the actual model text, not a TTS unit or speculative hint.
        // Equal audio cursors are normal while the model continues decoding.
        if (pair.translationModelAuthoritative && (
          (endMs !== undefined && pair.translationEpochEndMs !== undefined && endMs < pair.translationEpochEndMs)
          || !translation.startsWith(pair.translationStableEpochText)
        )) return pair
        return {
          ...pair,
          speechEpoch: event.speechEpoch || pair.speechEpoch,
          translation,
          translationEpochText: translation,
          translationStableEpochText: translation,
          translationPreviewSnapshot: event.text?.trim(),
          translationEpochEndMs: endMs ?? pair.translationEpochEndMs,
          translationStableEpochEndMs: endMs ?? pair.translationStableEpochEndMs,
          translationEpochPriority: 2,
          translationModelAuthoritative: true,
        }
      })
    }
    return updatePair(state, index, (pair) => modelEpochTextShouldAdvance(pair, translation, endMs)
      ? {
        ...pair,
        speechEpoch: event.speechEpoch || pair.speechEpoch,
        translation,
        translationEpochText: translation,
        translationPreviewSnapshot: event.text?.trim(),
        translationEpochEndMs: endMs,
        // This display value is still a revisable model preview. Stable
        // watermarks live in translationStableEpoch*, so the next final event
        // must retain higher priority even when it covers the same endMs.
        translationEpochPriority: 1,
      }
      : pair)
  }

  if (event.type === 'model_output_reset') {
    return updatePair(state, index, (pair) => {
      const stableTranslation = pair.translationStableEpochText || joinTranslationUnits(pair.translationUnits)
      return {
        ...pair,
        translation: stableTranslation,
        translationEpochText: pair.translationStableEpochText,
        translationEpochEndMs: pair.translationStableEpochEndMs,
        translationEpochPriority: pair.translationStableEpochText ? 2 : 0,
      }
    })
  }

  if (event.type === 'translation' || event.type === 'translation_done') {
    const epochText = (event.epochText || '').trim()
    const segmentText = (event.segmentText || '').trim()
    const previous = state.pairs[index - 1]
    // A preview can be attributed to one VAD and its final unit to the next.
    // Transfer it only when the cumulative snapshots prove the same occurrence;
    // a genuine repeated word advances the snapshot and must remain intact.
    const compact = (text: string) => text.replace(/\s+/gu, '')
    if (event.type === 'translation_done' && previous?.translationEpochPriority === 1
      && !previous.translationStableEpochText && previous.translationUnits.length === 0
      && previous.translation && previous.translationPreviewSnapshot && event.text
      && compact(previous.translationPreviewSnapshot).length > compact(previous.translation).length
      && compact(segmentText).startsWith(compact(previous.translation))
      && compact(previous.translationPreviewSnapshot).endsWith(compact(previous.translation))
      && compact(event.text) === compact(previous.translationPreviewSnapshot)
        + compact(segmentText).slice(compact(previous.translation).length)) {
      state = updatePair(state, index - 1, pair => ({
        ...pair, translation: '', translationEpochText: '', translationEpochPriority: 0,
        translationPreviewSnapshot: undefined,
      }))
    }
    const segmentId = event.segmentId?.trim()
    return updatePair(state, index, (pair) => {
      const doneEventKey = event.type === 'translation_done' && segmentId && segmentText
        ? `${segmentId}\u0000${segmentText}\u0000${(event.text || '').trim()}`
        : ''
      if (doneEventKey && pair.translationSeenDoneKeys.includes(doneEventKey)) return pair
      const replacedSegmentIds = new Set(
        (event.replaceSegmentIds || []).map((id) => id.trim()).filter(Boolean),
      )
      if (segmentId && pair.translationRetiredSegmentIds.includes(segmentId)) return pair
      const retiredSegmentIds = [...new Set([
        ...pair.translationRetiredSegmentIds,
        ...[...replacedSegmentIds].filter((id) => id !== segmentId),
      ])]
      const replacementUnit = pair.translationUnits.find((unit) => replacedSegmentIds.has(unit.providerSegmentId))
      const replacementOrder = replacementUnit?.firstSeenOrder
      const retainedUnits = replacedSegmentIds.size > 0
        ? pair.translationUnits.filter((unit) => !replacedSegmentIds.has(unit.providerSegmentId))
        : pair.translationUnits
      const canIdentifyUnit = Boolean(segmentId) || event.index !== undefined
      const units = segmentText && canIdentifyUnit
        ? event.type === 'translation_done'
          ? appendTranslationUnit(
            retainedUnits,
            segmentId || `translation-${event.index}`,
            segmentText,
            event.index ?? replacementUnit?.providerIndex,
            event.startMs ?? replacementUnit?.startMs,
            event.endMs ?? replacementUnit?.endMs,
            replacementOrder,
            event.text || '',
          )
          : upsertTranslationUnit(
            retainedUnits,
            segmentId || `translation-${event.index}`,
            segmentText,
            event.index ?? replacementUnit?.providerIndex,
            event.startMs ?? replacementUnit?.startMs,
            event.endMs ?? replacementUnit?.endMs,
            replacementOrder,
          )
        : retainedUnits
      const retainedSegmentIds = replacedSegmentIds.size > 0
        ? pair.translationSegmentIds.filter((id) => !replacedSegmentIds.has(id))
        : pair.translationSegmentIds
      const unitEndMs = units.reduce<number | undefined>((maximum, unit) => (
        unit.endMs === undefined ? maximum : maximum === undefined ? unit.endMs : Math.max(maximum, unit.endMs)
      ), undefined)
      const eventEndMs = typeof event.endMs === 'number' && Number.isFinite(event.endMs) ? event.endMs : undefined
      const epochEndMs = unitEndMs === undefined
        ? eventEndMs
        : eventEndMs === undefined ? unitEndMs : Math.max(unitEndMs, eventEndMs)
      const acceptEpochText = !pair.translationModelAuthoritative && Boolean(epochText) && epochTextShouldAdvance(
        pair,
        epochText,
        epochEndMs,
        2,
        replacedSegmentIds.size > 0,
      )
      const authoritativeEpochText = acceptEpochText ? epochText : pair.translationEpochText
      const stableEpochTextShouldAdvance = !pair.translationModelAuthoritative && Boolean(epochText) && epochTextShouldAdvance(
        {
          ...pair,
          translationEpochText: pair.translationStableEpochText,
          translationEpochEndMs: pair.translationStableEpochEndMs,
          translationEpochPriority: 2,
        },
        epochText,
        epochEndMs,
        2,
        replacedSegmentIds.size > 0,
      )
      const joinedUnits = segmentText && canIdentifyUnit ? joinTranslationUnits(units) : ''
      // A settled TTS unit (priority 2) must not stay hidden behind a model
      // preview (priority 1). A provider that reports only segmentText leaves
      // the accepted epoch text pointing at that preview forever, so its final
      // punctuation could never reach the display.
      // A frame that DID carry an epoch text is out of scope: rejecting it is a
      // deliberate staleness verdict, and its segment must not smuggle the
      // rollback back in.
      const preferUnits = !epochText && joinedUnits !== ''
        && pair.translationEpochPriority < 2
      return {
        ...pair,
        // epochText is authoritative. A local segment without a stable ID is
        // treated as one replacement snapshot: appending would invent order or
        // duplicate retries that the event contract cannot distinguish.
        translation: preferUnits ? joinedUnits : (authoritativeEpochText || (segmentText
          ? canIdentifyUnit ? joinedUnits : segmentText
          : pair.translation)),
        translationUnits: units,
        translationRetiredSegmentIds: retiredSegmentIds,
        translationSeenDoneKeys: doneEventKey
          ? [...pair.translationSeenDoneKeys, doneEventKey]
          : pair.translationSeenDoneKeys,
        translationEpochText: authoritativeEpochText,
        // An untimed stable final may supersede a timed model preview. Keep the
        // last known boundary as a watermark so a delayed preview cannot then
        // take ownership back merely because it carries a timestamp.
        translationEpochEndMs: acceptEpochText
          ? epochEndMs ?? pair.translationEpochEndMs
          : pair.translationEpochEndMs,
        translationEpochPriority: acceptEpochText ? 2 : pair.translationEpochPriority,
        translationStableEpochText: stableEpochTextShouldAdvance
          ? epochText
          : pair.translationStableEpochText,
        translationStableEpochEndMs: stableEpochTextShouldAdvance
          ? epochEndMs ?? pair.translationStableEpochEndMs
          : pair.translationStableEpochEndMs,
        translationSegmentIds: !segmentId || retainedSegmentIds.includes(segmentId)
          ? retainedSegmentIds
          : [...retainedSegmentIds, segmentId],
      }
    })
  }

  return state
}
