// 记录（历史 / 分享）→ 结束页视图数据。历史详情与分享页都用它把 units 变成结束页的行 / 气泡。
import { historyScene } from '@simultrans/core/historyTitle'
import { sessionRecoveryNotice, sessionTimeLimitNotice } from './sessionRecovery'
import type { ConsumerHistoryRecord, ConsumerHistoryUnit } from './consumerHistory'
import type { DuoShowcaseBubble, MultilingualShowcaseRow } from './multilingualShowcase'
import type { FinishedSessionData, MeetingFinishedRow } from '../components/FinishedSessionView'

/**
 * 会议记录（scene=meeting）逐句多带的字段：原文语言、说话人。成员 id 只在本人的历史详情里有
 * （本人那几句 = settings.meeting.memberId）；公开分享页（consumer_share.go publicMeetingRecord）
 * 去掉成员 id，改用 self 标出分享者本人说的那几句（公开页每句都带 self，本人的记录没有这个字段）。
 * speakerKey 是公开页上代替成员 id 的记录内序号（如 s1、s2，不泄露成员 id），后端给了就用它区分
 * 同名的两个人；没给时只能按显示名区分。
 */
export type MeetingHistoryUnitFields = {
  sourceLanguage?: string
  speakerId?: string
  speakerKey?: string
  speakerName?: string
  self?: boolean
}

/** 只认非空字符串（读回的 JSON 可能是别的类型）。 */
function nonEmptyText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export type SharedSessionRow = {
  id: string
  source: string
  translations: Record<string, string>
  layoutLanguage?: string
  side?: 'a' | 'b'
  startMs?: number
  outputAudioStarts?: Record<string, number>
  outputAudioEnds?: Record<string, number>
  /** 会议记录：这一句的原文语言与说话人（见 MeetingHistoryUnitFields）。 */
  sourceLanguage?: string
  speakerId?: string
  speakerKey?: string
  speakerName?: string
  self?: boolean
}

// 逐句配对：sourceText 按 "\n" 分句（LiveScreen.tsx 按句 join），units[i].text 为
// targetLanguage 对应的第 i 句译文；units 为空时回退按 translationText 分句。
export function buildSharedSessionRows(record: ConsumerHistoryRecord): SharedSessionRow[] {
  const sources = record.sourceText ? record.sourceText.split('\n') : []
  const units = Array.isArray(record.units) ? record.units : []
  const hasUnitTranslations = units.some(unit => unit.text?.trim() || Object.values(unit.translations || {}).some(text => text.trim()))
  const fallbackTranslations = !hasUnitTranslations && record.translationText
    ? record.translationText.split('\n')
    : []
  const count = Math.max(sources.length, units.length, fallbackTranslations.length)
  const rows: SharedSessionRow[] = []
  for (let index = 0; index < count; index += 1) {
    const unit = units[index] as (ConsumerHistoryUnit & MeetingHistoryUnitFields) | undefined
    const source = (unit?.source || sources[index] || '').trim()
    const fallback = (unit?.text?.trim() || fallbackTranslations[index] || '').trim()
    const translations = unit?.translations && Object.values(unit.translations).some(text => text.trim())
      ? unit.translations
      : fallback ? { [record.targetLanguage]: fallback } : {}
    if (!source && !Object.values(translations).some(Boolean)) continue
    const sourceLanguage = nonEmptyText(unit?.sourceLanguage)
    const speakerId = nonEmptyText(unit?.speakerId)
    const speakerKey = nonEmptyText(unit?.speakerKey)
    const speakerName = nonEmptyText(unit?.speakerName)
    rows.push({
      id: unit?.id || `share-row-${index}`,
      source,
      translations,
      ...(unit?.layoutLanguage ? { layoutLanguage: unit.layoutLanguage } : {}),
      ...(unit?.side ? { side: unit.side } : {}),
      ...(typeof unit?.startMs === 'number' ? { startMs: unit.startMs } : {}),
      ...(unit?.outputAudioStarts ? { outputAudioStarts: unit.outputAudioStarts } : {}),
      ...(unit?.outputAudioEnds ? { outputAudioEnds: unit.outputAudioEnds } : {}),
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(speakerKey ? { speakerKey } : {}),
      ...(speakerName ? { speakerName } : {}),
      ...(unit?.self === true ? { self: true } : {}),
    })
  }
  return rows
}

/** 会议记录设置快照里的本人成员 id（settings.meeting.memberId）；公开分享页没有设置快照，为空。 */
export function meetingSelfMemberId(settings: unknown): string {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return ''
  const meeting = (settings as Record<string, unknown>).meeting
  if (!meeting || typeof meeting !== 'object' || Array.isArray(meeting)) return ''
  return nonEmptyText((meeting as Record<string, unknown>).memberId)
}

/** 只有成员 id、没有显示名的那句显示成「参会者」（与 App historyRows.ts MEETING_UNNAMED_SPEAKER 同字）。 */
export const MEETING_UNNAMED_SPEAKER = '参会者'

/**
 * 占位名：没有显示名（上面的「参会者」），或公开分享页上后端把像联系方式的名字换成的「参会者」「参会者1」…
 * （consumer_share.go publicMeetingSpeakerNames）。占位名的头像画人形，不取「会」字。
 */
const MEETING_PLACEHOLDER_SPEAKER = /^参会者\d*$/

/**
 * 会议记录 → 一条按时间排的列表，与 App 的会议记录同一套读法（mobile/src/session/historyRows.ts）：
 * - 不出语言页签：每行只存它自己那一路（中途换过输出语言就是两种），按行取有字的那一路；
 *   本人那句只有原文，译文为空、只显示原文。他人与我同语种时译文就是原文，也只显示一次。
 * - 说话人标签只在换人的那一行出（第一行一定出）；本人那几句在历史详情里按成员 id 认出，
 *   在公开分享页按后端给的 self 认出。行上一个说话人字段都没有时不出标签，也不打断前后的比较。
 * - speakerIdsStripped（公开分享页）：成员 id 被去掉了，分不清「这句没有说话人」和「说话人没有显示名」，
 *   没名字的那句按「参会者」另起一段，而不是记到上一位发言人名下。
 */
export function meetingFinishedRows(rows: readonly SharedSessionRow[], selfMemberId: string, fallbackLanguage: string, speakerIdsStripped = false): MeetingFinishedRow[] {
  let previous = ''
  return rows.map((row) => {
    const entries = Object.entries(row.translations)
    const language = entries.find(([, text]) => typeof text === 'string' && text.trim() !== '')?.[0]
      ?? entries[0]?.[0]
      ?? fallbackLanguage
    const translation = (row.translations[language] || '').trim()
    const shown = translation !== '' && translation !== row.source.trim() ? row.translations[language] : ''
    const self = row.self === true || (selfMemberId !== '' && row.speakerId === selfMemberId)
    const name = row.speakerName || ''
    const key = row.speakerId ? `id:${row.speakerId}`
      : row.speakerKey ? `key:${row.speakerKey}`
        : name ? `name:${self ? 'self:' : ''}${name}`
          : self ? 'self'
            : speakerIdsStripped ? 'unnamed' : ''
    const changed = key !== '' && key !== previous
    if (key !== '') previous = key
    return {
      id: row.id,
      source: row.source,
      startMs: row.startMs ?? 0,
      committed: true,
      translations: shown ? { [language]: shown } : {},
      outputAudioStarts: {},
      outputAudioEnds: {},
      language,
      ...(row.sourceLanguage ? { sourceLanguage: row.sourceLanguage } : {}),
      speakerKey: key,
      speaker: changed ? { name: name || MEETING_UNNAMED_SPEAKER, self, placeholder: !name || MEETING_PLACEHOLDER_SPEAKER.test(name) } : null,
    }
  })
}

/** 记录 → 结束页视图数据：单人按主语言分组的行，双人按甲/乙的气泡。 */
export function finishedSessionDataFromRecord(record: ConsumerHistoryRecord): FinishedSessionData {
  const shared = buildSharedSessionRows(record)
  const hasSource = shared.some(row => Boolean(row.source.trim()))
  const hasTranslation = shared.some(row => Object.values(row.translations).some(text => Boolean(text.trim())))
  const recoveryNotice = sessionRecoveryNotice(record.abnormalExit, record.completionReason, hasSource, hasTranslation)
  const infoNotice = !record.abnormalExit && record.completionReason === 'session_time_limit' ? sessionTimeLimitNotice : undefined
  const sessionIds = record.sessionId.split(':').map((id) => id.trim()).filter(Boolean)
  if (historyScene(record) === 'meeting') {
    // 会议记录没有音频（会中只存文字），也没有甲 / 乙之分：一条列表 + 逐句说话人。
    // 公开分享页的会议记录每句都带 self（布尔），本人的记录没有：据此知道成员 id 已被去掉。
    const speakerIdsStripped = (Array.isArray(record.units) ? record.units : []).some((unit) => typeof (unit as MeetingHistoryUnitFields).self === 'boolean')
    const meetingRows = meetingFinishedRows(shared, meetingSelfMemberId(record.settings), record.targetLanguage, speakerIdsStripped)
    const targetLanguages = [...new Set(meetingRows.filter(row => Object.keys(row.translations).length > 0).map(row => row.language))]
    return {
      historyId: record.id,
      title: record.title,
      titleStatus: record.titleStatus,
      scene: record.scene,
      settings: record.settings,
      recoveryNotice,
      infoNotice,
      sessionIds,
      mode: 'solo',
      durationMs: record.durationMs,
      createdAt: record.createdAt,
      targetLanguages: targetLanguages.length > 0 ? targetLanguages : [record.targetLanguage].filter(Boolean),
      rowsByPrimaryLanguage: {},
      meetingRows,
      meetingSpeakerCount: new Set(meetingRows.map(row => row.speakerKey).filter(Boolean)).size,
    }
  }
  const toRow = (row: SharedSessionRow): MultilingualShowcaseRow => ({
    id: row.id,
    source: row.source,
    startMs: row.startMs ?? 0,
    committed: true,
    translations: row.translations,
    outputAudioStarts: row.outputAudioStarts || {},
    outputAudioEnds: row.outputAudioEnds || {},
  })
  const conversation = historyScene(record) === 'conversation'
  const duo = !conversation && (record.mode === 'duo' || record.settings?.mode === 'duo' || sessionIds.length > 1 || shared.some((row) => Boolean(row.side)))
  const languagesOf = (rows: SharedSessionRow[]) => [...new Set([
    ...(duo ? [] : [record.targetLanguage]),
    ...rows.flatMap((row) => Object.keys(row.translations)),
  ].filter(Boolean))]
  if (duo) {
    const bubbles: DuoShowcaseBubble[] = shared.filter((row) => row.side).map((row) => ({
      ...toRow(row),
      layoutLanguage: row.layoutLanguage,
      side: row.side as 'a' | 'b',
      sourceLanguage: record.sourceLanguage,
      targetLanguages: Object.keys(row.translations),
    }))
    const leftTargetLanguages = languagesOf(shared.filter((row) => row.side === 'a'))
    const rightTargetLanguages = languagesOf(shared.filter((row) => row.side === 'b'))
    return {
      historyId: record.id,
      title: record.title,
      titleStatus: record.titleStatus,
      scene: record.scene,
      settings: record.settings,
      recoveryNotice,
      infoNotice,
      sessionIds,
      mode: 'duo',
      durationMs: record.durationMs,
      createdAt: record.createdAt,
      targetLanguages: [...new Set([...leftTargetLanguages, ...rightTargetLanguages])],
      rowsByPrimaryLanguage: {},
      bubbles,
      unassignedRows: shared.filter(row => !row.side).map(toRow),
      leftTargetLanguages,
      rightTargetLanguages,
    }
  }
  const targetLanguages = languagesOf(shared)
  if (targetLanguages.length === 0 && hasSource) targetLanguages.push(record.sourceLanguage || 'auto')
  const rowsByPrimaryLanguage = Object.fromEntries(targetLanguages.map((language) => [
    language,
    shared.filter(row => {
      if (row.layoutLanguage) return row.layoutLanguage === language
      if (row.translations[language]?.trim()) return true
      return language === targetLanguages[0] && Boolean(row.source) && !Object.values(row.translations).some(text => text.trim())
    }).map(toRow),
  ]))
  return {
    historyId: record.id,
    title: record.title,
    titleStatus: record.titleStatus,
    scene: record.scene,
    settings: record.settings,
    recoveryNotice,
    infoNotice,
    sessionIds,
    mode: 'solo',
    durationMs: record.durationMs,
    createdAt: record.createdAt,
    targetLanguages: targetLanguages.filter((language) => (rowsByPrimaryLanguage[language] || []).length > 0),
    rowsByPrimaryLanguage,
  }
}
