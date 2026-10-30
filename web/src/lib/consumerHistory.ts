import { consumerFetch, createConsumerSessionGuard, getConsumerToken } from '@simultrans/ui-shared/src/lib/consumerSession'
import type { HistoryScene, HistoryTitleStatus } from '@simultrans/core/historyTitle'
import {
  buildMeetingHistoryInput,
  meetingHistorySessionId,
  utf8Length,
  type MeetingClientInfo,
  type MeetingFinishedRecord,
  type MeetingHistoryInput,
} from '@simultrans/core/meetingRecord'
import type { SessionSettings } from './sessionSettings'

export type ConsumerFetcher = (path: string, init?: RequestInit) => Promise<Response>

export type ConsumerHistoryUnit = {
  id: string
  text: string
  source?: string
  translations?: Record<string, string>
  layoutLanguage?: string
  side?: 'a' | 'b'
  startMs?: number
  outputAudioStarts?: Record<string, number>
  outputAudioEnds?: Record<string, number>
  /** 会议同传记录：这一句的原文语言与说话人（成员 id / 显示名）；其它记录不带。 */
  sourceLanguage?: string
  speakerId?: string
  speakerName?: string
  /**
   * 只在公开分享页（/api/shares）的会议记录上：speakerId 置空，改给记录内序号 speakerKey（s1、s2，不泄露成员 id）；
   * self = 分享者本人说的句子。
   */
  speakerKey?: string
  self?: boolean
}

export type ConsumerHistoryDevice = {
  label: string
  side?: 'a' | 'b' | 'shared'
}

export type ConsumerHistoryDevices = {
  inputs?: ConsumerHistoryDevice[]
  outputs?: ConsumerHistoryDevice[]
}

export type ConsumerHistoryTitle = {
  title?: string
  titleStatus?: HistoryTitleStatus
  scene?: HistoryScene
  mode?: 'solo' | 'duo'
}

/** Owner-only share metadata supplied by history list/detail. Public records omit it. */
export type ConsumerHistoryShare = { token: string; path: string; expiresAt: string; live?: boolean }

export function activeConsumerHistoryShare(share?: ConsumerHistoryShare | null, now = Date.now()): ConsumerHistoryShare | undefined {
  return share?.token && share.path === `/s/${share.token}` && Date.parse(share.expiresAt) > now ? share : undefined
}

export type ConsumerHistoryRecord = ConsumerHistoryTitle & {
  share?: ConsumerHistoryShare | null
  id: string
  createdAt: string
  sessionId: string
  provider: string
  sourceLanguage: string
  targetLanguage: string
  durationMs: number
  sourceText: string
  translationText: string
  units: ConsumerHistoryUnit[]
  devices?: ConsumerHistoryDevices
  /** 会话设置快照（docs/session-settings-history-plan.md §二）；旧记录缺省。 */
  settings?: SessionSettings
  /** start 帧 traceparent 的 trace-id（32 hex），用于对齐后端 trace 与客户端日志。 */
  traceId?: string
  abnormalExit?: boolean
  completionReason?: string
}

export type ConsumerHistorySummary = ConsumerHistoryTitle & {
  share?: ConsumerHistoryShare | null
  id: string
  createdAt: string
  sourceLanguage: string
  targetLanguage: string
  targetLanguages?: string[]
  mode?: 'solo' | 'duo'
  durationMs: number
  preview: string
  unitCount: number
  completionReason?: string
  abnormalExit?: boolean
  /**
   * 会话设置快照（后端 addConsumerHistoryDiagnostics 随列表下发；旧记录缺省）。会议记录的
   * settings.meeting（memberId / code / endReason）用来认出进行中会议的会中检查点。
   */
  settings?: unknown
  traceId?: string
}

export type ConsumerHistoryInput = Omit<ConsumerHistoryRecord, 'id' | 'createdAt' | 'title' | 'titleStatus' | 'share'>

const CONSUMER_HISTORY_CHECKPOINT_KEY = 'simultrans.consumerHistoryCheckpoints.v2'
let checkpointRetry: Promise<void> | null = null

/**
 * 本机待补存的条目。keepCompletion：会议记录的终稿直连没存上、留在本机的那份——重放时原样发
 * （completionReason / abnormalExit 不改写成检查点），否则正常离会的记录会被说成「未正常结束」。
 */
type StoredConsumerHistoryInput = ConsumerHistoryInput & { keepCompletion?: true }

export function consumerHistoryCheckpointOwner(token = getConsumerToken()) {
  if (!token) return ''
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const json = JSON.parse(decoded) as { sub?: unknown }
    return typeof json.sub === 'string' ? json.sub.trim() : ''
  } catch {
    return ''
  }
}

function consumerHistoryCheckpointKey(owner = consumerHistoryCheckpointOwner()) {
  return owner ? `${CONSUMER_HISTORY_CHECKPOINT_KEY}:${encodeURIComponent(owner)}` : ''
}

export type ConsumerSnapshotRow = {
  id: string
  source: string
  startMs: number
  translations: Record<string, string>
  layoutLanguage?: string
  side?: 'a' | 'b'
  primaryLanguage?: string
  outputAudioStarts?: Record<string, number>
  outputAudioEnds?: Record<string, number>
}

function normalizedAudioOffsets(values?: Record<string, number>) {
  return Object.fromEntries(Object.entries(values || {}).flatMap(([language, value]) => (
    language && Number.isFinite(value) && value >= 0 ? [[language, Math.round(value)]] : []
  )))
}

export function buildConsumerHistoryInput({
  sessionId,
  provider,
  sourceLanguage,
  targetLanguages,
  durationMs,
  rows,
  devices,
  settings,
  traceId,
}: {
  sessionId: string
  provider: string
  sourceLanguage: string
  targetLanguages: string[]
  durationMs: number
  rows: ConsumerSnapshotRow[]
  devices?: ConsumerHistoryDevices
  settings?: SessionSettings
  traceId?: string
}): ConsumerHistoryInput {
  const primaryLanguage = targetLanguages[0] || ''
  const units = rows.map((row) => {
    const text = row.translations[row.layoutLanguage || row.primaryLanguage || primaryLanguage]
      || targetLanguages.map((language) => row.translations[language]).find(Boolean)
      || Object.values(row.translations).find(Boolean)
      || ''
    const outputAudioStarts = normalizedAudioOffsets(row.outputAudioStarts)
    const outputAudioEnds = normalizedAudioOffsets(row.outputAudioEnds)
    return {
      id: row.id,
      text,
      source: row.source,
      translations: row.translations,
      ...(row.layoutLanguage ? { layoutLanguage: row.layoutLanguage } : {}),
      ...(row.side ? { side: row.side } : {}),
      startMs: Math.max(0, Math.round(row.startMs)),
      ...(Object.keys(outputAudioStarts).length > 0 ? { outputAudioStarts } : {}),
      ...(Object.keys(outputAudioEnds).length > 0 ? { outputAudioEnds } : {}),
    }
  })
  return {
    sessionId,
    provider,
    sourceLanguage,
    targetLanguage: primaryLanguage,
    durationMs: Math.max(0, Math.round(durationMs)),
    sourceText: rows.filter((row) => !row.layoutLanguage || row.layoutLanguage === (row.side ? row.primaryLanguage || primaryLanguage : primaryLanguage)).map((row) => row.source).join('\n'),
    translationText: units.filter((unit, index) => !unit.layoutLanguage || unit.layoutLanguage === (unit.side ? rows[index].primaryLanguage || primaryLanguage : primaryLanguage)).map((unit) => unit.text).join('\n'),
    units,
    ...(devices ? { devices } : {}),
    ...(settings ? { settings } : {}),
    ...(traceId?.trim() ? { traceId: traceId.trim() } : {}),
  }
}

export function consumerHistoryAudioRange(
  units: ConsumerHistoryUnit[],
  unitIndex: number,
  language?: string,
) {
  const unit = units[unitIndex]
  const startMs = language ? unit?.outputAudioStarts?.[language] : unit?.startMs
  if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) return null
  const explicitEnd = language ? unit.outputAudioEnds?.[language] : undefined
  if (typeof explicitEnd === 'number' && Number.isFinite(explicitEnd) && explicitEnd > startMs) {
    return { startMs, endMs: explicitEnd }
  }
  for (let index = unitIndex + 1; index < units.length; index += 1) {
    if (units[index].side !== unit.side) continue
    const nextStart = language ? units[index].outputAudioStarts?.[language] : units[index].startMs
    if (typeof nextStart === 'number' && Number.isFinite(nextStart) && nextStart > startMs) {
      return { startMs, endMs: nextStart }
    }
  }
  return { startMs }
}

async function responseJSON<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null) as ({ error?: string } & T) | null
  if (!response.ok) throw new Error(body?.error || fallback)
  if (!body) throw new Error(fallback)
  return body
}

export async function saveConsumerHistory(
  input: ConsumerHistoryInput,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<{ id: string; createdAt: string }> {
  const response = await fetcher('/api/consumer/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return responseJSON(response, '无法保存同传历史记录。')
}

function readConsumerHistoryCheckpoints(owner?: string): StoredConsumerHistoryInput[] {
  const key = consumerHistoryCheckpointKey(owner)
  if (!key) return []
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter((item): item is StoredConsumerHistoryInput => (
      Boolean(item && typeof item === 'object' && typeof item.sessionId === 'string' && item.sessionId)
    )) : []
  } catch {
    return []
  }
}

function writeConsumerHistoryCheckpoints(values: StoredConsumerHistoryInput[], owner?: string) {
  const key = consumerHistoryCheckpointKey(owner)
  if (!key) return
  try {
    if (values.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(values.slice(-8)))
  } catch {
    // The server-side disconnect snapshot remains the fallback when browser
    // storage is unavailable or full.
  }
}

export function checkpointConsumerHistory(input: ConsumerHistoryInput) {
  if (!input.sessionId || (!input.sourceText.trim() && !input.translationText.trim() && input.units.length === 0)) return
  const current = readConsumerHistoryCheckpoints()
  writeConsumerHistoryCheckpoints([
    ...current.filter((item) => item.sessionId !== input.sessionId),
    { ...input, abnormalExit: true, completionReason: 'client_checkpoint' },
  ])
}

export function clearConsumerHistoryCheckpoint(sessionId: string, owner?: string) {
  writeConsumerHistoryCheckpoints(readConsumerHistoryCheckpoints(owner).filter((item) => item.sessionId !== sessionId), owner)
}

/**
 * 只撤掉「还是这一份」的本机条目：读出之后同一 sessionId 又被写进更新的一份（会中检查点、会议记录终稿）时留着它，
 * 免得一次补存 / 保存把别的标签页刚落下的终稿清掉。
 */
function clearConsumerHistoryEntry(entry: StoredConsumerHistoryInput, owner?: string) {
  const serialized = JSON.stringify(entry)
  const current = readConsumerHistoryCheckpoints(owner)
  const kept = current.filter((item) => item.sessionId !== entry.sessionId || JSON.stringify(item) !== serialized)
  if (kept.length !== current.length) writeConsumerHistoryCheckpoints(kept, owner)
}

export function retryConsumerHistoryCheckpoints(fetcher: ConsumerFetcher = consumerFetch): Promise<void> {
  if (checkpointRetry) return checkpointRetry
  checkpointRetry = (async () => {
    const owner = consumerHistoryCheckpointOwner()
    if (!owner) return
    for (const entry of readConsumerHistoryCheckpoints(owner)) {
      if (consumerHistoryCheckpointOwner() !== owner) return
      const { keepCompletion, ...input } = entry
      try {
        const replay = keepCompletion ? input : {
          ...input,
          abnormalExit: true,
          completionReason: 'client_checkpoint',
        }
        if (isMeetingHistoryEntry(entry)) {
          const result = await saveMeetingRecordInOrder(owner, replay, { fetcher, keepalive: false })
          if (result.status !== 'saved') continue
        } else await saveConsumerHistory(replay, fetcher)
        // 补存途中会议页可能已把同一 sessionId 的终稿落进本机：只撤刚补存的这一份。
        if (consumerHistoryCheckpointOwner() === owner) clearConsumerHistoryEntry(entry, owner)
      } catch {
        // Keep the checkpoint for the next authenticated page load.
      }
    }
  })().finally(() => { checkpointRetry = null })
  return checkpointRetry
}

/** 写一条本机待补存（同一 sessionId 只留最新一份）；owner 缺省 = 当前登录账号。 */
function storeConsumerHistoryEntry(entry: StoredConsumerHistoryInput, owner?: string) {
  const current = readConsumerHistoryCheckpoints(owner)
  writeConsumerHistoryCheckpoints([...current.filter((item) => item.sessionId !== entry.sessionId), entry], owner)
}

// ---------------------------------------------------------------------------
// 会议同传记录（Canary，2026-10-21「会议记录快速做法」）：Web 已登录参会者像 App 一样，在自己这次出席结束时
// 存一条会议记录（sessionId = 会议 id_成员 id，scene = meeting，只收入会之后的内容，没有内容不存）。组装规则在
// @simultrans/core/meetingRecord（与 App 同一份）；这里只管 Web 怎么存：终稿先落本机（替掉会中检查点）再直连保存，
// 存上 / 被拒后撤掉，网络 / 5xx 这类失败就留在本机（同一账号下次打开首页或历史记录时原样补存）；会中检查点只写本机，
// 页面卸载时另用 fetch keepalive 尽力发一份。游客、登录账号与入会时不同、服务端没声明 meetingRecords 时一律不存；
// 只抓不存的拆除（登录态变化）与登出时，本机留着的会议检查点一并撤掉（里面有其他参会者的发言和显示名）。

/**
 * fetch keepalive 的请求体上限：浏览器对一个页面卸载时在途的 keepalive 请求合计只给 64 KB（超过直接拒绝），
 * 留点余量。超过的检查点只留本机那份，等下次打开首页 / 历史记录时补存。
 */
export const MEETING_KEEPALIVE_MAX_BYTES = 60 * 1024

export type MeetingRecordSaveResult = { status: 'saved'; id: string } | { status: 'rejected' } | { status: 'failed' }

/** POST 一份会议记录 body。4xx（401 / 408 / 429 除外）= 后端明确拒收，重发也只会再拒；其余失败可重试。永不抛错。 */
export async function saveMeetingHistoryInput(
  input: MeetingHistoryInput | ConsumerHistoryInput,
  options: { fetcher?: ConsumerFetcher; keepalive?: boolean } = {},
): Promise<MeetingRecordSaveResult> {
  try {
    const response = await (options.fetcher ?? consumerFetch)('/api/consumer/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(options.keepalive ? { keepalive: true } : {}),
    })
    if (response.ok) {
      const body = await response.json().catch(() => null) as { id?: unknown } | null
      return { status: 'saved', id: typeof body?.id === 'string' ? body.id : '' }
    }
    return response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status)
      ? { status: 'rejected' }
      : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

/**
 * 一份会议记录没存的原因：
 * - discarded：只抓不存的拆除（登录态变化、页面卸载）；
 * - not_recordable：入会时服务端没声明支持会议记录（或不在 Canary）；
 * - guest：游客入会；
 * - account_changed：现在登录的不是入会时的账号（登出 / 换号 / 被顶号）；
 * - no_rows：入会之后一行字都没有（不存空记录）。
 */
export type MeetingRecordSkip = 'discarded' | 'not_recordable' | 'guest' | 'account_changed' | 'no_rows'

export type MeetingRecordPersistResult =
  | { outcome: 'saved'; historyId: string }
  | { outcome: 'queued' }
  | { outcome: 'rejected' }
  | { outcome: 'skipped'; skip: MeetingRecordSkip }

/** 不能存进这位用户历史的原因；null = 能存。不看行数（行数由组装时判断）。 */
export function meetingRecordSkipReason(record: MeetingFinishedRecord, owner = consumerHistoryCheckpointOwner()): MeetingRecordSkip | null {
  if (record.reason === 'discarded') return 'discarded'
  if (record.recordable !== true) return 'not_recordable'
  if (!record.accountId) return 'guest'
  if (owner !== record.accountId) return 'account_changed'
  return null
}

/**
 * 撤掉这次出席留在本机的会中检查点（只抓不存的拆除、登录的已不是入会时那个账号）：这次出席不存，也不再补存成
 * 「会话恢复记录」。sessionId：并进认领过的游客记录时那条记录的 sessionId（缺省 = 这次出席自己的）。
 */
export function dropMeetingRecordCheckpoint(record: Pick<MeetingFinishedRecord, 'meetingId' | 'me' | 'accountId'>, sessionId?: string): void {
  if (record.accountId) clearConsumerHistoryCheckpoint(sessionId || meetingHistorySessionId(record), record.accountId)
}

/** 组装 body；sessionId 覆盖时（并进认领过的游客记录）写到那一条上。 */
function meetingHistoryInputFor(record: MeetingFinishedRecord, client: MeetingClientInfo & { checkpoint?: boolean }, sessionId?: string): MeetingHistoryInput | null {
  const input = buildMeetingHistoryInput(record, client)
  return input && sessionId ? { ...input, sessionId } : input
}

// A guest claim and a subsequent attendance can finish before the first POST returns.
// Both replace the same history session: send them in order so the older claim cannot
// overwrite the merged final. Local storage is updated before joining this queue.
const meetingRecordSaves = new Map<string, Promise<MeetingRecordSaveResult>>()
async function saveMeetingRecordInOrder(
  owner: string,
  input: MeetingHistoryInput | ConsumerHistoryInput,
  options: { fetcher?: ConsumerFetcher; keepalive: boolean },
): Promise<MeetingRecordSaveResult> {
  const key = JSON.stringify([owner, input.sessionId])
  const currentLogin = createConsumerSessionGuard()
  const send = () => currentLogin() && consumerHistoryCheckpointOwner() === owner
    ? saveMeetingHistoryInput(input, options)
    : Promise.resolve<MeetingRecordSaveResult>({ status: 'failed' })
  const previous = meetingRecordSaves.get(key)
  const pending = previous ? previous.then(send, send) : send()
  meetingRecordSaves.set(key, pending)
  try { return await pending }
  finally { if (meetingRecordSaves.get(key) === pending) meetingRecordSaves.delete(key) }
}

/**
 * 保存一次出席的终稿。先把终稿落进本机（打上 keepCompletion，替掉同一 sessionId 的会中检查点；补存时原样发，仍是
 * 正常结束），再直连 POST：发送途中标签页被关 / 跳走，本机留的是这份终稿而不是半分钟前的检查点；body 放得进
 * keepalive 预算（MEETING_KEEPALIVE_MAX_BYTES）时带 keepalive，页面卸载后浏览器仍会发完。存上 / 被拒后撤掉本机这份；
 * 可重试的失败（网络 / 5xx / 401）就留着，但只在登录的还是入会时那个账号时才留。永不抛错。
 * sessionId：覆盖历史 sessionId（并进认领过的游客记录时用那条的，后端按账号 + sessionId 覆盖同一条）。
 */
export async function persistMeetingRecord(
  record: MeetingFinishedRecord,
  options: { client: MeetingClientInfo; fetcher?: ConsumerFetcher; sessionId?: string },
): Promise<MeetingRecordPersistResult> {
  const blocked = meetingRecordSkipReason(record)
  if (blocked) {
    if (blocked === 'discarded' || blocked === 'account_changed') dropMeetingRecordCheckpoint(record, options.sessionId)
    return { outcome: 'skipped', skip: blocked }
  }
  const owner = record.accountId as string
  const input = meetingHistoryInputFor(record, options.client, options.sessionId)
  if (!input) return { outcome: 'skipped', skip: 'no_rows' }
  const entry: StoredConsumerHistoryInput = { ...(input as unknown as ConsumerHistoryInput), keepCompletion: true }
  // 同步写（在第一个 await 之前）：调用方紧接着撤「进行中」，开着的历史页据此补存时读到的已是终稿。
  storeConsumerHistoryEntry(entry, owner)
  const keepalive = utf8Length(JSON.stringify(input)) <= MEETING_KEEPALIVE_MAX_BYTES
  const result = await saveMeetingRecordInOrder(owner, input, { fetcher: options.fetcher, keepalive })
  if (result.status === 'saved') {
    clearConsumerHistoryEntry(entry, owner)
    return { outcome: 'saved', historyId: result.id }
  }
  if (result.status === 'rejected') {
    // 后端拒收终稿：本机这份（连同被它替掉的会中检查点）不再补存（App 同样在终稿前撤回队列里的检查点）。
    clearConsumerHistoryEntry(entry, owner)
    return { outcome: 'rejected' }
  }
  if (consumerHistoryCheckpointOwner() !== owner) {
    clearConsumerHistoryEntry(entry, owner)
    return { outcome: 'skipped', skip: 'account_changed' }
  }
  return { outcome: 'queued' }
}

/**
 * 会中检查点：写进本机待补存（与单人会话的检查点同一处、按账号分开），页面被关 / 浏览器崩溃之后，同一账号
 * 下次打开首页或历史记录时补存成「会话恢复记录」；终稿存好后清掉。keepalive（pagehide 时）另用 fetch keepalive
 * 直接发一份：页面卸载后浏览器仍会把它发完，但只给合计 64 KB，超过（长会议）就只留本机那份。返回是否写了检查点。
 * sessionId 同 persistMeetingRecord。
 */
export function checkpointMeetingRecord(
  record: MeetingFinishedRecord,
  options: { client: MeetingClientInfo; keepalive?: boolean; fetcher?: ConsumerFetcher; sessionId?: string },
): boolean {
  if (meetingRecordSkipReason(record)) return false
  const input = meetingHistoryInputFor(record, { ...options.client, checkpoint: true }, options.sessionId)
  if (!input) return false
  storeConsumerHistoryEntry(input as unknown as ConsumerHistoryInput, record.accountId as string)
  if (options.keepalive && utf8Length(JSON.stringify(input)) <= MEETING_KEEPALIVE_MAX_BYTES) {
    void saveMeetingRecordInOrder(record.accountId as string, input, { fetcher: options.fetcher, keepalive: true })
  }
  return true
}

function isMeetingHistoryEntry(item: StoredConsumerHistoryInput): boolean {
  const settings = item.settings as unknown as { scene?: unknown } | undefined
  return item.provider === 'meeting' || settings?.scene === 'meeting'
}

/**
 * 登出之后（本浏览器已没有登录）撤掉所有账号留在本机的会议记录待补存（会中检查点、没存上的终稿）：里面有其他参会者的
 * 发言和显示名，不能留在共用电脑上等下次登录（App 登出时同样清掉保存队列）。单人会话的检查点照旧留着。
 */
export function clearMeetingHistoryCheckpointsAfterLogout(): void {
  if (getConsumerToken()) return
  const prefix = `${CONSUMER_HISTORY_CHECKPOINT_KEY}:`
  try {
    const owners: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix)) owners.push(decodeURIComponent(key.slice(prefix.length)))
    }
    for (const owner of owners) {
      const current = readConsumerHistoryCheckpoints(owner)
      const kept = current.filter((item) => !isMeetingHistoryEntry(item))
      if (kept.length !== current.length) writeConsumerHistoryCheckpoints(kept, owner)
    }
  } catch {
    // 本机存储不可用：本来也就没有留下什么。
  }
}

// 登出的那个标签页会派发 consumer:session-changed（订阅了登录态的其他标签页随后也会），本机存储各标签页共用，
// 清一次就够；登录 / 换号时有 token，不动。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('consumer:session-changed', clearMeetingHistoryCheckpointsAfterLogout)
}

// ---------------------------------------------------------------------------
// 历史页的「进行中」卡片（Canary；2026-10-21 拍板：只给本人当前仍在会中的那场）。Web 会议页把本页正在参与的会议
// 发布出来，历史页据此在顶上钉一张卡：
// - 其他标签页开着会议页：BroadcastChannel，历史页一问，开着会议页的标签页就答（页面活着 = 仍在会中）；卡片只写明
//   「在其他标签页中进行」、不给链接（在这里重新加入会把那个标签页的出席顶掉，记成被移出）；
// - 本标签页离开了会议页但没点「离开会议」：sessionStorage 里留着，服务端在场宽限是 150 秒，卡片只在离开会议页后的
//   ACTIVE_MEETING_TAB_GRACE_MS 内出，点它回到 /meeting?code=<会议码>（要重新加入，同账号冲突时走「退出原会议并继续」）。
// 只存会议码、成员 id 这些，不存字幕；按登录账号区分，别的账号看不到。

export type ActiveMeetingPresence = {
  /** 入会时的登录账号（JWT sub）。 */
  owner: string
  meetingId: string
  /** 本人这次出席的成员 id（会议记录 settings.meeting.memberId 同一个值），列表据此认出这场的会中检查点。 */
  memberId: string
  /** 原始会议码（9 位数字）。 */
  code: string
  /** 会议开始时间（epoch ms），卡片计时用（与会中页头同一来源）。 */
  startedAt: number
  /** 本人的收听语言。 */
  targetLanguage?: string
  /** 最后一次确认本标签页仍在会中的时刻（epoch ms）；离开会议页（pagehide）时更新。 */
  updatedAt: number
}

export type ActiveMeetingLookup = { presence: ActiveMeetingPresence; where: 'this-tab' | 'other-tab' }

const ACTIVE_MEETING_KEY = 'simultrans.activeMeeting.v1'
const ACTIVE_MEETING_CHANNEL = 'simultrans.activeMeeting.v1'
/** 本标签页离开会议页之后，卡片还出多久（服务端在场宽限 150 秒，留出余量）。 */
export const ACTIVE_MEETING_TAB_GRACE_MS = 120_000
/** 历史页询问其他标签页时等多久（没有会议页开着时，列表照常先出，卡片晚这么久才可能出现）。 */
export const ACTIVE_MEETING_QUERY_TIMEOUT_MS = 250

let activeMeeting: ActiveMeetingPresence | null = null
let activeMeetingResponder: BroadcastChannel | null = null

function activeMeetingChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(ACTIVE_MEETING_CHANNEL) : null
  } catch {
    return null
  }
}

function validActiveMeeting(value: unknown): value is ActiveMeetingPresence {
  const item = value as Partial<ActiveMeetingPresence> | null
  return Boolean(item && typeof item === 'object'
    && typeof item.owner === 'string' && item.owner
    && typeof item.meetingId === 'string' && item.meetingId
    && typeof item.memberId === 'string'
    && typeof item.code === 'string' && item.code
    && typeof item.startedAt === 'number' && Number.isFinite(item.startedAt)
    && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt))
}

function writeTabActiveMeeting(value: ActiveMeetingPresence | null) {
  try {
    if (value) sessionStorage.setItem(ACTIVE_MEETING_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(ACTIVE_MEETING_KEY)
  } catch {
    // 存不了就只靠 BroadcastChannel（其他标签页）。
  }
}

/**
 * 会议页：本页正在参与的会议；null = 离会 / 会议结束 / 被移出（本标签页的记录一并清掉，开着的历史页收到通知后
 * 撤卡并重拉列表）。会中改了收听语言时再发一次即可。
 */
export function publishActiveMeeting(presence: ActiveMeetingPresence | null): void {
  const previous = activeMeeting
  activeMeeting = presence
  writeTabActiveMeeting(presence)
  if (presence && !activeMeetingResponder) {
    activeMeetingResponder = activeMeetingChannel()
    activeMeetingResponder?.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null
      if (data?.type === 'query' && activeMeeting) activeMeetingResponder?.postMessage({ type: 'active', presence: activeMeeting })
    })
  }
  if (presence && !previous) activeMeetingResponder?.postMessage({ type: 'started' })
  if (!presence && previous) activeMeetingResponder?.postMessage({ type: 'inactive', meetingId: previous.meetingId })
}

/** 会议页被关 / 跳走（pagehide）且没有离会：本标签页的宽限从这一刻算。 */
export function touchActiveMeeting(now = Date.now()): void {
  if (!activeMeeting) return
  activeMeeting = { ...activeMeeting, updatedAt: now }
  writeTabActiveMeeting(activeMeeting)
}

/** 会议页：一份会议记录刚存好（开着的历史页据此重拉列表）。 */
export function announceMeetingRecordSaved(): void {
  activeMeetingResponder?.postMessage({ type: 'saved' })
}

function askOtherTabs(owner: string, timeoutMs: number): Promise<ActiveMeetingPresence | null> {
  const channel = activeMeetingChannel()
  if (!channel) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ActiveMeetingPresence | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.close()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    channel.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: unknown; presence?: unknown } | null
      if (data?.type === 'active' && validActiveMeeting(data.presence) && data.presence.owner === owner) finish(data.presence)
    })
    channel.postMessage({ type: 'query' })
  })
}

/**
 * 历史页：这个账号此刻在本浏览器里仍在参与的会议（其他标签页的会议页优先，其次是本标签页宽限内的那场）；没有为 null。
 */
export async function findActiveMeeting(
  owner: string,
  options: { timeoutMs?: number; now?: number } = {},
): Promise<ActiveMeetingLookup | null> {
  if (!owner) return null
  const other = await askOtherTabs(owner, options.timeoutMs ?? ACTIVE_MEETING_QUERY_TIMEOUT_MS)
  if (other) return { presence: other, where: 'other-tab' }
  let stored: unknown = null
  try {
    stored = JSON.parse(sessionStorage.getItem(ACTIVE_MEETING_KEY) || 'null')
  } catch {
    stored = null
  }
  const now = options.now ?? Date.now()
  if (!validActiveMeeting(stored) || stored.owner !== owner) return null
  const age = now - stored.updatedAt
  return age >= 0 && age <= ACTIVE_MEETING_TAB_GRACE_MS ? { presence: stored, where: 'this-tab' } : null
}

export type ActiveMeetingChange = 'started' | 'inactive' | 'saved'

/**
 * 历史页：其他标签页的会议开始 / 结束、会议记录存好时回调（据此重查卡片、重拉列表）。返回取消订阅。
 * 'inactive' 时那边的终稿多半还在发：历史页只重拉列表，不在这时补存本机条目（免得和会议页同时发同一份）。
 */
export function subscribeActiveMeetingChanges(listener: (change: ActiveMeetingChange) => void): () => void {
  const channel = activeMeetingChannel()
  if (!channel) return () => undefined
  channel.addEventListener('message', (event: MessageEvent) => {
    const type = (event.data as { type?: unknown } | null)?.type
    if (type === 'started' || type === 'inactive' || type === 'saved') listener(type)
  })
  return () => channel.close()
}

export async function loadConsumerHistoryAudio(
  historyId: string,
  sessionId: string,
  kind: string,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<Blob | undefined> {
  const response = await fetcher(
    `/api/consumer/history/${encodeURIComponent(historyId)}/audio/${encodeURIComponent(kind)}?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { Accept: 'audio/wav' } },
  )
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error('无法读取同传历史音频。')
  return response.blob()
}

/**
 * 按 sessionId 反查已保存的历史记录 id（双人传保存时的 "left:right" 组合串）。
 * 结束页「分享」在保存被跳页打断、或从历史页返回后 returnView 没带 historyId
 * 时靠它拿回 id。404 表示记录尚未落库（旧后端没有该路由时也会落到 {id} 路由的
 * 404），对调用方都是「暂时拿不到」，返回空串由调用方提示稍等。
 */
export async function lookupConsumerHistoryId(
  sessionId: string,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<string> {
  if (!sessionId) return ''
  const response = await fetcher(`/api/consumer/history/lookup?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { Accept: 'application/json' },
  })
  if (response.status === 404 || response.status === 405 || response.status === 501) return ''
  const body = await responseJSON<{ id?: string }>(response, '无法查询同传历史记录。')
  return typeof body.id === 'string' ? body.id : ''
}

export async function loadConsumerHistory(
  id: string,
  fetcher: ConsumerFetcher = consumerFetch,
  signal?: AbortSignal,
): Promise<ConsumerHistoryRecord> {
  const response = await fetcher(`/api/consumer/history/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
    headers: { Accept: 'application/json' },
  })
  return responseJSON(response, '无法读取同传历史记录。')
}

export async function listConsumerHistory(
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<ConsumerHistorySummary[]> {
  const response = await fetcher('/api/consumer/history', {
    headers: { Accept: 'application/json' },
  })
  const body = await responseJSON<{ records?: ConsumerHistorySummary[] }>(response, '无法读取同传历史记录。')
  return Array.isArray(body.records) ? body.records : []
}

export async function deleteConsumerHistory(
  id: string,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<void> {
  const response = await fetcher(`/api/consumer/history/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  await responseJSON(response, '无法删除同传历史记录。')
}

export async function createConsumerShareLink(
  historyId: string,
  origin: string,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<{ token: string; path: string; expiresAt: string; url: string }> {
  const response = await fetcher('/api/consumer/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ historyId, ttlDays: 30 }),
  })
  const share = await responseJSON<{ token: string; path: string; expiresAt: string }>(response, '无法生成快照链接。')
  return { ...share, url: `${origin.replace(/\/$/, '')}${share.path}` }
}

export async function copySnapshotLink(url: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持自动复制，请手动复制链接。')
  await navigator.clipboard.writeText(url)
}

/** Revoke every link for this record, including a previously generated live share. */
export async function revokeConsumerShareLink(token: string, fetcher: ConsumerFetcher = consumerFetch): Promise<void> {
  const response = await fetcher(`/api/consumer/shares/${encodeURIComponent(token)}?scope=history`, { method: 'DELETE' })
  await responseJSON(response, '撤销未完成，请重试；暂时不要继续转发此链接')
}

/**
 * 结束页补译完成后，把新语言的译文单元追加到已保存的记录（同语言重复提交整体替换）。
 * 返回后端回显的记录详情；404 表示记录不存在。
 */
export async function appendConsumerHistoryLanguage(
  historyId: string,
  language: string,
  units: ConsumerHistoryInput['units'],
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetcher(`/api/consumer/history/${encodeURIComponent(historyId)}/languages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, units }),
  })
  if (response.ok) return { ok: true }
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return { ok: false, error: payload?.error || `追加译文失败（${response.status}）` }
}
