export interface WebRTCOutputReader {
  stop: () => void | Promise<void>
}

export interface WebRTCOutputTrack {
  attach: (element: HTMLAudioElement) => unknown
  detach: (element: HTMLAudioElement) => unknown
}

export interface WebRTCOutputRoom {
  startAudio: () => void | Promise<void>
}

export interface WebRTCOutputAudioOptions {
  track: WebRTCOutputTrack
  room: WebRTCOutputRoom
  element: HTMLAudioElement
  append: (element: HTMLAudioElement) => void
  createReader: () => WebRTCOutputReader | Promise<WebRTCOutputReader>
  onPlaying?: () => void
  onPlaybackBlocked?: (error: unknown) => void
  onReaderError?: (error: unknown) => void
}

export interface WebRTCOutputAudioController {
  element: HTMLAudioElement
  readerReady: Promise<WebRTCOutputReader | null>
  startAudio: () => Promise<void>
  stopReader: () => Promise<void>
  detach: () => Promise<void>
}

export function isUserGesturePlaybackError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /user gesture|user interaction|initiated by a user|play\(\).*not allowed/i.test(message)
}

/**
 * Starts native LiveKit playback independently from the optional PCM analysis
 * reader. Reader startup is deliberately best-effort: native playback may
 * continue when analysis or local archival is unavailable.
 */
export async function attachWebRTCOutputAudio({
  track,
  room,
  element,
  append,
  createReader,
  onPlaying,
  onPlaybackBlocked,
  onReaderError,
}: WebRTCOutputAudioOptions): Promise<WebRTCOutputAudioController> {
  let detached = false
  let detachPromise: Promise<void> | null = null
  let activeReader: WebRTCOutputReader | null = null
  let readerReady!: Promise<WebRTCOutputReader | null>
  const stoppedReaders = new WeakSet<WebRTCOutputReader>()

  const stopReaderOnce = (reader: WebRTCOutputReader): Promise<void> => {
    if (stoppedReaders.has(reader)) return Promise.resolve()
    stoppedReaders.add(reader)
    try {
      return Promise.resolve(reader.stop()).catch(() => undefined)
    } catch {
      return Promise.resolve()
    }
  }

  const playingListener = () => onPlaying?.()

  const detach = (): Promise<void> => {
    if (detachPromise) return detachPromise
    detached = true

    // Invoke reader shutdown before detaching the playback element when the
    // reader is already available. A reader that resolves later is stopped by
    // the readerReady continuation below instead of delaying UI cleanup.
    const readerStop = activeReader ? stopReaderOnce(activeReader) : Promise.resolve()
    element.removeEventListener('playing', playingListener)
    try {
      track.detach(element)
    } catch {
      // Cleanup is best-effort; continue releasing the DOM playback element.
    }
    try {
      element.pause()
    } catch {
      // Some test doubles and detached media elements can reject pause().
    }
    element.srcObject = null
    element.remove()

    detachPromise = readerStop
    return detachPromise
  }

  // The listener must exist before insertion or attachment because autoplay
  // can emit `playing` immediately once the remote MediaStream is assigned.
  element.addEventListener('playing', playingListener, { once: true })
  try {
    append(element)
    track.attach(element)
  } catch (error) {
    await detach()
    throw error
  }

  const startAudio = (): Promise<void> => {
    try {
      return Promise.resolve(room.startAudio())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  let initialStartAudio: Promise<void>
  try {
    // Invoke this synchronously before scheduling reader creation. Playback
    // must never wait for the archival/energy-analysis path.
    initialStartAudio = startAudio()
  } catch (error) {
    await detach()
    throw error
  }

  readerReady = Promise.resolve()
    .then(createReader)
    .then(async (reader): Promise<WebRTCOutputReader | null> => {
      if (detached) {
        await stopReaderOnce(reader)
        return null
      }
      activeReader = reader
      return reader
    })
    .catch((error): null => {
      if (detached) return null
      try {
        onReaderError?.(error)
      } catch {
        // Diagnostics callbacks must not turn optional analysis into a fatal
        // playback failure.
      }
      return null
    })

  try {
    await initialStartAudio
  } catch (error) {
    if (!isUserGesturePlaybackError(error)) {
      await detach()
      throw error
    }
    try {
      onPlaybackBlocked?.(error)
    } catch {
      // A UI notification failure must not tear down a recoverable audio track.
    }
  }

  const stopReader = async () => {
    const reader = activeReader || await readerReady
    if (reader) await stopReaderOnce(reader)
  }

  return { element, readerReady, startAudio, stopReader, detach }
}

export type WebRTCOutputReaderState = 'pending' | 'ready' | 'unavailable'

export interface WebRTCOutputEvidence {
  nativePlaying: boolean
  readerState: WebRTCOutputReaderState
  signalSeen: boolean
}

export type WebRTCOutputEvidenceEvent =
  | { type: 'native-playing' }
  | { type: 'reader-ready' }
  | { type: 'reader-unavailable' }
  | { type: 'pcm'; hasSignal: boolean }

export function emptyWebRTCOutputEvidence(): WebRTCOutputEvidence {
  return {
    nativePlaying: false,
    readerState: 'pending',
    signalSeen: false,
  }
}

/** Monotonic evidence reducer: once playback or signal is seen, it stays seen. */
export function reduceWebRTCOutputEvidence(
  state: WebRTCOutputEvidence,
  event: WebRTCOutputEvidenceEvent,
): WebRTCOutputEvidence {
  switch (event.type) {
    case 'native-playing':
      return state.nativePlaying ? state : { ...state, nativePlaying: true }
    case 'reader-ready':
      return state.readerState === 'ready' ? state : { ...state, readerState: 'ready' }
    case 'reader-unavailable':
      return state.readerState === 'unavailable'
        ? state
        : { ...state, readerState: 'unavailable' }
    case 'pcm': {
      const readerState = state.readerState === 'pending' ? 'ready' : state.readerState
      const signalSeen = state.signalSeen || event.hasSignal
      if (readerState === state.readerState && signalSeen === state.signalSeen) return state
      return { ...state, readerState, signalSeen }
    }
  }
}

export function hasLiveWebRTCOutput(evidence: WebRTCOutputEvidence): boolean {
  return evidence.nativePlaying && evidence.signalSeen
}

export type WebRTCOutputCompletion =
  | 'confirmed'
  | 'reader-unavailable'
  | 'not-playing'
  | 'reader-pending'
  | 'active-silent'

/**
 * Classifies why output can or cannot be confirmed at session completion.
 * `active-silent` means the native element is playing while a working reader
 * has observed no non-silent PCM. `reader-unavailable` is kept separate because
 * silence cannot be inferred when analysis failed to start.
 */
export function classifyWebRTCOutputCompletion(
  evidence: WebRTCOutputEvidence,
): WebRTCOutputCompletion {
  if (hasLiveWebRTCOutput(evidence)) return 'confirmed'
  if (!evidence.nativePlaying) return 'not-playing'
  if (evidence.readerState === 'unavailable') return 'reader-unavailable'
  if (evidence.readerState === 'pending') return 'reader-pending'
  return 'active-silent'
}
