import { useSyncExternalStore } from 'react'
import { analyticsAccountId } from '@simultrans/ui-shared/src/lib/analyticsConsent'
import { getConsumerSessionRevision, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'

function subscribe(onChange: () => void) {
  const unsubscribe = subscribeConsumerSession(onChange)
  window.addEventListener('consumer:session-changed', onChange)
  window.addEventListener('consumer:session-expired', onChange)
  return () => {
    unsubscribe()
    window.removeEventListener('consumer:session-changed', onChange)
    window.removeEventListener('consumer:session-expired', onChange)
  }
}
const snapshot = () => JSON.stringify([analyticsAccountId(), getConsumerSessionRevision()])

/** Token rotation keeps drafts; a replacement login cannot inherit private work. */
export function useConsumerIdentity(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '["",0]')
}
