import { consumerFetch } from '@simultrans/ui-shared/src/lib/consumerSession'
import { validMeetingCode } from '@simultrans/core/meeting'
import type { ConsumerFetcher } from './consumerHistory'

/** Eligibility is issued only by the server from a successful voluntary leave. */
export type RejoinableMeeting = { id: string; code: string; createdAt?: string; expiresAt: string; targetLanguage?: string }
export const REJOINABLE_MEETINGS_PATH = '/api/consumer/meetings/rejoinable'
export const REJOINABLE_CHECK_FAILED = '暂时无法确认会议状态，请稍后重试'
export const REJOINABLE_MEETING_GONE = '会议已结束或无法重新加入'

export function validRejoinableMeetings(body: unknown, now = Date.now()): RejoinableMeeting[] {
  const values = body && typeof body === 'object' && 'meetings' in body ? body.meetings : undefined
  if (!Array.isArray(values)) return []
  const result = new Map<string, RejoinableMeeting>()
  for (const value of values) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
      || typeof value.code !== 'string' || !validMeetingCode(value.code) || !/^\d{9}$/.test(value.code)
      || typeof value.expiresAt !== 'string' || !(Date.parse(value.expiresAt) > now)) continue
    result.set(value.id, {
      id: value.id, code: value.code, expiresAt: value.expiresAt,
      ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
      ...(typeof value.targetLanguage === 'string' ? { targetLanguage: value.targetLanguage } : {}),
    })
  }
  return [...result.values()]
}

export async function loadRejoinableMeetings(fetcher: ConsumerFetcher = consumerFetch, signal?: AbortSignal): Promise<RejoinableMeeting[]> {
  const response = await fetcher(REJOINABLE_MEETINGS_PATH, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(REJOINABLE_CHECK_FAILED)
  return validRejoinableMeetings(await response.json())
}
