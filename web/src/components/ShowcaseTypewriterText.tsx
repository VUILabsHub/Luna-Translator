import { useEffect, useLayoutEffect, useState } from 'react'
import type { ShowcasePlaybackStatus } from '@simultrans/ui-shared/src/lib/showcaseRows'
import { reconcileTypewriterText } from '../lib/showcaseTranscript'
import { remapPlaybackFragments } from '@simultrans/ui-shared/src/lib/playbackText'

const typewriterStepMs = 18

export function ShowcaseTypewriterText({
  text,
  playbackFragments,
  enabled,
  onProgress,
}: {
  text: string
  playbackFragments?: ReadonlyArray<{ text: string; playing: boolean; status?: ShowcasePlaybackStatus }>
  enabled: boolean
  onProgress: () => void
}) {
  const [visible, setVisible] = useState(text)
  const motionEnabled = enabled
    && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

  useLayoutEffect(() => {
    if (!motionEnabled) {
      setVisible(text)
      return
    }
    setVisible((current) => reconcileTypewriterText(current, text))
  }, [motionEnabled, text])

  useEffect(() => {
    if (!motionEnabled || visible === text) return
    const timer = window.setTimeout(() => {
      setVisible((current) => {
        if (!text.startsWith(current)) return text
        const currentCharacters = [...current]
        const targetCharacters = [...text]
        return targetCharacters.slice(0, Math.min(targetCharacters.length, currentCharacters.length + 1)).join('')
      })
    }, typewriterStepMs)
    return () => window.clearTimeout(timer)
  }, [motionEnabled, text, visible])

  useLayoutEffect(() => {
    if (motionEnabled) onProgress()
  }, [motionEnabled, onProgress, visible])

  const typing = motionEnabled && visible !== text
  const renderFragments = remapPlaybackFragments(text, playbackFragments)
  const displayed = motionEnabled ? visible : text
  let visibleLength = displayed.length
  return (
    <span className="realtime-showcase-typewriter" data-typing={typing}>
      {renderFragments ? renderFragments.map((fragment, index) => {
        const fragmentText = fragment.text.slice(0, visibleLength)
        visibleLength = Math.max(0, visibleLength - fragment.text.length)
        const status = fragment.status ?? (fragment.playing ? 'playing' : undefined)
        return fragmentText ? (
          <span
            key={`${index}:${fragment.text}`}
            className={`showcase-translation-playback-fragment${status ? ` is-${status}` : ''}`}
          >
            {fragmentText}
          </span>
        ) : null
      }) : displayed}
    </span>
  )
}
