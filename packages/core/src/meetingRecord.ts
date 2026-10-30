// P1-3 会议同传记录（Canary）：一次出席（attendance）的字幕快照 → 历史记录 POST body，App 与 Web 共用。
// 2026-10-21「会议记录快速做法」：Web 已登录参会者也像 App 一样存自己这次出席的记录，所以组装规则从
// mobile/src/session/meetingHistory.ts 挪到这里（函数名与产出的形状不变）：
// - 只收「我看到的」：本人原文 + 他人在我目标语言下的译文（存档本来就只有这些行），并且只收入会之后的发言
//   （服务端快照不按入会时间过滤）；一行都没有时不出 body（不存空记录）；
// - settings.scene = 'meeting'、mode = 'solo'，会议信息收在 settings.meeting 里；sessionId = 会议 id_成员 id。
// 纯函数、不依赖 react-native / DOM，Hermes 可跑（不用 \p{} 与 u 标志正则）。平台差异（平台名、版本号、构建号）
// 由调用方传入；保存策略（App 直连 + 耐久队列，Web 直连 + localStorage 补存）各端自己做。
import {
  MeetingCaptionHistory,
  meetingCaptionsForDisplay,
  type MeetingMember,
  type MeetingSnapshot,
  type MeetingTranscript,
} from './meeting'
import { isNormalSessionEnd, type SessionCompletionReason } from './sessionCompletion'

/**
 * 一次出席怎样结束的。
 * - left / ended_by_me：本人离会 / 主持人结束；
 * - ended_remote / expired / idle：停留在会中时被远端结束、到期、闲置关闭；
 * - revoked：入会凭据被吊销 / 被顶号；
 * - discarded：只抓不存的拆除（App 卸载、登录态变化）——换了账号的记录绝不能存进新账号。
 * 前五个都是正常收尾（client_stopped），revoked 是 client_disconnected。
 */
export type MeetingExitReason = 'left' | 'ended_by_me' | 'ended_remote' | 'expired' | 'idle' | 'revoked' | 'discarded'
/** 记录用途：结束时的终稿，或会中的检查点。 */
export type MeetingRecordReason = MeetingExitReason | 'checkpoint'

/**
 * 一次出席的字幕快照，在字幕被清空**之前**抓取。rows 是存档里的原始行（未经展示合并 / 入会时间过滤），
 * 映射规则见 meetingHistoryRows。
 */
export type MeetingFinishedRecord = {
  meetingId: string
  code: string
  /** 抓取时快照里的「我」（含最新的语言与显示名）。 */
  me: MeetingMember
  hostMemberId: string
  /** 本次出席期间见过的参会者人数（含本人）。 */
  memberCount: number
  rows: MeetingTranscript[]
  /** 服务端给的本人入会时间；解析不了时退回本机拿到入会结果的时刻。 */
  joinedAt: string
  endedAt: string
  reason: MeetingRecordReason
  /** 入会时的登录账号；游客为 null。 */
  accountId: string | null
  /** 存档到过上限（最早的字幕可能已被淘汰），记录据此打上 settings.meeting.truncated。 */
  truncated: boolean
  /** 这次出席所在环境的 API base（会议连接创建时固定）。 */
  baseURL: string
  /** 入会时服务端是否声明支持会议记录（capabilities.meetingRecords）；没声明时什么都不存。 */
  recordable: boolean
}

/**
 * 整场字幕存档的上限。服务端房间最多保留 2000 条非预览转写，存档里还有预览行与本人原文行，
 * 所以留足一倍，让存档自己几乎永远不淘汰；真发生淘汰时记录会打上 truncated。
 */
export const MEETING_ARCHIVE_LIMIT = 4000
/** 整份 POST body 的上限：留出余量，低于后端 / 队列的 256 KB。 */
export const MEETING_HISTORY_MAX_BYTES = 240 * 1024
/** settings 的上限与后端 normalizeConsumerHistorySettings 一致。 */
export const MEETING_SETTINGS_MAX_BYTES = 8 * 1024
/** translationText 只供列表预览（后端取前 80 字）与标题兜底，截到 2000 字。 */
export const MEETING_TRANSLATION_TEXT_LIMIT = 2000
/** 检查点的最小间隔（App 原生心跳每 15 秒一次，检查点至多每 30 秒一次；Web 定时器同一个间隔）。 */
export const MEETING_CHECKPOINT_MIN_INTERVAL_MS = 30_000
/** 会议说话人字段的上限：与后端 consumerstore.MaxHistoryUnitSpeakerRunes 一致（按码点计）。 */
export const HISTORY_SPEAKER_MAX_CHARS = 64

/**
 * 用户 2026-10-21（会议记录快速做法，App 与 Web 同句）：Canary 游客离会 / 会议结束后的登录提示。只是提示，
 * 游客这场照旧什么都不存；登录后再入会，之后的会议才会存进历史。
 */
export const MEETING_GUEST_SAVE_PROMPT = '登录后可保存会议记录'
export const MEETING_GUEST_LOGIN_LABEL = '登录'

/** 会议记录里逐句的原文语言（会议只有这几种；其它值不写）。 */
export type MeetingRowSourceLanguage = 'zh' | 'en' | 'ja' | 'ko'
const SOURCE_LANGUAGES: readonly string[] = ['zh', 'en', 'ja', 'ko']

export type MeetingHistoryRow = {
  /** 紧凑序号 m<index>（服务端行 id 不入库）。 */
  id: string
  source: string
  /** 本人行 / 同语言原文行为空；他人译文行为 { 该行目标语言: 译文 }。 */
  translations: Record<string, string>
  /** 该句首次出现的服务端时间（ISO）。 */
  createdAt: string
  /** 相对本人入会时间的毫秒偏移。 */
  startMs?: number
  sourceLanguage?: MeetingRowSourceLanguage
  speakerId?: string
  speakerName?: string
  self: boolean
}

/** 写进 settings.client 的客户端信息（App：Platform.OS / JS 版本 / 构建号；Web：'web' / 构建号）。 */
export type MeetingClientInfo = { platform: string; version?: string; buildSha?: string }

export type MeetingSettings = {
  client: MeetingClientInfo
  mode: 'solo'
  scene: 'meeting'
  sourceLanguage: string
  targetLanguages: string[]
  meeting: {
    code: string
    memberId: string
    role: 'host' | 'member'
    memberCount: number
    endReason: MeetingRecordReason
    truncated?: boolean
  }
}

/** 一句会议记录（后端 consumerstore.HistoryUnit 的子集）。 */
export type MeetingHistoryUnit = {
  id: string
  /** 主输出语言的译文（主语言为空时退到第一条非空译文；本人行为空串）。 */
  text: string
  source?: string
  translations?: Record<string, string>
  startMs?: number
  sourceLanguage?: MeetingRowSourceLanguage
  speakerId?: string
  speakerName?: string
}

/** POST /api/consumer/history 的 body（终稿或检查点）。字段与 App SaveHistoryInput / Web 记录同名。 */
export type MeetingHistoryInput = {
  sessionId: string
  provider: string
  sourceLanguage: string
  targetLanguage: string
  targetLanguages?: string[]
  mode: 'solo'
  durationMs: number
  /** 会议记录不发整篇原文（Web 会按行下标拿它兜底空原文，标题生成会退回逐句原文）。 */
  sourceText: string
  translationText: string
  units: MeetingHistoryUnit[]
  settings: MeetingSettings
  /** 关联键 = 会议 id（字符集满足后端校验时才写）。 */
  traceId?: string
  completionReason: SessionCompletionReason
  abnormalExit: boolean
}

/** UTF-8 字节数（存储与 HTTP body 都按字节算，不能用 string.length）。按 charCode 算，Hermes 可跑。 */
export function utf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个 4 字节码点，跳过低位。
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * 说话人字段收敛：只收字符串，去首尾空白后按码点截到 64 字（不劈开代理对）；
 * 非字符串 / 空串返回 undefined（字段整体不写）。写入与读回共用，保证往返一致。
 */
export function normalizeHistorySpeakerField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const characters = Array.from(trimmed)
  return characters.length > HISTORY_SPEAKER_MAX_CHARS
    ? characters.slice(0, HISTORY_SPEAKER_MAX_CHARS).join('').trim()
    : trimmed
}

/** 历史 sessionId：每次出席一条（会议 id + 成员 id）。不含冒号——冒号会触发后端双人合并。 */
export function meetingHistorySessionId(record: Pick<MeetingFinishedRecord, 'meetingId' | 'me'>): string {
  return `${record.meetingId}_${record.me.id}`.replace(/:/g, '_')
}

/** 本人在这次出席里的角色（抓取时的主持人；转交之后按转交后的算）。 */
export function meetingRecordRole(record: Pick<MeetingFinishedRecord, 'hostMemberId' | 'me'>): 'host' | 'member' {
  return record.hostMemberId === record.me.id ? 'host' : 'member'
}

/** 结束原因 → completionReason：正常收尾一律 client_stopped，具体原因放 settings.meeting.endReason。 */
export function meetingCompletionReason(reason: MeetingRecordReason): SessionCompletionReason {
  if (reason === 'checkpoint') return 'client_checkpoint'
  if (reason === 'revoked' || reason === 'discarded') return 'client_disconnected'
  return 'client_stopped'
}

const parsedTime = (value: string | undefined): number => (value ? Date.parse(value) : NaN)

/** ended 快照是怎么结束的：过了到期时间、闲置关闭，否则是别人结束的。 */
export function meetingEndedReason(snapshot: Pick<MeetingSnapshot, 'expiresAt' | 'idleCloseAt'>, now = Date.now()): MeetingExitReason {
  const expires = parsedTime(snapshot.expiresAt)
  if (Number.isFinite(expires) && expires <= now) return 'expired'
  const idle = parsedTime(snapshot.idleCloseAt)
  if (Number.isFinite(idle) && idle <= now) return 'idle'
  return 'ended_remote'
}

/**
 * 存档行 → 历史行，顺序与会中画面一致（meetingCaptionsForDisplay：合并同一句的片段、
 * 用预览补上最后一句），再按入会时间过滤、去空行、按 createdAt 稳定排序。
 */
export function meetingHistoryRows(record: MeetingFinishedRecord): MeetingHistoryRow[] {
  const joined = parsedTime(record.joinedAt)
  const meId = record.me.id
  const selfName = normalizeHistorySpeakerField(record.me.displayName)
  const candidates: Array<{ row: Omit<MeetingHistoryRow, 'id'>; time: number; index: number }> = []
  let lastTime = Number.NEGATIVE_INFINITY
  meetingCaptionsForDisplay(record.rows).forEach((caption, index) => {
    const created = parsedTime(caption.createdAt)
    if (Number.isFinite(joined) && Number.isFinite(created) && created < joined) return
    const self = caption.speakerId === meId
    const translations: Record<string, string> = {}
    let source: string
    if (self) {
      // 本人的行只以原文下发（speakerOnly）。不把原文塞进 translations：那会多出一个语言页签。
      source = (caption.sourceText || caption.text || '').trim()
    } else if (caption.sourceLanguage === caption.targetLanguage) {
      // 原文路由：text 就是原文。
      source = (caption.text || caption.sourceText || '').trim()
    } else {
      source = (caption.sourceText || '').trim()
      const text = (caption.text || '').trim()
      if (text !== '' && caption.targetLanguage) translations[caption.targetLanguage] = text
    }
    if (source === '' && Object.keys(translations).length === 0) return
    const speakerId = normalizeHistorySpeakerField(caption.speakerId)
    const speakerName = self ? selfName ?? normalizeHistorySpeakerField(caption.speakerName) : normalizeHistorySpeakerField(caption.speakerName)
    // 排序键：解析不了的时间沿用前一行的，保证比较是全序（稳定且不成环）。
    const time = Number.isFinite(created) ? created : lastTime
    lastTime = time
    candidates.push({
      index,
      time,
      row: {
        source,
        translations,
        createdAt: caption.createdAt,
        ...(Number.isFinite(created) && Number.isFinite(joined) ? { startMs: Math.max(0, Math.round(created - joined)) } : {}),
        ...(SOURCE_LANGUAGES.includes(caption.sourceLanguage) ? { sourceLanguage: caption.sourceLanguage as MeetingRowSourceLanguage } : {}),
        ...(speakerId === undefined ? {} : { speakerId }),
        ...(speakerName === undefined ? {} : { speakerName }),
        self,
      },
    })
  })
  candidates.sort((left, right) => (left.time - right.time) || (left.index - right.index))
  return candidates.map(({ row }, index) => ({ id: `m${index}`, ...row }))
}

/** 输出语言：本人当前目标语言打头，后面接中途换语言前留下的其它目标语言（按出现顺序）。 */
export function meetingTargetLanguages(record: MeetingFinishedRecord, rows: MeetingHistoryRow[]): string[] {
  const languages: string[] = []
  const push = (language: string | undefined) => {
    const code = (language || '').trim()
    if (code !== '' && !languages.includes(code)) languages.push(code)
  }
  push(record.me.targetLanguage)
  for (const row of rows) for (const language of Object.keys(row.translations)) push(language)
  return languages
}

/** 会话设置快照（≤8 KB）：scene=meeting、mode=solo，会议信息收在 settings.meeting 里。 */
export function meetingHistorySettings(
  record: MeetingFinishedRecord,
  targetLanguages: string[],
  options: MeetingClientInfo & { truncated?: boolean },
): MeetingSettings {
  const client: MeetingClientInfo = { platform: options.platform }
  const version = (options.version ?? '').trim()
  if (version !== '') client.version = version
  const buildSha = typeof options.buildSha === 'string' ? options.buildSha.trim() : ''
  if (buildSha !== '') client.buildSha = buildSha
  const truncated = options.truncated === true || record.truncated
  const settings: MeetingSettings = {
    client,
    mode: 'solo',
    scene: 'meeting',
    sourceLanguage: record.me.sourceLanguage,
    targetLanguages: [...targetLanguages],
    meeting: {
      code: record.code,
      memberId: record.me.id,
      role: meetingRecordRole(record),
      memberCount: Math.max(1, Math.round(record.memberCount) || 1),
      endReason: record.reason,
      ...(truncated ? { truncated: true } : {}),
    },
  }
  // 正常情况下远小于 8 KB；兜底只留主语言，绝不让后端以 invalid_settings 拒掉整条记录。
  if (utf8Length(JSON.stringify(settings)) > MEETING_SETTINGS_MAX_BYTES) settings.targetLanguages = targetLanguages.slice(0, 1)
  return settings
}

function limitCharacters(value: string, limit: number): string {
  let count = 0
  let end = 0
  for (const character of value) {
    if (count === limit) break
    count += 1
    end += character.length
  }
  return value.slice(0, end)
}

function translationTextOf(units: MeetingHistoryUnit[]): string {
  return limitCharacters(units.map(unit => unit.text).filter(Boolean).join('\n'), MEETING_TRANSLATION_TEXT_LIMIT)
}

function normalizedStartMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

export type MeetingPayload = {
  input: MeetingHistoryInput
  rows: MeetingHistoryRow[]
  targetLanguages: string[]
}

/**
 * 一次出席 → POST body + 实际保存的那些行（超过 240 KB 时从最早的行开始删，打上 truncated）。
 * 没有可保存的行时为 null（不存空记录）。逐句规则与 App 的 buildSaveHistoryInput 一致：
 * units[].text 取主语言译文、主语言为空时退到第一条非空译文；只有主语言一种、且就是 text 的行不写 translations。
 */
export function meetingPayload(record: MeetingFinishedRecord, client: MeetingClientInfo): MeetingPayload | null {
  const rows = meetingHistoryRows(record)
  if (rows.length === 0) return null
  const targetLanguages = meetingTargetLanguages(record, rows)
  const primary = targetLanguages[0] || ''
  const completionReason = meetingCompletionReason(record.reason)
  const durationMs = Math.max(0, parsedTime(record.endedAt) - parsedTime(record.joinedAt)) || 0
  const units = rows.map((row): MeetingHistoryUnit => {
    const translations = row.translations
    const text = translations[primary]
      || targetLanguages.map(language => translations[language]).find(Boolean)
      || Object.values(translations).find(Boolean)
      || ''
    const startMs = normalizedStartMs(row.startMs)
    const speakerId = normalizeHistorySpeakerField(row.speakerId)
    const speakerName = normalizeHistorySpeakerField(row.speakerName)
    const languages = Object.keys(translations)
    // 只有一种语言、而且就是主语言的行不写 translations：读回时退回 { 主语言: text }，省字节。
    const redundant = languages.length === 1 && languages[0] === primary && translations[primary] === text
    return {
      id: row.id,
      text,
      ...(row.source ? { source: row.source } : {}),
      ...(languages.length > 0 && !redundant ? { translations: { ...translations } } : {}),
      ...(startMs === undefined ? {} : { startMs }),
      ...(row.sourceLanguage ? { sourceLanguage: row.sourceLanguage } : {}),
      ...(speakerId === undefined ? {} : { speakerId }),
      ...(speakerName === undefined ? {} : { speakerName }),
    }
  })
  // 关联键用会议 id（字符集满足后端校验）；不覆盖的话 App 会落到上一场单人会话的 trace 上。
  const traceId = /^[A-Za-z0-9_-]{1,64}$/.test(record.meetingId) ? record.meetingId : undefined
  const build = (kept: MeetingHistoryUnit[], truncated: boolean): MeetingHistoryInput => ({
    sessionId: meetingHistorySessionId(record),
    provider: 'meeting',
    sourceLanguage: record.me.sourceLanguage,
    targetLanguage: primary,
    ...(targetLanguages.length > 0 ? { targetLanguages: [...targetLanguages] } : {}),
    mode: 'solo',
    durationMs: Math.max(0, Math.round(durationMs)),
    sourceText: '',
    translationText: translationTextOf(kept),
    units: kept,
    settings: meetingHistorySettings(record, targetLanguages, { ...client, truncated }),
    ...(traceId ? { traceId } : {}),
    completionReason,
    abnormalExit: !isNormalSessionEnd(completionReason),
  })
  let input = build(units, false)
  if (utf8Length(JSON.stringify(input)) > MEETING_HISTORY_MAX_BYTES) {
    // 从最早的行开始删，直到整份 body 放得下；打上 truncated。
    input = build(units, true)
    const unitBytes = input.units.map(unit => utf8Length(JSON.stringify(unit)) + 1)
    const fixed = utf8Length(JSON.stringify({ ...input, units: [], translationText: '' }))
      + utf8Length(JSON.stringify(input.translationText))
    let total = fixed + unitBytes.reduce((sum, bytes) => sum + bytes, 0)
    let drop = 0
    while (drop < input.units.length - 1 && total > MEETING_HISTORY_MAX_BYTES) total -= unitBytes[drop++]
    input = build(input.units.slice(drop), true)
    while (input.units.length > 1 && utf8Length(JSON.stringify(input)) > MEETING_HISTORY_MAX_BYTES) {
      input = build(input.units.slice(1), true)
    }
  }
  const kept = new Set(input.units.map(unit => unit.id))
  return { input, rows: rows.filter(row => kept.has(row.id)), targetLanguages }
}

/** POST body（终稿或检查点）；没有可保存的行时为 null。 */
export function buildMeetingHistoryInput(record: MeetingFinishedRecord, options: MeetingClientInfo & { checkpoint?: boolean }): MeetingHistoryInput | null {
  const { checkpoint, ...client } = options
  const effective = checkpoint ? { ...record, reason: 'checkpoint' as const } : record
  return meetingPayload(effective, client)?.input ?? null
}

/** 检查点去重用：存档没变（行数、最大 revision、文字量、目标语言都没变）就不再发。 */
export function meetingRecordSignature(record: MeetingFinishedRecord): string {
  let revision = 0
  let characters = 0
  for (const row of record.rows) {
    if (row.revision > revision) revision = row.revision
    characters += (row.text?.length ?? 0) + (row.sourceText?.length ?? 0)
  }
  return `${meetingHistorySessionId(record)}:${record.rows.length}:${revision}:${characters}:${record.me.targetLanguage}`
}

/**
 * 会议结束 / 离会后的状态句。`saved` 只在保存真的有了结果时传 true；游客、空会议、还没存完或没存成都只说前半句。
 */
export function meetingEndedNotice(record: Pick<MeetingFinishedRecord, 'reason'>, saved: boolean): string {
  const left = record.reason === 'left' || record.reason === 'revoked'
  const head = left ? '已离开会议' : '会议已结束'
  return saved ? `${head}，记录已存入历史` : head
}

/** 会议记录设置快照里的本人成员 id（settings.meeting.memberId）；不是会议记录时为空串。 */
export function meetingSelfMemberId(settings: unknown): string {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return ''
  const meeting = (settings as Record<string, unknown>).meeting
  if (!meeting || typeof meeting !== 'object' || Array.isArray(meeting)) return ''
  const memberId = (meeting as Record<string, unknown>).memberId
  return typeof memberId === 'string' ? memberId.trim() : ''
}

/**
 * 历史列表里的一条记录是不是这场进行中会议、本人这次出席的**会中检查点**（列表里是「会话恢复记录」）。
 * 会议进行中时历史页顶上已经钉着「进行中」卡，这条检查点就是同一场会议的半截，先不列；会议结束后终稿覆盖它，
 * 照常列出。只认 settings.meeting 的 memberId + code + endReason 'checkpoint' 三项都对得上的那一条。
 */
export function isOngoingMeetingCheckpoint(settings: unknown, meeting: { memberId: string; code: string }): boolean {
  if (!meeting.memberId || meetingSelfMemberId(settings) !== meeting.memberId) return false
  const record = (settings as { meeting: Record<string, unknown> }).meeting
  return record.code === meeting.code && record.endReason === 'checkpoint'
}

/** 一次出席的身份与入会时的约定（入会成功时定下，之后不变）。 */
export type MeetingAttendance = {
  meetingId: string
  memberId: string
  /** 入会时的登录账号；游客为 null。 */
  accountId: string | null
  /** 本机拿到入会结果的时刻（服务端的 joinedAt 解析不了时用它）。 */
  startedAt: string
  /** 入会时服务端声明支持会议记录（且这一端打算存）。 */
  recordable: boolean
  baseURL: string
}

/**
 * 一次出席的整场字幕存档（与会中画面分开：画面只留 300 行，存档留 MEETING_ARCHIVE_LIMIT 行）。
 * 收快照（accept）→ 会中检查点（peek）→ 结束时抓一次终稿（finish，之后不再出记录）。
 * App（NativeMeetingSession）与 Web（useMeeting）按同一套规则抓行。
 */
export class MeetingAttendanceArchive {
  readonly attendance: MeetingAttendance
  private history = new MeetingCaptionHistory({ limit: MEETING_ARCHIVE_LIMIT })
  private rows: MeetingTranscript[] = []
  private truncated = false
  private seenMembers = new Set<string>()
  private snapshot: MeetingSnapshot | null = null
  private done = false

  constructor(attendance: MeetingAttendance) {
    this.attendance = { ...attendance }
  }

  /** 已经抓过终稿（或只抓不存地丢弃了）。 */
  get finished(): boolean {
    return this.done
  }

  /** 收一份快照：只收本场；修订号倒退的旧快照不收；抓过终稿之后不再收。 */
  accept(snapshot: MeetingSnapshot): void {
    if (this.done || snapshot.id !== this.attendance.meetingId) return
    if (this.snapshot && snapshot.revision < this.snapshot.revision) return
    this.rows = this.history.update(snapshot)
    if (this.rows.length >= MEETING_ARCHIVE_LIMIT) this.truncated = true
    for (const member of [snapshot.me, ...(snapshot.members || [])]) if (member?.id) this.seenMembers.add(member.id)
    this.snapshot = snapshot
  }

  /** 会中检查点；已抓过终稿、会议不在进行中，或快照里的「我」不是这次出席时为 null。 */
  peek(now = new Date()): MeetingFinishedRecord | null {
    const snapshot = this.snapshot
    if (this.done || !snapshot || snapshot.status !== 'active' || snapshot.me.id !== this.attendance.memberId) return null
    return this.record(snapshot, 'checkpoint', now)
  }

  /** 终稿：每次出席只抓一次（之后再调返回 null）。还没收到过本人快照时为 null。 */
  finish(reason: MeetingExitReason, now = new Date()): MeetingFinishedRecord | null {
    if (this.done) return null
    this.done = true
    const snapshot = this.snapshot
    if (!snapshot || snapshot.me.id !== this.attendance.memberId) return null
    return this.record(snapshot, reason, now)
  }

  private record(snapshot: MeetingSnapshot, reason: MeetingRecordReason, now: Date): MeetingFinishedRecord {
    const joined = parsedTime(snapshot.me.joinedAt)
    return {
      meetingId: snapshot.id,
      code: snapshot.code,
      me: snapshot.me,
      hostMemberId: snapshot.hostMemberId,
      memberCount: Math.max(1, this.seenMembers.size),
      rows: [...this.rows],
      joinedAt: Number.isFinite(joined) ? new Date(joined).toISOString() : this.attendance.startedAt,
      endedAt: now.toISOString(),
      reason,
      accountId: this.attendance.accountId,
      truncated: this.truncated,
      baseURL: this.attendance.baseURL,
      recordable: this.attendance.recordable,
    }
  }
}
