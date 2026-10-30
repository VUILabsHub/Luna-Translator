import { useEffect, useState } from 'react'
import type { ConsumerHistoryTitle } from '../lib/consumerHistory'
import { historyTitleIsTerminal, pollHistoryTitle } from '../lib/historyTitlePolling'

/** Keep title refreshes separate from transcript/audio data and from public sharing reads. */
export function useHistoryTitle(id: string, initial?: ConsumerHistoryTitle, enabled = true): ConsumerHistoryTitle {
  const [resolved, setResolved] = useState<{ id: string; value: ConsumerHistoryTitle } | null>(null)
  const initialStatus = initial?.titleStatus
  useEffect(() => {
    if (!enabled) return
    return pollHistoryTitle({ id, initialStatus, onUpdate: value => setResolved({ id, value }) })
  }, [id, initialStatus, enabled])
  // Without an id, `resolved?.id === id` would hold for undefined === undefined and read a null record.
  return enabled && !!id && resolved?.id === id && !historyTitleIsTerminal(initialStatus)
    ? { ...initial, ...resolved.value }
    : initial || {}
}
