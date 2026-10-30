export interface WebRTCInputArchiveReader {
  capturePipeline?: 'audio-worklet' | 'script-processor' | 'rtc-sdk'
  stop: () => void | Promise<void>
}

export interface WebRTCInputArchiveOptions {
  createReader: () => WebRTCInputArchiveReader | Promise<WebRTCInputArchiveReader>
  onReady?: (reader: WebRTCInputArchiveReader) => void
  onError?: (error: unknown) => void
}

export interface WebRTCInputArchiveController {
  readerReady: Promise<WebRTCInputArchiveReader | null>
  stop: () => Promise<void>
}

/**
 * Starts optional local input archival without delaying the native LiveKit
 * microphone publication path. A reader that resolves after stop is closed
 * immediately, and startup failures stay local to archival diagnostics.
 */
export function startWebRTCInputArchive({
  createReader,
  onReady,
  onError,
}: WebRTCInputArchiveOptions): WebRTCInputArchiveController {
  let stopped = false
  let activeReader: WebRTCInputArchiveReader | null = null
  let stopPromise: Promise<void> | null = null
  const stoppedReaders = new WeakSet<WebRTCInputArchiveReader>()

  const stopReaderOnce = (reader: WebRTCInputArchiveReader): Promise<void> => {
    if (stoppedReaders.has(reader)) return Promise.resolve()
    stoppedReaders.add(reader)
    try {
      return Promise.resolve(reader.stop()).catch(() => undefined)
    } catch {
      return Promise.resolve()
    }
  }

  const readerReady = Promise.resolve()
    .then(createReader)
    .then(async (reader): Promise<WebRTCInputArchiveReader | null> => {
      if (stopped) {
        await stopReaderOnce(reader)
        return null
      }
      activeReader = reader
      try {
        onReady?.(reader)
      } catch {
        // Diagnostics callbacks must not make optional archival fatal.
      }
      return reader
    })
    .catch((error): null => {
      if (stopped) return null
      try {
        onError?.(error)
      } catch {
        // Diagnostics callbacks must not make optional archival fatal.
      }
      return null
    })

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopped = true
    stopPromise = activeReader ? stopReaderOnce(activeReader) : Promise.resolve()
    return stopPromise
  }

  return { readerReady, stop }
}
