type VisibleText = { source: string; translation: string }
const previousText = new WeakMap<Element, VisibleText>()
const rowHeights = new WeakMap<HTMLElement, { height: number; source: boolean; translation: boolean }>()
const normalize = (text: string) => text.replace(/[^\p{L}\p{N}\p{M}]/gu, '')
function visibleText(root: Element): VisibleText {
  return {
    source: normalize([...root.querySelectorAll('.realtime-showcase-source .realtime-showcase-typewriter')].map(node => node.textContent || '').join('')),
    translation: normalize([...root.querySelectorAll('.showcase-translation-line.is-primary .realtime-showcase-typewriter')].map(node => node.textContent || '').join('')),
  }
}

export function preserveLiveRowHeight(row: HTMLElement, enabled: boolean) {
  const text = visibleText(row)
  const source = Boolean(text.source), translation = Boolean(text.translation)
  const previous = rowHeights.get(row)
  const retracting = enabled && previous
    && ((previous.source && !source) || (previous.translation && !translation))
  row.style.minHeight = retracting ? `${previous.height}px` : ''
  if (!enabled) rowHeights.delete(row)
  else if (!retracting) rowHeights.set(row, { height: row.getBoundingClientRect().height, source, translation })
}

// Display-only follower. Text, row membership and playback state remain upstream.
export function createTranscriptMotion(element: HTMLElement) {
  const win = element.ownerDocument.defaultView!
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  let enabled = true, following = true, pointer = false, frame = 0, timer = 0
  let written = element.scrollTop, position = written, lastTime = 0
  const bottom = () => Math.max(0, element.scrollHeight - element.clientHeight)
  const clearTimer = () => { win.clearTimeout(timer); timer = 0 }
  const stop = () => { win.cancelAnimationFrame(frame); frame = 0; lastTime = 0 }
  const write = (value: number) => { element.scrollTop = value; written = element.scrollTop }
  const snap = () => { stop(); position = bottom(); write(position) }
  const tick = (now: number) => {
    frame = 0
    if (!enabled || !following || pointer) { lastTime = 0; return }
    const target = bottom()
    const elapsed = lastTime ? Math.min(64, now - lastTime) : 16
    lastTime = now
    // Follow a moving target without restarting an animation on every text update.
    // Cap long catch-up moves so returning from an older passage stays readable.
    const eased = (target - position) * (1 - Math.exp(-elapsed / 150))
    const maxStep = 1.8 * elapsed
    position += Math.max(-maxStep, Math.min(maxStep, eased))
    if (Math.abs(target - position) < 0.75 || reduced.matches) { snap(); return }
    write(position)
    frame = win.requestAnimationFrame(tick)
  }
  const update = () => {
    const track = element.querySelector('.realtime-showcase-transcript-track')
    if (track) previousText.set(track, visibleText(track))
    if (!enabled || !following || pointer) return
    if (reduced.matches) { snap(); return }
    if (!frame) { position = element.scrollTop; frame = win.requestAnimationFrame(tick) }
  }
  const resume = () => {
    clearTimer()
    if (enabled) timer = win.setTimeout(() => {
      if (!pointer) { following = true; update() }
    }, 5000)
  }
  const interrupt = () => { following = false; stop(); clearTimer() }
  const onScroll = () => {
    // A damped frame is deliberately far from the bottom. It isn't a user scroll.
    if (Math.abs(element.scrollTop - written) <= 1) return
    position = element.scrollTop
    if (!enabled) return
    // Only re-arm following here. A scroll event alone never turns it off:
    // a transient layout shrink (row variant change, entering row) clamps
    // scrollTop and fires scroll too, and that must not read as the user
    // scrolling away. User intent arrives as wheel / key / pointer events.
    if (bottom() - position <= 24 && !pointer) { following = true; clearTimer(); update() }
  }
  const onDown = () => { pointer = true; interrupt() }
  const onUp = (event: PointerEvent) => {
    if (!pointer) return
    pointer = false
    if (!enabled) return
    // pointercancel: the browser took the touch over as a scroll — judge by position.
    // pointerup without a scroll is a tap (e.g. play a sentence); keep following.
    if (event.type !== 'pointercancel' || bottom() - element.scrollTop <= 24) { following = true; clearTimer(); update() }
    else resume()
  }
  const onWheel = () => { interrupt(); resume() }
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) onWheel()
  }
  const onReduced = () => {
    if (reduced.matches) element.querySelectorAll('.replay-row-entering, .replay-row-reflow').forEach(row => row.classList.remove('replay-row-entering', 'replay-row-reflow'))
    if (enabled && following) update()
  }
  element.addEventListener('scroll', onScroll, { passive: true })
  element.addEventListener('wheel', onWheel, { passive: true })
  element.addEventListener('pointerdown', onDown, { passive: true })
  win.addEventListener('pointerup', onUp, { passive: true })
  win.addEventListener('pointercancel', onUp, { passive: true })
  element.addEventListener('keydown', onKey)
  reduced.addEventListener('change', onReduced)
  const observer = new win.ResizeObserver(update)
  observer.observe(element)
  const track = element.querySelector('.realtime-showcase-transcript-track')
  if (track) { observer.observe(track); previousText.set(track, visibleText(track)) }
  // Prevent native scroll anchoring from competing with the follower.
  const oldAnchor = element.style.overflowAnchor
  element.style.overflowAnchor = 'none'
  return {
    update,
    get following() { return following },
    hold: interrupt,
    jump() { following = true; clearTimer(); snap() },
    setEnabled(value: boolean) {
      if (enabled === value) return
      enabled = value; following = value
      if (value) update()
      else { stop(); clearTimer() }
    },
    destroy() {
      stop(); clearTimer(); observer.disconnect()
      element.style.overflowAnchor = oldAnchor
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('pointerdown', onDown)
      win.removeEventListener('pointerup', onUp)
      win.removeEventListener('pointercancel', onUp)
      element.removeEventListener('keydown', onKey)
      reduced.removeEventListener('change', onReduced)
    },
  }
}

export function expandNewRow(row: HTMLElement, animate: boolean) {
  row.classList.remove('replay-row-entering', 'replay-row-reflow')
  if (!animate || row.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const before = row.parentElement && previousText.get(row.parentElement)
  const text = visibleText(row)
  const preceding = { source: '', translation: '' }
  for (const sibling of row.parentElement?.children || []) {
    if (sibling === row) break
    const content = visibleText(sibling)
    preceding.source += content.source
    preceding.translation += content.translation
  }
  // A short live row can get a new semantic ID without introducing new text.
  // Compare its reading position, not arbitrary earlier occurrences of "Hello".
  const continuesAtPosition = before && (['source', 'translation'] as const).some(kind => {
    if (!before[kind].startsWith(preceding[kind])) return false
    const remaining = before[kind].slice(preceding[kind].length)
    return text[kind].length > 0 && remaining.length > 0
      && (remaining.startsWith(text[kind]) || text[kind].startsWith(remaining))
  })
  // A semantic commit can move an already visible tail into a new row ID.
  // Collapsing it would remove existing height, clamp scrollTop and replay old text.
  const moved = before && ((text.source.length >= 8 && before.source.includes(text.source))
    || (text.translation.length >= 12 && before.translation.includes(text.translation)))
  // Replacing visible content must not collapse either its height or its gap.
  if (continuesAtPosition || moved) return
  const gap = row.parentElement ? row.ownerDocument.defaultView!.getComputedStyle(row.parentElement).rowGap : '0px'
  row.style.setProperty('--replay-row-gap', row.previousElementSibling && gap !== 'normal' ? gap : '0px')
  row.classList.add('replay-row-entering')
  row.addEventListener('animationend', event => {
    if (event.target === row) row.classList.remove('replay-row-entering', 'replay-row-reflow')
  }, { once: true })
}
