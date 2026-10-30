// Change record (2026-08-05): provide one Bad Case submission contract for
// both active realtime sessions and completed local/shared history records.
// Extend the contract with span annotations (kind + span anchor on requests
// and report entries) plus list/delete endpoints for report echo-back.
import { apiFetch } from './apiFetch'
import type { HistoryEntry } from '../types/history'

export type BadCaseKind = 'bad_case' | 'note'

export type BadCaseSpanPanel = 'source_stream' | 'translation_stream' | 'source_timed' | 'translation_timed'

export const spanPanelDisplayNames: Record<BadCaseSpanPanel, string> = {
  source_stream: '连续流式原文',
  translation_stream: '连续流式译文',
  source_timed: '原文音频时间戳',
  translation_timed: '译文音频时间戳',
}

export type BadCaseSpan = {
  panel: BadCaseSpanPanel
  segmentId?: string
  charStart: number
  charEnd: number
  quote: string
  prefix?: string
  suffix?: string
}

export type BadCaseRequest = {
  sessionId: string
  traceId?: string
  requestId?: string
  logId?: string
  kind?: BadCaseKind
  span?: BadCaseSpan
  category?: string
  subcategory?: string
  severity?: string
  comment?: string
  correction?: string
  reporter?: string
  phase?: string
  provider?: string
  transport?: string
  model?: string
  sourceLanguage?: string
  targetLanguage?: string
  history?: unknown
}

export type FeedbackContext = {
  unitId?: string
  sourceText?: string
  translationText?: string
  targetLanguage?: string
  side?: string
  startMs?: number
}

export type BadCaseReport = {
  context?: FeedbackContext
  id?: string
  reportedAt: string
  category: string
  subcategory?: string
  severity?: string
  comment?: string
  correction?: string
  reporter?: string
  phase?: string
  kind?: BadCaseKind
  span?: BadCaseSpan
}

export type BadCaseRecord = {
  id: string
  sessionId: string
  traceId?: string
  requestId?: string
  logId?: string
  status: 'pending' | 'finalized'
  artifactStatus: 'not_found' | 'copied' | 'partial'
  copiedFiles?: string[]
  createdAt?: string
  updatedAt?: string
  provider?: string
  transport?: string
  model?: string
  sourceLanguage?: string
  targetLanguage?: string
  reports: BadCaseReport[]
}

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return new Error(payload?.error || fallback)
}

export async function submitBadCase(request: BadCaseRequest): Promise<BadCaseRecord> {
  const response = await apiFetch('/api/bad-cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case 保存失败')
  return await response.json() as BadCaseRecord
}

export async function listBadCases(sessionId: string): Promise<BadCaseRecord[]> {
  const response = await apiFetch(`/api/bad-cases?sessionId=${encodeURIComponent(sessionId)}`)
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case 列表读取失败')
  const payload = await response.json() as { cases?: BadCaseRecord[] }
  return payload.cases ?? []
}

export async function findHistorySession(sessionId: string): Promise<HistoryEntry | null> {
  const response = await apiFetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`)
  if (!response.ok) throw await errorFromResponse(response, '共享历史读取失败')
  const payload = await response.json() as { items?: HistoryEntry[] }
  return payload.items?.[0] ?? null
}

export type BadCaseSessionSummary = {
  sessionId: string
  caseId: string
  traceId?: string
  requestId?: string
  logId?: string
  createdAt: string
  updatedAt: string
  status: string
  provider?: string
  transport?: string
  model?: string
  sourceLanguage?: string
  targetLanguage?: string
  artifactStatus: string
  reportCount: number
  categories: string[]
  reports?: BadCaseReport[]
  latestReport?: BadCaseReport
}

export function badCaseArtifactUrl(sessionId: string, name: string): string {
  const encodedName = name.split('/').map(encodeURIComponent).join('/')
  return `/api/bad-cases/${encodeURIComponent(sessionId)}/artifacts/${encodedName}`
}

export async function fetchBadCaseArtifact(sessionId: string, name: string): Promise<string> {
  const response = await apiFetch(badCaseArtifactUrl(sessionId, name))
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case 证据读取失败')
  return await response.text()
}

// listBadCaseSessions returns every session that carries a Bad Case, so the
// history view can filter records without probing each session individually.
export async function listBadCaseSessions(limit = 500, order: 'updated' | 'comment' = 'updated'): Promise<BadCaseSessionSummary[]> {
  const response = await apiFetch(`/api/bad-cases/sessions?limit=${limit}${order === 'comment' ? '&order=comment' : ''}`)
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case 会话列表读取失败')
  const payload = await response.json() as { sessions?: BadCaseSessionSummary[] }
  return payload.sessions ?? []
}

export async function deleteBadCaseReport(sessionId: string, reportId: string): Promise<void> {
  const response = await apiFetch(
    `/api/bad-cases/reports?sessionId=${encodeURIComponent(sessionId)}&reportId=${encodeURIComponent(reportId)}`,
    { method: 'DELETE' },
  )
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case comment 删除失败')
}

export async function updateBadCaseReportSpan(sessionId: string, reportId: string, span: BadCaseSpan): Promise<BadCaseRecord> {
  const response = await apiFetch('/api/bad-cases/reports', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, reportId, span }),
  })
  if (!response.ok) throw await errorFromResponse(response, 'Bad Case 译文关联失败')
  return await response.json() as BadCaseRecord
}
