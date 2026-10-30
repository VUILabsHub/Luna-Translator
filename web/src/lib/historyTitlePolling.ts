import { loadConsumerHistory, type ConsumerHistoryTitle } from './consumerHistory'

type TitleRecord = ConsumerHistoryTitle & { id: string }

/**
 * A title that will not change by itself: generated (ready), given up (fallback) or chosen by the
 * owner (user, P2-2 rename). Such records are never polled.
 */
export function historyTitleIsTerminal(status: ConsumerHistoryTitle['titleStatus']): boolean {
  return status === 'ready' || status === 'fallback' || status === 'user'
}

/** Read the saved record only. A terminal title never starts another request. */
export function pollHistoryTitle({
  id,
  initialStatus,
  onUpdate,
  read = (recordId, signal) => loadConsumerHistory(recordId, undefined, signal),
}: {
  id: string
  initialStatus?: ConsumerHistoryTitle['titleStatus']
  onUpdate: (title: ConsumerHistoryTitle) => void
  read?: (id: string, signal: AbortSignal) => Promise<TitleRecord>
}): () => void {
  if (!id || historyTitleIsTerminal(initialStatus)) return () => undefined
  const controller = new AbortController()
  let stopped = false
  let next: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    clearTimeout(next)
    clearTimeout(deadline)
    controller.abort()
  }
  // Includes time spent waiting for an HTTP response; a stalled request cannot outlive the page's budget.
  const deadline = setTimeout(stop, 30_000)
  const schedule = () => { next = setTimeout(() => { void refresh() }, 2_000) }
  const refresh = async () => {
    try {
      const record = await read(id, controller.signal)
      if (stopped) return
      if (record.id !== id) { stop(); return }
      const { title, titleStatus, scene, mode } = record
      onUpdate({ title, titleStatus, ...(scene ? { scene } : {}), ...(mode ? { mode } : {}) })
      // Older servers have no title state. Read once and keep the scene fallback.
      if (titleStatus !== 'pending') { stop(); return }
    } catch {
      if (stopped) return
      // A title is optional: transient failures keep the existing title and never hide the transcript.
    }
    schedule()
  }
  if (initialStatus === 'pending') schedule()
  else void refresh()
  return stop
}
