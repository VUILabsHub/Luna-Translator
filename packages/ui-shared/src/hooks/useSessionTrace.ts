import { useRef, useState, type RefObject } from 'react'
import type { SessionTrace, StabilityMetrics, TraceKey } from '../types/history'

export type SessionTraceControl = {
  trace: SessionTrace
  stability: StabilityMetrics
  traceRef: RefObject<SessionTrace>
  traceStartedAtRef: RefObject<number>
  disconnectCountRef: RefObject<number>
  reconnectAttemptsRef: RefObject<number>
  maxOutputGapMsRef: RefObject<number | null>
  noOutputTimeoutsRef: RefObject<number>
  markTrace: (key: TraceKey) => void
  markTraceOnce: (key: TraceKey) => void
  markTraceAt: (key: TraceKey, timestamp: number) => void
  markDisconnect: () => void
  markReconnectAttempt: () => void
  markConnectionRestored: () => void
  markOutputActivity: () => void
  recordNoOutputTimeout: () => void
  resetForNewSession: () => void
}

export function useSessionTrace(): SessionTraceControl {
  const [trace, setTrace] = useState<SessionTrace>({})
  const [stability, setStability] = useState<StabilityMetrics>({
    disconnectCount: 0,
    reconnectAttempts: 0,
    maxOutputGapMs: null,
    noOutputTimeouts: 0,
  })

  const traceStartedAtRef = useRef(0)
  const traceRef = useRef<SessionTrace>({})
  const disconnectCountRef = useRef(0)
  const reconnectAttemptsRef = useRef(0)
  const maxOutputGapMsRef = useRef<number | null>(null)
  const noOutputTimeoutsRef = useRef(0)
  const lastOutputAtRef = useRef(0)
  const disconnectMarkedRef = useRef(false)

  const markTrace = (key: TraceKey) => {
    if (traceStartedAtRef.current <= 0) return
    const next = { ...traceRef.current, [key]: Math.max(0, performance.now() - traceStartedAtRef.current) }
    traceRef.current = next
    setTrace(next)
  }

  const markTraceOnce = (key: TraceKey) => {
    if (traceRef.current[key] === undefined) markTrace(key)
  }

  const markTraceAt = (key: TraceKey, timestamp: number) => {
    if (traceStartedAtRef.current <= 0 || traceRef.current[key] !== undefined) return
    const next = { ...traceRef.current, [key]: Math.max(0, timestamp - traceStartedAtRef.current) }
    traceRef.current = next
    setTrace(next)
  }

  const currentStability = (): StabilityMetrics => ({
    disconnectCount: disconnectCountRef.current,
    reconnectAttempts: reconnectAttemptsRef.current,
    maxOutputGapMs: maxOutputGapMsRef.current,
    noOutputTimeouts: noOutputTimeoutsRef.current,
  })

  const markDisconnect = () => {
    if (disconnectMarkedRef.current) return
    disconnectMarkedRef.current = true
    disconnectCountRef.current++
    markTraceOnce('disconnected')
    setStability(currentStability())
  }

  const markReconnectAttempt = () => {
    reconnectAttemptsRef.current++
    setStability(currentStability())
  }

  const markConnectionRestored = () => {
    disconnectMarkedRef.current = false
  }

  const markOutputActivity = () => {
    const now = performance.now()
    if (lastOutputAtRef.current > 0) {
      const gap = Math.max(0, now - lastOutputAtRef.current)
      maxOutputGapMsRef.current = Math.max(maxOutputGapMsRef.current || 0, gap)
    }
    lastOutputAtRef.current = now
    setStability(currentStability())
  }

  const recordNoOutputTimeout = () => {
    noOutputTimeoutsRef.current++
    setStability(currentStability())
  }

  const resetForNewSession = () => {
    disconnectCountRef.current = 0
    reconnectAttemptsRef.current = 0
    maxOutputGapMsRef.current = null
    noOutputTimeoutsRef.current = 0
    lastOutputAtRef.current = 0
    disconnectMarkedRef.current = false
    setStability({ disconnectCount: 0, reconnectAttempts: 0, maxOutputGapMs: null, noOutputTimeouts: 0 })
    traceStartedAtRef.current = performance.now()
    traceRef.current = { requestStarted: 0 }
    setTrace(traceRef.current)
  }

  return {
    trace,
    stability,
    traceRef,
    traceStartedAtRef,
    disconnectCountRef,
    reconnectAttemptsRef,
    maxOutputGapMsRef,
    noOutputTimeoutsRef,
    markTrace,
    markTraceOnce,
    markTraceAt,
    markDisconnect,
    markReconnectAttempt,
    markConnectionRestored,
    markOutputActivity,
    recordNoOutputTimeout,
    resetForNewSession,
  }
}
