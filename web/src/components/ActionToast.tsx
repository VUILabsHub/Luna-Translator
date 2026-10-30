import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../styles/action-toast.css'

/** Short feedback for an explicit action; never implies a browser download was saved to disk. */
export function useActionToast() {
  const [notice, setNotice] = useState<{ message: string; error: boolean; id: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(false)
  const nextId = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])
  const clearToast = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    if (mounted.current) setNotice(null)
  }, [])
  const showToast = useCallback((message: string, error = false) => {
    if (!mounted.current) return
    if (timer.current !== null) clearTimeout(timer.current)
    setNotice({ message, error, id: ++nextId.current })
    timer.current = setTimeout(() => { timer.current = null; setNotice(null) }, error ? 5000 : 3500)
  }, [])
  const toast = notice && typeof document !== 'undefined'
    ? createPortal(<div key={notice.id} className="action-toast" role={notice.error ? 'alert' : 'status'} aria-atomic="true">{notice.message}</div>, document.body)
    : null
  return { toast, showToast, clearToast }
}
