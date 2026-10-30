import { useSyncExternalStore } from 'react'
import { productionMeetingJoinEnabled } from './productionMeetingJoin'

/** UI rollout is restricted to the Canary host. Local preview requires an explicit dev flag. */
export function canaryDesignEnabled(hostname = typeof window === 'undefined' ? '' : window.location.hostname): boolean {
  return false
}

const mobileQuery = '(max-width: 900px), (pointer: coarse) and (hover: none)'
function subscribeMobile(callback: () => void) {
  const query = window.matchMedia(mobileQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}
export function useCanaryMobileDesign(): boolean {
  return useSyncExternalStore(subscribeMobile, () => canaryDesignEnabled() && window.matchMedia(mobileQuery).matches, () => false)
}
