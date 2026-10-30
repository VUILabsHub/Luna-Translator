import { useCallback, useLayoutEffect, type RefObject } from 'react'

type Rect = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>
type Viewport = Rect

/** Native modal dialogs enter the top layer, so their containing block is the viewport. */
export function boundedDialogRect(container: Rect, viewport: Viewport): Rect {
  const left = Math.max(container.left, viewport.left)
  const top = Math.max(container.top, viewport.top)
  return {
    left,
    top,
    width: Math.max(0, Math.min(container.left + container.width, viewport.left + viewport.width) - left),
    height: Math.max(0, Math.min(container.top + container.height, viewport.top + viewport.height) - top),
  }
}

export function measureBoundedDialog(dialog: HTMLDialogElement, selector: string): HTMLElement | null {
  const container = dialog.closest<HTMLElement>(selector)
  const view = dialog.ownerDocument.defaultView
  if (!container || !view) return null
  const visual = view.visualViewport
  const viewport = {
    left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
    width: visual?.width ?? view.innerWidth, height: visual?.height ?? view.innerHeight,
  }
  const rect = boundedDialogRect(container.getBoundingClientRect(), viewport)
  dialog.style.setProperty('--bounded-dialog-left', `${rect.left}px`)
  dialog.style.setProperty('--bounded-dialog-top', `${rect.top}px`)
  dialog.style.setProperty('--bounded-dialog-width', `${rect.width}px`)
  dialog.style.setProperty('--bounded-dialog-height', `${rect.height}px`)
  dialog.style.setProperty('--bounded-dialog-radius', view.getComputedStyle(container).borderRadius)
  return container
}

/** Observe only while open; no React render is needed when browser chrome/keyboard moves. */
export function observeBoundedDialog(dialog: HTMLDialogElement, selector: string): () => void {
  const container = measureBoundedDialog(dialog, selector)
  const view = dialog.ownerDocument.defaultView
  if (!container || !view) return () => undefined
  const measure = () => { measureBoundedDialog(dialog, selector) }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
  observer?.observe(container)
  view.addEventListener('resize', measure)
  view.addEventListener('orientationchange', measure)
  view.addEventListener('scroll', measure, { capture: true, passive: true })
  view.visualViewport?.addEventListener('resize', measure)
  view.visualViewport?.addEventListener('scroll', measure)
  return () => {
    observer?.disconnect()
    view.removeEventListener('resize', measure)
    view.removeEventListener('orientationchange', measure)
    view.removeEventListener('scroll', measure, { capture: true })
    view.visualViewport?.removeEventListener('resize', measure)
    view.visualViewport?.removeEventListener('scroll', measure)
  }
}

export function useBoundedDialog(ref: RefObject<HTMLDialogElement | null>, selector: string, open: boolean): () => void {
  // Called immediately before showModal, preventing a first-frame viewport-aligned drawer.
  const measure = useCallback(() => { if (ref.current) measureBoundedDialog(ref.current, selector) }, [ref, selector])
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    return observeBoundedDialog(ref.current, selector)
  }, [ref, selector, open])
  return measure
}
