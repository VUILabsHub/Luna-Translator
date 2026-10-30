import { useEffect } from 'react'
import type { HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { loadConsumerHistoryAudio, lookupConsumerHistoryId } from '../lib/consumerHistory'

// Finalization/upload runs in the background. Retry without blocking the end
// screen; never substitute microphone audio for a missing processed archive.
export function useModelInputArchive(
  sessionIds: string[],
  enabled: boolean,
  capture: (entry: { id: string }, archive: HistoryAudioArchive) => void,
) {
  const key = sessionIds.filter(Boolean).join(':')
  useEffect(() => {
    if (!enabled || !key) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Set(key.split(':'))
    let attempts = 0
    const refresh = async () => {
      attempts += 1
      await Promise.all([...pending].map(async (id) => {
        try {
          const historyId = await lookupConsumerHistoryId(key)
          if (cancelled || !historyId) return
          const modelInput = await loadConsumerHistoryAudio(historyId, id, 'input-model')
          if (!cancelled && modelInput) {
            capture({ id }, { modelInput })
            pending.delete(id)
          }
        } catch { /* Remain retryable while the background archive is saving. */ }
      }))
      if (!cancelled && pending.size && attempts < 30) timer = setTimeout(() => { void refresh() }, 2000)
    }
    void refresh()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [key, enabled, capture])
}
