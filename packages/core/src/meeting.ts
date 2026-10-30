/** Meeting protocol shared by Web and native clients. RTC credentials stay in memory. */
export type MeetingLanguage = { code: string; label: string }

/**
 * 会议「降噪模式」(Canary): a per-speaker server-side loudness gate (frame_rms)
 * on the recognition/translation input (not direct human RTC audio).
 * Chosen before create/join; servers advertising
 * meetingLiveNoiseReduction also accept changes through preferences without
 * restarting capture or the model. Re-entry while still a member ignores its
 * entry level (the snapshot's `me.noiseReduction` is the level in effect;
 * show that while in a meeting).
 * Leaving and joining again is a new membership with the newly sent level.
 * Missing on entry means 'default'; missing on preferences preserves the
 * current level. Same levels/thresholds as
 * backend/server/meeting_noise.go (both checked against
 * tests/fixtures/meeting-noise-reduction.json).
 */
export type MeetingNoiseReduction = 'weak' | 'medium_weak' | 'default' | 'medium_strong' | 'strong'
/** Legacy Web/Android controls keep their existing three choices. */
export const MEETING_NOISE_REDUCTIONS: readonly MeetingNoiseReduction[] = ['weak', 'default', 'strong']
/** iOS five-position control; original levels retain their exact thresholds. */
export const MEETING_NOISE_REDUCTION_STEPS: readonly MeetingNoiseReduction[] = ['weak', 'medium_weak', 'default', 'medium_strong', 'strong']
/** frame_rms threshold (dBFS) per level: audio frames quieter than it count as silence. */
export const MEETING_NOISE_REDUCTION_THRESHOLD_DBFS: Readonly<Record<MeetingNoiseReduction, number>> = { weak: -45, medium_weak: -42, default: -40, medium_strong: -38, strong: -35 }
export function isMeetingNoiseReduction(value: unknown): value is MeetingNoiseReduction {
  return typeof value === 'string' && MEETING_NOISE_REDUCTION_STEPS.includes(value as MeetingNoiseReduction)
}
export type MeetingCapabilities = {
  enabled: boolean
  available: boolean
  /** P0 requires explicit speaker consent before joining; missing means optional. */
  voiceCloneRequired?: boolean
  /**
   * P1-3: the server stores Canary App meeting records (speaker attribution,
   * sharing refused) and its Web shows the record notice. Missing (older
   * servers) means the App must not save meeting records.
   */
  meetingRecords?: boolean
  /**
   * Meeting records get AI titles generated from their captions (Canary
   * candidate only; true only together with meetingRecords). Clients then add
   * 「记录标题由 AI 根据字幕自动生成。」 to the record notice. Missing means the
   * fixed meeting title.
   */
  meetingAiTitles?: boolean
  /**
   * The server accepts `noiseReduction` on create/join. Missing (older
   * servers, or a cluster still running an older worker) means the field must
   * not be sent: they reject unknown fields.
   */
  meetingNoiseReduction?: boolean
  /** Missing on older servers means only weak/default/strong are accepted. */
  meetingNoiseReductionLevels?: readonly MeetingNoiseReduction[]
  /** Preferences accepts noiseReduction with the member's expectedVersion.
   * Missing means only entry-time selection is supported. A successful snapshot
   * reports the level applied to subsequent speaker PCM; routes do not restart. */
  meetingLiveNoiseReduction?: boolean
  reason?: string
  languages: MeetingLanguage[]
  maxMembers: number
  expiresInSeconds: number
}
export type MeetingMember = {
  guest?: boolean
  id: string
  displayName: string
  /** Server-issued revocable avatar URL; guests and unset profiles omit it. */
  avatarUrl?: string
  sourceLanguage: string
  /** Original-caption recognition is reconnecting; translation/audio may continue. */
  sourceASRUnavailable?: boolean
  targetLanguage: string
  /** Only this speaker's explicit opt-in allows others to hear their audio. */
  voiceClone?: boolean
  /**
   * This membership's noise-reduction level as the server applies it. Only
   * sent for the viewer (`me` and their own `members` row); missing for other
   * members and on older servers.
   */
  noiseReduction?: MeetingNoiseReduction
  rtcUid: string
  version: number
  joinedAt: string
  targetChangedAt?: string
}
export type MeetingRoute = {
  id: string
  speakerId: string
  sourceLanguage: string
  targetLanguage: string
  rtcUid: string
  epoch: number
  status: 'ready' | 'unavailable'
  kind: 'original' | 'translation'
  /** Missing on older snapshots is treated as disabled. */
  audioEnabled?: boolean
}
export type MeetingTranscript = {
  id: string
  speakerId: string
  speakerName: string
  sourceLanguage: string
  targetLanguage: string
  sourceText: string
  text: string
  isFinal: boolean
  revision: number
  createdAt: string
  /** Source captions returned only to their speaker; never an audio route. */
  speakerOnly?: boolean
  /** Utterance-local incremental display; not a second TTS segment. */
  preview?: boolean
}
export type MeetingSnapshot = {
  idleCloseAt?: string
  id: string
  code: string
  hostMemberId: string
  status: 'active' | 'ended'
  revision: number
  expiresAt: string
  /** When the meeting was created. Optional: the current server snapshot does
   * not send it yet; clients fall back to member joinedAt. Never derive the
   * start from expiresAt (renewal moves it). */
  createdAt?: string
  me: MeetingMember
  members: MeetingMember[]
  routes: MeetingRoute[]
  transcripts: MeetingTranscript[]
  /** Optional channel so older clients never duplicate previews and TTS text. */
  previews?: MeetingTranscript[]
  mediaStatus: 'ready' | 'unavailable'
  /** The room policy is authoritative, including after reconnecting. */
  voiceCloneRequired?: boolean
}
export type MeetingJoin = {
  meeting: MeetingSnapshot
  memberId: string
  rtc: { appId: string; roomId: string; userId: string; token: string; expiresAt: string }
  eventTicket: string
}
/** `noiseReduction` (account and guest create/join): missing means 'default'; other values are rejected with 400 invalid_request. */
export type MeetingEntry = { displayName: string; sourceLanguage: string; targetLanguage: string; voiceClone?: boolean; noiseReduction?: MeetingNoiseReduction }
export type MeetingPreferences = { sourceLanguage: string; targetLanguage: string; expectedVersion: number; voiceClone?: boolean; noiseReduction?: MeetingNoiseReduction }
export type MeetingRequest = (path: string, init?: RequestInit) => Promise<Response>

export class MeetingAPIError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly conflictToken?: string) { super(message); this.name = 'MeetingAPIError' }
}

export function normalizeMeetingCode(value: string): string {
  return value.replace(/[\s-]/g, '')
}
export function formatMeetingCode(value: string): string {
  return normalizeMeetingCode(value).replace(/(\d{3})(?=\d)/g, '$1 ')
}
export function validMeetingCode(value: string): boolean {
  return /^\d{9}$/.test(normalizeMeetingCode(value))
}

const meetingTime = (value?: string): number | undefined => {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

/**
 * When the meeting started, in epoch ms; undefined when the snapshot carries no
 * usable time. The room timer on Web and the App both count from this:
 * 1. snapshot.createdAt, the real creation time (optional; picked up as soon
 *    as the server sends it).
 * 2. Otherwise the earliest joinedAt among the members and me. The creator
 *    joins at creation and every joinedAt is at or after it, so the earliest
 *    one is the closest, also after a host transfer. `me` only matters for a
 *    snapshot whose member list is missing my row.
 * Never expiresAt − expiresInSeconds: renewal moves expiresAt.
 */
export function meetingStartTime(snapshot: Pick<MeetingSnapshot, 'createdAt' | 'members' | 'me'>): number | undefined {
  const created = meetingTime(snapshot.createdAt)
  if (created !== undefined) return created
  const joined = [...(snapshot.members || []), snapshot.me]
    .map(member => meetingTime(member?.joinedAt))
    .filter((time): time is number => time !== undefined)
  return joined.length ? Math.min(...joined) : undefined
}

/**
 * Meeting duration as HH:MM:SS ("00:36:36"), the same clock text the App uses.
 * A start later than `now` (server clock ahead) or an invalid time counts as 0.
 */
export function meetingElapsedText(startedAt: number, now: number): string {
  const elapsed = Math.floor((now - startedAt) / 1000)
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
}

/** Use only server-issued mappings; RTC user names/prefixes are not proof of membership. */
export function selectMeetingAudio(snapshot: MeetingSnapshot): MeetingRoute[] {
  if (snapshot.status !== 'active') return []
  const members = new Map(snapshot.members.map(member => [member.id, member]))
  const selected = new Map<string, MeetingRoute>()
  for (const route of snapshot.routes) {
    const speaker = members.get(route.speakerId)
    if (!speaker || speaker.voiceClone !== true || route.audioEnabled !== true
      || speaker.id === snapshot.me.id || route.rtcUid === snapshot.me.rtcUid
      || route.status !== 'ready' || route.targetLanguage !== snapshot.me.targetLanguage) continue
    const sameLanguage = speaker.sourceLanguage === snapshot.me.targetLanguage
    if (sameLanguage !== (route.kind === 'original')) continue
    if (route.kind === 'original' && route.rtcUid !== speaker.rtcUid) continue
    const previous = selected.get(speaker.id)
    if (!previous || route.epoch > previous.epoch) selected.set(speaker.id, route)
  }
  return [...selected.values()]
}

export function captionsForMeeting(snapshot: MeetingSnapshot): MeetingTranscript[] {
  const visible = [...snapshot.transcripts, ...(snapshot.previews || [])].filter(row => row.speakerId === snapshot.me.id
    ? row.speakerOnly === true && row.sourceLanguage === row.targetLanguage
    : row.speakerOnly !== true && row.targetLanguage === snapshot.me.targetLanguage)
  return snapshot.previews?.length ? visible.sort((a, b) => {
      const left = Date.parse(a.createdAt), right = Date.parse(b.createdAt)
      return Number.isFinite(left) && Number.isFinite(right) ? left - right : 0
    }) : visible
}

/** Present contiguous translated fragments of one server utterance together.
 * The server identity is route/epoch/utterance/segment. Keep raw history intact;
 * never merge separate utterances, languages, or intervening speakers. */
export function meetingCaptionsForDisplay(rows: readonly MeetingTranscript[]): MeetingTranscript[] {
  const groupFor = (row: MeetingTranscript): string | undefined => {
    const boundary = row.id.lastIndexOf('/')
    const utterance = boundary > 0 ? row.id.slice(0, boundary) : ''
    return !row.speakerOnly && row.sourceLanguage !== row.targetLanguage && /^.+\/\d+\/.+$/.test(utterance)
      ? JSON.stringify([utterance, row.speakerId, row.sourceLanguage, row.targetLanguage]) : undefined
  }
  const previews = new Map<string, MeetingTranscript>()
  const confirmed = new Map<string, MeetingTranscript[]>()
  for (const row of rows) {
    const group = groupFor(row)
    if (!group) continue
    if (row.preview) {
      if (!previews.has(group) || row.revision >= previews.get(group)!.revision) previews.set(group, row)
    } else {
      if (!confirmed.has(group)) confirmed.set(group, [])
      confirmed.get(group)!.push(row)
    }
  }
  const displayedPreviews = new Set<string>()
  const result: MeetingTranscript[] = []
  let previousGroup: string | undefined
  let sourceRevision = -1
  for (const row of rows) {
    const group = groupFor(row)
    const preview = group ? previews.get(group) : undefined
    if (group && preview?.text.trim()) {
      if (displayedPreviews.has(group)) continue
      displayedPreviews.add(group)
      const segments = confirmed.get(group) || []
      const separator = /^(zh|ja)(-|$)/.test(row.targetLanguage) ? '' : ' '
      const committedText = segments.map(segment => segment.text.trim()).filter(Boolean).join(separator)
      // A committed segment can arrive ahead of the next model snapshot. Never
      // regress that extension; otherwise the utterance-local model is display authority.
      const committedExtendsPreview = committedText.startsWith(preview.text.trim()) && committedText.length > preview.text.trim().length
      const source = [preview, ...segments].reduce((a, b) => b.revision > a.revision ? b : a)
      result.push({ ...preview, sourceText: source.sourceText,
        text: committedExtendsPreview ? committedText : preview.text,
        isFinal: committedExtendsPreview ? segments.every(segment => segment.isFinal) : preview.isFinal })
      previousGroup = undefined
      continue
    }
    // An empty preview retracts a previously unproven boundary. Keep the
    // confirmed segment history, without an empty/duplicate caption card.
    if (row.preview) continue
    const previous = result[result.length - 1]
    if (group && previous && group === previousGroup) {
      const separator = /^(zh|ja)(-|$)/.test(row.targetLanguage) ? '' : ' '
      previous.text = [previous.text.trim(), row.text.trim()].filter(Boolean).join(separator)
      previous.isFinal = previous.isFinal && row.isFinal
      previous.revision = Math.max(previous.revision, row.revision)
      if (row.revision >= sourceRevision) {
        previous.sourceText = row.sourceText
        sourceRevision = row.revision
      }
    } else {
      result.push({ ...row })
      sourceRevision = row.revision
    }
    previousGroup = group
  }
  carryBoundaryPunctuation(result)
  return result
}

/** Sentence/clause punctuation a translation row can start with when it was cut
 * at the speech boundary just before the model emitted the previous clause's
 * closing mark (". What are you saying?", "? I really don't know."). */
const LEADING_BOUNDARY_PUNCTUATION = /^[\s.,!?;:。，、！？；：…]*[.,!?;:。，、！？；：…][\s.,!?;:。，、！？；：…]*/u
/** Already ends in punctuation (optionally followed by closing quotes/brackets). */
const ENDS_WITH_PUNCTUATION = /[.,!?;:。，、！？；：…]["'”’)）\]」』]*$/u

/** The simultaneous model's output does not end exactly at the speech
 * boundary: a closing punctuation mark that belongs to one utterance can open
 * the next utterance's row. Display-only: move such a leading mark to the
 * previous row of the same speaker and language pair (when that row has no
 * closing punctuation of its own), otherwise drop it. Only punctuation moves —
 * words never cross the utterance boundary (realtime-text-sync R3). */
function carryBoundaryPunctuation(rows: MeetingTranscript[]): void {
  const previousByRoute = new Map<string, MeetingTranscript>()
  for (const row of rows) {
    if (row.speakerOnly || row.sourceLanguage === row.targetLanguage) continue
    const route = JSON.stringify([row.speakerId, row.sourceLanguage, row.targetLanguage])
    const previous = previousByRoute.get(route)
    const lead = LEADING_BOUNDARY_PUNCTUATION.exec(row.text)
    // A row that is only punctuation so far (a draft's first token) stays as is.
    if (lead && row.text.slice(lead[0].length).trim()) {
      row.text = row.text.slice(lead[0].length)
      const mark = lead[0].replace(/\s+/gu, '')
      const before = previous?.text.trimEnd()
      if (previous && before && !ENDS_WITH_PUNCTUATION.test(before)) previous.text = before + mark
    }
    previousByRoute.set(route, row)
  }
}

/** A final caption is not reopened by a late draft, except the speaker's own
 * caption: the server keeps one own-caption row per utterance, and a further
 * ASR item of that utterance strictly extends text already finalized. */
function ownCaptionExtends(previous: MeetingTranscript, row: MeetingTranscript): boolean {
  const before = previous.text.trim(), next = row.text.trim()
  return previous.speakerOnly === true && row.speakerOnly === true && before !== '' && next.length > before.length && next.startsWith(before)
}

/** Keeps captions already read in their original language across a personal language change.
 * `limit` caps the retained rows (oldest evicted first). The live caption view
 * keeps the default 300; a client that archives a whole attendance (the mobile
 * meeting record) passes a larger cap. */
export class MeetingCaptionHistory {
  private rows = new Map<string, MeetingTranscript>()
  private skipped = new Set<string>()
  private language: string | undefined
  private meetingId: string | undefined
  private readonly limit: number

  constructor(options: { limit?: number } = {}) {
    const limit = options.limit
    this.limit = typeof limit === 'number' && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 300
  }

  update(snapshot: MeetingSnapshot): MeetingTranscript[] {
    if (this.meetingId !== snapshot.id) {
      this.rows.clear(); this.skipped.clear(); this.language = undefined; this.meetingId = snapshot.id
    }
    const candidates = captionsForMeeting(snapshot)
    if (this.language !== undefined && this.language !== snapshot.me.targetLanguage) {
      // Do not insert the newly selected language's historical sentences as if just spoken.
      const changedAt = Date.parse(snapshot.me.targetChangedAt || '')
      for (const row of candidates) {
        if (row.speakerId !== snapshot.me.id && row.isFinal && (!Number.isFinite(changedAt) || Date.parse(row.createdAt) < changedAt)) this.skipped.add(`${row.id}:${row.targetLanguage}`)
      }
    }
    this.language = snapshot.me.targetLanguage
    for (const row of candidates) {
      const key = `${row.id}:${row.targetLanguage}`
      if (this.skipped.has(key)) continue
      const previous = this.rows.get(key)
      if (!previous || (row.revision >= previous.revision && (!previous.isFinal || row.isFinal || (previous.preview && row.preview) || ownCaptionExtends(previous, row)))) this.rows.set(key, row)
    }
    while (this.rows.size > this.limit) this.rows.delete(this.rows.keys().next().value!)
    // Snapshots are bounded; only retain exclusions still present in the server's window.
    const keys = new Set([...snapshot.transcripts, ...(snapshot.previews || [])].map(row => `${row.id}:${row.targetLanguage}`))
    for (const key of this.skipped) if (!keys.has(key)) this.skipped.delete(key)
    return [...this.rows.values()]
  }
}

export function createMeetingAPI(request: MeetingRequest) {
  const base = '/api/consumer/meetings'
  const resource = (id: string) => `${base}/${encodeURIComponent(id)}`
  async function json<T>(path: string, method = 'GET', body?: unknown, validate?: (payload: unknown) => boolean, allowEmpty = false): Promise<T> {
    const response = await request(path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const invalid = () => new MeetingAPIError('会议服务返回的数据无效，请重试', response.status, 'invalid_meeting_response')
    let payload: unknown
    try { payload = await response.json() }
    catch { if (response.ok && !allowEmpty) throw invalid() }
    const errorBody = meetingObject(payload) ? payload : {}
    if (!response.ok) throw new MeetingAPIError(
      typeof errorBody.error === 'string' ? errorBody.error : '会议服务暂不可用，请重试', response.status,
      typeof errorBody.code === 'string' ? errorBody.code : undefined,
      typeof errorBody.conflictToken === 'string' ? errorBody.conflictToken : undefined,
    )
    if (allowEmpty) return undefined as T
    if (!meetingObject(payload) || (validate && !validate(payload))) throw invalid()
    return payload as T
  }
  return {
    capabilities: () => json<MeetingCapabilities>(`${base}/capabilities`),
    create: (input: MeetingEntry) => json<MeetingJoin>(base, 'POST', input, validMeetingJoin),
    join: (input: MeetingEntry & { code: string }) => json<MeetingJoin>(`${base}/join`, 'POST', { ...input, code: normalizeMeetingCode(input.code) }, validMeetingJoin),
    snapshot: (id: string) => json<MeetingSnapshot>(resource(id)),
    preferences: (id: string, input: MeetingPreferences) => json<MeetingSnapshot>(`${resource(id)}/preferences`, 'PATCH', input),
    renew: (id: string) => json<MeetingJoin>(`${resource(id)}/renew`, 'POST', {}, payload => validMeetingJoin(payload) && payload.meeting.id === id),
    leave: (id: string) => json<void>(`${resource(id)}/leave`, 'POST', {}, undefined, true),
    idle: (id: string, deadline: string, end: boolean) => json<MeetingSnapshot>(`${resource(id)}/idle`, 'POST', { deadline, end }),
    releaseAttendance: (token: string) => json<void>('/api/consumer/meetings/release-attendance', 'POST', { token }, undefined, true),
    end: (id: string) => json<void>(`${resource(id)}/end`, 'POST', {}, undefined, true),
    transfer: (id: string, memberId: string) => json<MeetingSnapshot>(`${resource(id)}/transfer`, 'POST', { memberId }),
  }
}
export type MeetingAPI = ReturnType<typeof createMeetingAPI>

function meetingObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function meetingString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function meetingFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return meetingObject(value) && fields.every(field => typeof value[field] === 'string')
}

/** Reject malformed admission/renewal data before callers replace working
 * credentials or touch the SDK. Never include response content in the error. */
function validMeetingJoin(value: unknown): value is MeetingJoin {
  if (!meetingObject(value) || !meetingObject(value.rtc) || !meetingObject(value.meeting)) return false
  const { rtc, meeting } = value
  if (!['appId', 'roomId', 'userId', 'token', 'expiresAt'].every(field => meetingString(rtc[field]))
    || !Number.isFinite(Date.parse(rtc.expiresAt as string))
    || !meetingString(value.memberId) || !meetingString(value.eventTicket)) return false
  if (!meetingFields(meeting, ['id', 'code', 'hostMemberId', 'expiresAt']) || !meetingString(meeting.id)
    || (meeting.status !== 'active' && meeting.status !== 'ended')
    || typeof meeting.revision !== 'number' || !Number.isFinite(meeting.revision)
    || (meeting.mediaStatus !== 'ready' && meeting.mediaStatus !== 'unavailable')) return false
  const memberFields = ['id', 'displayName', 'sourceLanguage', 'targetLanguage', 'rtcUid']
  if (!meetingFields(meeting.me, memberFields) || !meetingString(meeting.me.id)
    || meeting.me.id !== value.memberId || meeting.me.rtcUid !== rtc.userId
    || !Array.isArray(meeting.members) || !meeting.members.every(member => meetingFields(member, memberFields))
    || !Array.isArray(meeting.routes) || !meeting.routes.every(route => meetingFields(route, ['id', 'speakerId', 'sourceLanguage', 'targetLanguage', 'rtcUid', 'status', 'kind']))
    || !Array.isArray(meeting.transcripts) || !meeting.transcripts.every(row => meetingFields(row, ['id', 'speakerId', 'sourceLanguage', 'targetLanguage', 'sourceText', 'text', 'createdAt']))) return false
  if (meeting.previews !== undefined && (!Array.isArray(meeting.previews) || !meeting.previews.every(row => meetingFields(row, ['id', 'speakerId', 'sourceLanguage', 'targetLanguage', 'sourceText', 'text', 'createdAt']) && row.preview === true))) return false
  return true
}

export type MeetingTerminalCode = 'session_replaced' | 'meeting_session_replaced' | 'meeting_account_in_use' | 'meeting_member_expired'
export function isMeetingTerminalCode(code: unknown): code is MeetingTerminalCode {
  return code === 'session_replaced' || code === 'meeting_session_replaced' || code === 'meeting_account_in_use' || code === 'meeting_member_expired'
}

export function meetingEventsURL(baseURL: string, meetingId: string): string {
  const base = baseURL.replace(/\/+$/, '').replace(/^http/, 'ws')
  if (!/^wss?:\/\//.test(base)) throw new Error('会议连接地址无效')
  return `${base}/ws/meetings/${encodeURIComponent(meetingId)}/events`
}

export type MeetingEventSocket = {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send: (value: string) => void
  close: () => void
}

/** Caller renews the short-lived single-use ticket before reconnecting. */
export function openMeetingEvents(options: {
  url: string
  ticket: string
  createSocket: (url: string) => MeetingEventSocket
  onSnapshot: (snapshot: MeetingSnapshot) => void
  onError: (message: string) => void
  onTerminal?: (message: string, code: MeetingTerminalCode) => void
  onClose: () => void
  /**
   * Optional liveness signal: called for every valid snapshot and heartbeat
   * (the server sends one every 20 s). Native uses it on resume to tell a
   * healthy socket from a silently dead one. Omitting it changes nothing.
   */
  onActivity?: () => void
}): { close: () => void } {
  let closed = false
  let received = false
  const socket = options.createSocket(options.url)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => fail('会议状态连接超时，正在重连'), 15_000)
  const finish = (notify: boolean, closeSocket: boolean) => {
    if (closed) return
    // Detach before closing: some native sockets emit close synchronously,
    // while a broken connection may never emit it at all.
    closed = true; clearTimeout(timer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
    if (closeSocket) { try { socket.close() } catch { /* Already unusable. */ } }
    if (notify) options.onClose()
  }
  const fail = (message: string) => {
    if (closed) return
    try { options.onError(message) } finally { finish(true, true) }
  }
  const keepAlive = () => {
    // A heartbeat alone is not proof that authentication and the initial
    // snapshot succeeded. Keep the separate 15-second admission deadline.
    if (!received) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail('会议状态连接超时，正在重连'), 65_000)
  }
  const activity = () => {
    try { options.onActivity?.() } catch { /* Liveness bookkeeping must not fail the connection. */ }
  }
  socket.onopen = () => {
    if (closed) return
    try { socket.send(JSON.stringify({ type: 'auth', ticket: options.ticket })) }
    catch { fail('会议状态连接中断') }
  }
  socket.onmessage = (event) => {
    if (closed) return
    try {
      if (typeof event.data !== 'string') throw new Error('unexpected binary event')
      const data = JSON.parse(event.data) as { type?: string; snapshot?: MeetingSnapshot; message?: string; error?: string; code?: string }
      if (data.type === 'snapshot' && data.snapshot?.id && data.snapshot.me?.id
        && Array.isArray(data.snapshot.members) && Array.isArray(data.snapshot.routes) && Array.isArray(data.snapshot.transcripts)) {
        received = true; clearTimeout(timer); keepAlive(); activity(); options.onSnapshot(data.snapshot)
      } else if (data.type === 'heartbeat') { keepAlive(); activity() }
      else if (data.type === 'error') {
        const message = data.message || data.error || '会议状态更新失败'
        if (isMeetingTerminalCode(data.code) && options.onTerminal) {
          // A revoked attendance is terminal; do not reconnect or renew its ticket.
          finish(false, true)
          options.onTerminal(message, data.code)
        } else options.onError(message)
      }
    } catch { options.onError('会议状态数据无效，请重新连接') }
  }
  socket.onerror = () => fail('会议状态连接中断')
  socket.onclose = () => finish(true, false)
  return { close: () => finish(false, true) }
}
