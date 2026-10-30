import { useRef, type MouseEvent, type PointerEvent } from 'react'

// A drag can still end in a click on the sentence button (notably with a mouse).
// Keep that click from toggling playback; keyboard activation remains a click.
export function useTranscriptPlaybackGesture() {
  const origin = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)
  const trackMovement = (event: PointerEvent<HTMLDivElement>) => {
    if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) {
      dragged.current = true
    }
  }
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      origin.current = { x: event.clientX, y: event.clientY }
      dragged.current = false
    },
    onPointerMoveCapture: trackMovement,
    onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => {
      trackMovement(event)
      origin.current = null
    },
    onPointerCancelCapture: () => {
      dragged.current = true
      origin.current = null
    },
    onScrollCapture: () => {
      if (origin.current) dragged.current = true
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (event.detail === 0 || !dragged.current) return
      if (!(event.target instanceof Element) || !event.target.closest('.showcase-source-playback, .showcase-translation-line.is-playable')) return
      event.preventDefault()
      event.stopPropagation()
    },
  }
}
