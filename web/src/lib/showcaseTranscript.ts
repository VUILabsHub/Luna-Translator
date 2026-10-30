import type { Status } from '@simultrans/ui-shared/src/hooks/useRealtimeSession'

// Display only: keep the raw ASR text for persistence, alignment and diagnostics.
export function asrDisplayText(text: string) {
  return text.includes('\uFFFD') ? text.replace(/\uFFFD/g, '').replace(/[ \t]{2,}/g, ' ') : text
}

export type ShowcaseRowPresentation = {
  opacity: number
  historical: boolean
}

export function reconcileTypewriterText(current: string, target: string) {
  return target.startsWith(current) ? current : target
}

export function showcaseRowPresentation(
  status: Status,
  distanceFromLatest: number,
): ShowcaseRowPresentation {
  const terminal = status === 'finished' || status === 'error'
  if (terminal || distanceFromLatest <= 1) {
    return { opacity: 1, historical: false }
  }
  return {
    opacity: distanceFromLatest === 2
      ? 0.46
      : distanceFromLatest === 3
        ? 0.24
        : 0.12,
    historical: true,
  }
}
