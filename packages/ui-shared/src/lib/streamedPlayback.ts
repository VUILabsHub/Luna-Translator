// Change record (2026-08-05): model sentence-level completion for chunked TTS
// so UI highlighting ends only after input completion and queued playout drain.

export type StreamedPlaybackSegment = {
  pendingChunks: number
  inputDone: boolean
}

export type StreamedPlaybackSegments = Map<string, StreamedPlaybackSegment>

export function queuePlaybackChunk(segments: StreamedPlaybackSegments, segmentId: string) {
  const segment = segments.get(segmentId) ?? { pendingChunks: 0, inputDone: false }
  segment.pendingChunks += 1
  segments.set(segmentId, segment)
}

export function finishPlaybackChunk(segments: StreamedPlaybackSegments, segmentId: string) {
  const segment = segments.get(segmentId)
  if (!segment) return false
  segment.pendingChunks = Math.max(0, segment.pendingChunks - 1)
  if (!segment.inputDone || segment.pendingChunks > 0) return false
  segments.delete(segmentId)
  return true
}

export function finishPlaybackInput(segments: StreamedPlaybackSegments, segmentId: string) {
  const segment = segments.get(segmentId) ?? { pendingChunks: 0, inputDone: false }
  segment.inputDone = true
  if (segment.pendingChunks > 0) {
    segments.set(segmentId, segment)
    return false
  }
  segments.delete(segmentId)
  return true
}
