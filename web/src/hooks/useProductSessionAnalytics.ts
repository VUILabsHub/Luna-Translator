import { useEffect, type RefObject } from 'react'
import { trackProduct, type AnalyticsFields } from '@simultrans/ui-shared/src/lib/productAnalytics'
import type { MultilingualOutput } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
export type ProductAttempt = { fields: AnalyticsFields; startedAt: number }
type Session = { status: string; parentSessionID: string; traceId: string; analyticsAttemptId?: string; outputs: Record<string, MultilingualOutput> }
// Effects run after React commits the transcript. Only committed text is a
// displayed translation; receiving a provider frame alone is not activation.
export function useProductSessionAnalytics(attemptRef: RefObject<ProductAttempt | null>, sessions: Session[], hasTranslation: boolean) {
  useEffect(() => {
    const attempt = attemptRef.current
    if (!attempt?.fields.attemptId || sessions.some(s => s.analyticsAttemptId !== attempt.fields.attemptId)) return
    const fields = { ...attempt.fields, sessionId: sessions[0].parentSessionID, traceId: sessions[0].traceId }
    const once = (name: Parameters<typeof trackProduct>[0], extra: AnalyticsFields = {}) => trackProduct(name, { ...fields, ...extra }, `${attempt.fields.attemptId}:${name}`)
    const outputs = sessions.flatMap(s => Object.values(s.outputs))
    const connected = sessions.every(s => ['recording', 'processing', 'finished'].includes(s.status))
    if (connected) once('session_connected')
    if (connected && hasTranslation) once('first_translation_shown', { durationMs: performance.now() - attempt.startedAt })
    const received = outputs.map(o => o.firstAudioByteLatency).filter((v): v is number => v !== null)
    const played = outputs.map(o => o.firstAudioPlaybackLatency).filter((v): v is number => v !== null)
    if (received.length) once('first_audio_received', { durationMs: Math.min(...received) })
    if (played.length) once('first_audio_playback', { durationMs: Math.min(...played) })
    if (sessions.every(s => ['finished', 'error'].includes(s.status))) once('session_client_ended', { durationMs: performance.now() - attempt.startedAt, result: sessions.some(s => s.status === 'error') ? 'failure' : 'success' })
  })
}
