import { trackProduct } from '@simultrans/ui-shared/src/lib/productAnalytics'
import { apiFetch } from '@simultrans/ui-shared/src/lib/apiFetch'
// Change record (2026-08-31): sentence-level feedback for the portrait
// multilingual showcase (production consumer web). The ThumbIcon /
// FeedbackButtons / useSentenceFeedback trio is ported from
// apps/web/src/LivePage.tsx:88-161, recolored for the showcase palette and
// pointed at the anonymous web endpoint POST /api/feedback/web. A thumbs-down
// additionally opens a slimmed-down anchored popover (shape borrowed from
// SpanAnnotationDialog) asking for a category chip and an optional comment.
// Submission is optimistic: the highlight applies immediately, rolls back on
// failure with a non-blocking inline notice, and never interrupts the session.
//
// Update (2026-08-31, consumer channel): with a consumer login present the
// default post routes to the authenticated endpoints — the per-sentence rating
// goes to POST /api/consumer/feedback and a submitted thumbs-down additionally
// files POST /api/consumer/feedback/cases (shapes mirror
// mobile/src/api/consumer.ts submitFeedback / submitFeedbackCase). The
// anonymous /api/feedback/web path stays as the logged-out fallback — the
// showcase is gated behind login so it should be unreachable, but the
// component must stay robust either way.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { feedbackClientKey, feedbackWireUnitId } from '@simultrans/core/feedbackKey'
import type { FeedbackContext } from '@simultrans/ui-shared/src/lib/badCaseApi'
import { consumerFetch, isLoggedIn } from '@simultrans/ui-shared/src/lib/consumerSession'

export type WebFeedbackRating = 'up' | 'down'
export type WebFeedbackCategory = 'translation' | 'asr' | 'audio' | 'other'

export type WebFeedbackPayload = {
  context?: FeedbackContext
  sessionId: string
  unitId: string
  rating: WebFeedbackRating
  category?: WebFeedbackCategory
  comment?: string
}

export const webFeedbackCategories: ReadonlyArray<readonly [WebFeedbackCategory, string]> = [
  ['translation', '译文不准'],
  ['asr', '识别错误'],
  ['audio', '声音问题'],
  ['other', '其他'],
]

const COMMENT_MAX = 200
const EDGE_MARGIN = 12

class FeedbackSubmissionError extends Error {
  constructor(message: string, readonly saved: boolean, readonly status: number) {
    super(message)
  }
}

async function checkFeedbackResponse(response: Response, fallback: string, ratingSaved = false): Promise<void> {
  if (response.ok && response.status !== 202) return
  const body = await response.json().catch(() => ({})) as { code?: string }
  if (body.code === 'bad_case_pending' || body.code === 'bad_case_sync_failed') {
    throw new FeedbackSubmissionError('反馈已保存，Bad Case 资料待同步，无需重复提交。', true, response.status)
  }
  if (response.status === 429) {
    throw new FeedbackSubmissionError(ratingSaved
      ? '评分已保存；详细反馈已达到提交上限，请稍后重试。'
      : '反馈提交过于频繁，请稍后重试。', ratingSaved, response.status)
  }
  throw new FeedbackSubmissionError(ratingSaved
    ? '评分已保存，详细反馈提交未确认，请重试。'
    : fallback, ratingSaved, response.status)
}

// SSR (renderToStaticMarkup in tests) has no document — fall back to inline
// rendering there; browsers always portal so the popover escapes the
// scroll-clipped transcript container.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export async function postWebFeedback(payload: WebFeedbackPayload): Promise<void> {
  const wirePayload = { ...payload, unitId: feedbackWireUnitId(payload.unitId), clientKey: makeWebFeedbackClientKey(payload) }
  const response = await apiFetch('/api/feedback/web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wirePayload),
  })
  await checkFeedbackResponse(response, `web_feedback_${response.status}`)
}

/**
 * Keep UI-only composite row ids out of the backend feedback identifier
 * contract. 实现下沉到 `@simultrans/core/feedbackKey`（feedback-05）——移动端
 * 的行 id 同样会超过后端的 128 字节上限，规则必须只有一份。这里保留导出，
 * 调用方（含本文件的测试）不用改 import。
 */
export { feedbackWireUnitId }

/** 幂等 clientKey（≤64，对照移动端 makeFeedbackClientKey，前缀区分 web 端）。 */
function makeWebFeedbackClientKey(payload: WebFeedbackPayload): string {
  return feedbackClientKey('web-v2', payload.context ? { ...payload, unitId: `${payload.unitId}:${JSON.stringify(payload.context)}` } : payload)
}

/**
 * 登录态的认证反馈：逐句评分走 POST /api/consumer/feedback；已提交的点踩
 * 再补一条 POST /api/consumer/feedback/cases 工单，无分类时使用 other，
 * 供后台归入 Bad Case。评分已持久化后，后续工单/归集失败不得撤销评分。
 */
export async function postConsumerFeedback(
  payload: WebFeedbackPayload,
  fetcher: (path: string, init?: RequestInit) => Promise<Response> = consumerFetch,
): Promise<void> {
  const unitId = feedbackWireUnitId(payload.unitId)
  const ratingResponse = await fetcher('/api/consumer/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: payload.sessionId,
      unitId,
      rating: payload.rating,
      sourceText: payload.context?.sourceText?.slice(0, 1000),
      translationText: payload.context?.translationText?.slice(0, 1000),
    }),
  })
  await checkFeedbackResponse(ratingResponse, `consumer_feedback_${ratingResponse.status}`)
  if (payload.rating !== 'down') return
  const categoryLabel = webFeedbackCategories.find(([value]) => value === payload.category)?.[1]
  const caseResponse = await fetcher('/api/consumer/feedback/cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: payload.sessionId,
      unitId,
      category: payload.category || 'other',
      comment: payload.comment?.trim() || categoryLabel || '用户点踩（未填写原因）',
      rating: payload.rating,
      appVersion: '',
      os: 'web',
      context: payload.context,
      clientKey: makeWebFeedbackClientKey(payload),
    }),
  }).catch(() => { throw new FeedbackSubmissionError('评分已保存，详细反馈提交未确认，请重试。', true, 0) })
  await checkFeedbackResponse(caseResponse, `consumer_feedback_case_${caseResponse.status}`, true)
}

/**
 * 默认发送路径：登录态且会话是本人签发的 consumer 会话（cs-* 前缀，对照
 * backend/server/consumer_ws.go isConsumerSessionID）才走认证端点——认证端点
 * 只接受签发注册表里的会话，eval 裸通道（/ui-showcase 免登录演示）的 ws-*
 * 会话即使浏览器里恰好有 consumer token 也会被 404。其余情况一律兜底匿名
 * /api/feedback/web，与历史行为一致。
 */
export async function postSentenceFeedback(payload: WebFeedbackPayload): Promise<void> {
  if (isLoggedIn() && payload.sessionId.startsWith('cs-')) {
    try {
      return await postConsumerFeedback(payload)
    } catch (error) {
      // Never turn partial success into a second case or bypass rate limits.
      if (error instanceof FeedbackSubmissionError && (error.saved || error.status === 429)) throw error
      // A finished session can outlive the authenticated session registry or
      // its feedback store. Preserve the user's rating through the existing
      // anonymous web channel instead of rolling the UI back immediately.
      return postWebFeedback(payload)
    }
  }
  return postWebFeedback(payload)
}

type RatingMap = Record<string, WebFeedbackRating>

export type SentenceFeedbackEnv = {
  sessionId: string
  /** Snapshot of the rating map at click time (used for default rollback). */
  ratings: RatingMap
  /** Per-unit latest request sequence; a new session swaps the bucket object. */
  seqRef: { current: Record<string, number> }
  setRatings: (updater: (current: RatingMap) => RatingMap) => void
  onNotice: (message: string) => void
  post?: (payload: WebFeedbackPayload) => Promise<unknown>
}

export type SentenceFeedbackRequest = {
  context?: FeedbackContext
  unitId: string
  rating: WebFeedbackRating
  category?: WebFeedbackCategory
  comment?: string
  /**
   * Rating to restore if the POST fails. `null` means "no rating".
   * Defaults to the current map value — pass it explicitly when the optimistic
   * highlight was applied earlier (e.g. while the down-reason popover was open).
   */
  rollbackTo?: WebFeedbackRating | null
}

// Core of the optimistic submit, framework-free so vitest can drive it without
// a DOM: highlight now, POST in the background, roll back only when the failed
// request is still the unit's latest one and the session has not changed.
export function sendSentenceFeedback(env: SentenceFeedbackEnv, request: SentenceFeedbackRequest): Promise<void> {
  const { sessionId, seqRef, setRatings, onNotice } = env
  if (!sessionId) return Promise.resolve()
  const post = env.post || postSentenceFeedback
  const { unitId, rating } = request
  const previous = request.rollbackTo !== undefined ? request.rollbackTo : env.ratings[unitId] ?? null
  const bucket = seqRef.current
  const sequence = (bucket[unitId] || 0) + 1
  bucket[unitId] = sequence
  setRatings((current) => ({ ...current, [unitId]: rating }))
  const payload: WebFeedbackPayload = { sessionId, unitId, rating, ...(request.context ? { context: request.context } : {}) }
  if (request.category) payload.category = request.category
  const comment = request.comment?.trim().slice(0, 2000)
  if (comment) payload.comment = comment
  return post(payload).then(() => { trackProduct('feedback_submitted', { sessionId, result: 'success', reason: request.category || 'rating' }) }).catch((error: unknown) => {
    trackProduct('feedback_submitted', { sessionId, result: 'failure', reason: request.category || 'rating' })
    if (bucket !== seqRef.current || bucket[unitId] !== sequence) return
    if (error instanceof FeedbackSubmissionError && error.saved) {
      onNotice(error.message)
      return
    }
    setRatings((current) => {
      const next = { ...current }
      if (previous === null) delete next[unitId]
      else next[unitId] = previous
      return next
    })
    onNotice(error instanceof FeedbackSubmissionError && error.status === 429 ? error.message : '反馈发送失败，已撤销标记')
  })
}

export type SentenceFeedbackHandle = {
  sessionId: string
  ratings: RatingMap
  notice: { unitId: string; message: string } | null
  send: (request: SentenceFeedbackRequest) => Promise<void>
  /** Local-only highlight (pending thumbs-down while the popover is open). */
  mark: (unitId: string, rating: WebFeedbackRating) => void
  /** Local-only restore (popover dismissed, or toggling a highlight off). */
  restore: (unitId: string, previous?: WebFeedbackRating) => void
}

// Sentence feedback state: instant local highlight + background archiving.
// A sessionId change (new session) clears everything; in-flight requests of
// the old session are isolated by swapping the sequence bucket object.
export function useSentenceFeedback(sessionId: string): SentenceFeedbackHandle {
  const [ratings, setRatings] = useState<RatingMap>({})
  const [notice, setNotice] = useState<{ unitId: string; message: string } | null>(null)
  const seqRef = useRef<Record<string, number>>({})
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setRatings({})
    setNotice(null)
    seqRef.current = {}
  }, [sessionId])

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const showNotice = useCallback((unitId: string, message: string) => {
    setNotice({ unitId, message })
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2600)
  }, [])

  const send = useCallback((request: SentenceFeedbackRequest) => sendSentenceFeedback({
    sessionId,
    ratings,
    seqRef,
    setRatings,
    onNotice: (message) => showNotice(request.unitId, message),
  }, request), [ratings, sessionId, showNotice])

  const mark = useCallback((unitId: string, rating: WebFeedbackRating) => {
    setRatings((current) => ({ ...current, [unitId]: rating }))
  }, [])

  const restore = useCallback((unitId: string, previous?: WebFeedbackRating) => {
    setRatings((current) => {
      const next = { ...current }
      if (previous === undefined) delete next[unitId]
      else next[unitId] = previous
      return next
    })
  }, [])

  return { sessionId, ratings, notice, send, mark, restore }
}

// Figma「*2-Help Positive/Negative」16px 图标（有效帮助 / 无效帮助），用 currentColor 跟随状态着色。
// Figma 569:7261「多段」结束页：图标 16px，未评价用线框（*2-Help Positive/Nagative 有效帮助），
// 已选用实心（-Fill）；hover 显示 20×20、圆角 2 的 #f1f5f2 底 + 实心；未选保持线框。
// 四个 SVG 放在 public/showcase/thumb-*.svg，通过 CSS mask 着色（颜色统一 #040f24 55%）。
function ThumbIcon({ down }: { down?: boolean }) {
  return <span className={`sentence-feedback-thumb-icon ${down ? 'is-down' : 'is-up'}`} aria-hidden="true" />
}

export function FeedbackButtons({ rating, onRate }: {
  rating?: WebFeedbackRating
  onRate: (rating: WebFeedbackRating, target: HTMLElement) => void
}) {
  return (
    <span className="sentence-feedback-buttons">
      <button type="button" className={rating === 'up' ? 'sentence-feedback-thumb up is-active' : 'sentence-feedback-thumb up'}
        aria-pressed={rating === 'up'} aria-label="翻译准确，点赞" title="翻译准确"
        onClick={(event) => onRate('up', event.currentTarget)}>
        <ThumbIcon />
      </button>
      <button type="button" className={rating === 'down' ? 'sentence-feedback-thumb down is-active' : 'sentence-feedback-thumb down'}
        aria-pressed={rating === 'down'} aria-label="翻译有误，点踩" title="翻译有误"
        onClick={(event) => onRate('down', event.currentTarget)}>
        <ThumbIcon down />
      </button>
    </span>
  )
}

export type SentenceFeedbackAnchor = { top: number; left: number; width: number; height: number }

// Slimmed-down anchored popover in the SpanAnnotationDialog shape: category
// chips + an optional ≤200-char comment + submit/skip. Submit needs a chosen
// category; skip archives a bare thumbs-down; an outside click or Escape
// dismisses without sending and the caller rolls the highlight back.
export function SentenceFeedbackReasonPopover({ anchor, onSubmit, onSkip, onDismiss }: {
  anchor: SentenceFeedbackAnchor
  onSubmit: (category: WebFeedbackCategory, comment: string) => void
  onSkip: () => void
  onDismiss: () => void
}) {
  const [category, setCategory] = useState<WebFeedbackCategory | ''>('')
  const [comment, setComment] = useState('')
  const [pos, setPos] = useState({ top: anchor.top + anchor.height + 8, left: anchor.left })
  const popRef = useRef<HTMLElement | null>(null)

  // Place the popover under the thumb, then nudge it back inside the viewport
  // (flip above when there is no room below).
  useIsomorphicLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    const minLeft = window.scrollX + EDGE_MARGIN
    const maxLeft = window.scrollX + window.innerWidth - width - EDGE_MARGIN
    const left = Math.min(Math.max(anchor.left, minLeft), Math.max(minLeft, maxLeft))
    const below = anchor.top + anchor.height + 8
    const viewportBottom = window.scrollY + window.innerHeight - EDGE_MARGIN
    let top = below
    if (below + height > viewportBottom) {
      const above = anchor.top - height - 8
      top = above > window.scrollY + EDGE_MARGIN ? above : Math.max(window.scrollY + EDGE_MARGIN, viewportBottom - height)
    }
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const onDocPointerDown = (event: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [onDismiss])

  const content = (
    <section
      ref={popRef}
      tabIndex={-1}
      className="sentence-feedback-pop"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="反馈问题原因"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
    >
      <strong className="sentence-feedback-pop__title">哪里不对？</strong>
      <div className="sentence-feedback-pop__chips" role="radiogroup" aria-label="问题分类">
        {webFeedbackCategories.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={category === value}
            className={category === value ? 'is-active' : ''}
            onClick={() => setCategory((current) => current === value ? '' : value)}
          >{label}</button>
        ))}
      </div>
      <div className="sentence-feedback-pop__textwrap">
        <textarea
          value={comment}
          maxLength={COMMENT_MAX}
          rows={2}
          placeholder="补充说明（选填）"
          onChange={(event) => setComment(event.target.value)}
        />
        <span className="sentence-feedback-pop__charcount">{comment.length}/{COMMENT_MAX}</span>
      </div>
      <div className="sentence-feedback-pop__actions">
        <button type="button" className="sentence-feedback-pop__skip" onClick={onSkip}>跳过</button>
        <button
          type="button"
          className="sentence-feedback-pop__submit"
          disabled={!category}
          onClick={() => { if (category) onSubmit(category, comment) }}
        >提交</button>
      </div>
    </section>
  )
  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}

type PendingDown = { anchor: SentenceFeedbackAnchor; previous?: WebFeedbackRating; context?: FeedbackContext }

// One feedback bar per transcript row/bubble. Lives OUTSIDE the
// ShowcaseTranslationList rows (which are <button> elements themselves) so no
// button ever nests inside another. Hidden until the session has an id.
export function SentenceFeedback(_props: { unitId: string; feedback: SentenceFeedbackHandle; context?: FeedbackContext }) { return null }
