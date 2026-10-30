import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { expandNewRow, preserveLiveRowHeight } from '../lib/transcriptMotion'
import '../styles/transcript-motion.css'

export function ShowcaseMotionArticle({ terminal, animate = true, ...props }: HTMLAttributes<HTMLElement> & { terminal: boolean; animate?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { expandNewRow(ref.current!, !terminal && animate) }, [])
  useLayoutEffect(() => {
    if (terminal || !animate) ref.current?.classList.remove('replay-row-entering', 'replay-row-reflow')
  }, [terminal, animate])
  useLayoutEffect(() => {
    preserveLiveRowHeight(ref.current!, !terminal && animate && !props.className?.includes('--history'))
  })
  return <div ref={ref} className="replay-motion-row">
    <div className="replay-motion-row-inner"><article {...props} /></div>
  </div>
}
