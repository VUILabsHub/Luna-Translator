// 结束页视图（docs/history-detail-finished-view-plan.md）：历史详情复用结束页的外壳与行组件——
// 左上「‹ 返回」、右上「分享」、概要行、语言页签、逐句原文/译文与点赞点踩、底部动态背景；
// 底部可追加「会话音频」「会话设置」等折叠栏。单人按主语言页签切换行，双人按甲/乙分组；
// 会议记录不出页签，一条列表逐句标说话人（与 App 的会议记录同一套读法）。
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { historyScene } from '@simultrans/core/historyTitle'
import { PROFILE_AVATAR_GRADIENT, profileAvatarText } from '@simultrans/core/profile'
import {
  CompletedLanguageSwitch,
  ConsumerSessionShare,
  ShowcaseFrame,
  ShowcaseTranslationList,
  SoloTranscriptRow,
  chineseLanguageNames,
  formatShowcaseDuration,
  languageNames,
  readShowcaseFontSize,
  useArchivedAudioPlayback,
  useTranscriptFollow,
} from '../pages/MultilingualShowcasePage'
import { translatedPlaybackRange, resolveFinishedArchive } from '../lib/finishedAudioPlayback'
import { moveLeadingTranslationPunctuation } from '../lib/showcasePunctuation'
import { selectDuoLanguageLayouts, showcaseAudioEndMs } from '../lib/multilingualShowcase'
import { SentenceFeedback, useSentenceFeedback } from './SentenceFeedback'
import { SessionAudioDownloads } from './SessionAudioDownloads'
import { SessionShareDialog } from './SessionShareDialog'
import { ShowcaseConfirmDialog } from './ShowcaseConfirmDialog'
import { SentencePlaybackIcon } from './SentencePlaybackIcon'
import { ShowcaseTypewriterText } from './ShowcaseTypewriterText'
import type { DuoShowcaseBubble, MultilingualShowcaseRow } from '../lib/multilingualShowcase'
import type { HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { HistorySessionSummary } from './HistorySessionSummary'
import { useHistoryTitle } from '../hooks/useHistoryTitle'
import { createConsumerShareLink, type ConsumerHistoryTitle } from '../lib/consumerHistory'
import type { SessionSettings } from '../lib/sessionSettings'
import { asrDisplayText } from '../lib/showcaseTranscript'
import { conversationHistoryRowSessionId } from '../lib/conversationAudio'

export type FinishedSessionData = ConsumerHistoryTitle & {
  settings?: SessionSettings
  historyId: string
  recoveryNotice?: string
  infoNotice?: string
  unassignedRows?: MultilingualShowcaseRow[]
  /** 单人一个，双人 [甲, 乙]。 */
  sessionIds: string[]
  mode: 'solo' | 'duo'
  durationMs?: number
  createdAt?: string
  targetLanguages: string[]
  /** 单人：按主语言分组的行（每种语言各自的分段）。 */
  rowsByPrimaryLanguage: Record<string, MultilingualShowcaseRow[]>
  /** 双人：气泡（带 side）。 */
  bubbles?: DuoShowcaseBubble[]
  leftTargetLanguages?: string[]
  rightTargetLanguages?: string[]
  /** 会议记录（scene=meeting）：一条按时间排的列表，每行只显示它自己那一路；有它时不走页签。 */
  meetingRows?: MeetingFinishedRow[]
  /** 会议记录里一共有几位发言人（按说话人去重；没有说话人字段的行不计）。 */
  meetingSpeakerCount?: number
}

/**
 * 会议记录的说话人标签：只在换人的那一行有；self = 本人（历史详情）/ 分享者（公开分享页）说的；
 * placeholder = 名字是「参会者」这类占位名（没有显示名，或分享页隐去了像联系方式的名字），头像画人形。
 */
export type MeetingSpeakerMark = { name: string; self: boolean; placeholder: boolean }

export type MeetingFinishedRow = MultilingualShowcaseRow & {
  /** 这一行显示的那一路语言；本人那句只有原文时是记录的主语言（译文为空）。 */
  language: string
  sourceLanguage?: string
  /** 说话人比较用的键（成员 id 优先，其次分享页的记录内序号，再按名字）；没有说话人字段时为空串。 */
  speakerKey: string
  speaker: MeetingSpeakerMark | null
}

/** 会议记录分享前的提醒（2026-10-21 决策：分享页保留各句的说话人显示名）。 */
export const MEETING_SHARE_WARNING = '分享内容包含其他参会者的发言和显示名，获得链接的人都能看到。'

const noop = () => undefined

function formatRecordedAt(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function FinishedSessionView({
  data,
  archives,
  backHref,
  readOnly = false,
  extra,
  footer,
}: {
  data: FinishedSessionData
  /** 每个 sessionId 的音频归档；null = 还在加载或没有音频。 */
  archives: Record<string, HistoryAudioArchive> | null
  /** 左上返回链接；缺省（只读分享页）不显示返回。 */
  backHref?: string
  /** 只读（分享页）：不显示分享按钮与点赞点踩。 */
  readOnly?: boolean
  /** 译文区下方的追加内容（折叠栏）。 */
  extra?: ReactNode
  /** 滚动区外的分享页底部入口。 */
  footer?: ReactNode
}) {
  const title = useHistoryTitle(data.historyId, data, !readOnly)
  const meeting = historyScene(data) === 'meeting'
  // 会议同传记录可以分享（2026-10-21 决策；Canary 候选后端不再 403，prod/test 后端仍回 403 meeting_share_disabled，
  // 会议也只在 Canary 有）：生成链接前先确认，
  // 提醒分享内容含其他参会者的发言和显示名。逐句赞踩仍不收（会议记录的 sessionId 不是 cs- 签发会话，
  // 赞踩会退到匿名 /api/feedback/web）。只读分享页两样都没有。
  const canShare = !readOnly && (!meeting || data.historyId !== '')
  const canRate = !readOnly && !meeting
  const playback = useArchivedAudioPlayback()
  const capture = playback.capture
  useEffect(() => {
    if (!archives) return
    for (const [sessionId, archive] of Object.entries(archives)) {
      const side = sessionId === data.sessionIds[0] ? 'a' : 'b'
      const languages = data.mode === 'duo'
        ? [...new Set((data.bubbles || []).filter(b => b.side === side).flatMap(b => b.targetLanguages))]
        : data.targetLanguages
      capture({ id: sessionId }, resolveFinishedArchive(archive, languages))
    }
  }, [archives, capture, data])
  const fontSize = useMemo(readShowcaseFontSize, [])
  const summaryLanguages = data.targetLanguages.map((language) => chineseLanguageNames[language] || languageNames[language] || language).join(' / ')
  const recordedAt = formatRecordedAt(data.createdAt)
  // 会议记录的摘要与 App 一样多写发言人数。
  const speakers = meeting && data.meetingSpeakerCount ? ` · 发言人 ${data.meetingSpeakerCount} 位` : ''
  const summary = (
    <HistorySessionSummary context={{ ...data, ...title }} duration={typeof data.durationMs === 'number' ? formatShowcaseDuration(data.durationMs) : undefined}>
      输出语言 {summaryLanguages}{speakers}{recordedAt ? ` · ${recordedAt}` : ''}
    </HistorySessionSummary>
  )
  const frameProps = {
    status: 'finished' as const,
    fontSize,
    paused: false,
    muted: false,
    busy: false,
    restoreHeader: false,
    settings: null,
    notice: data.recoveryNotice || '',
    infoNotice: data.infoNotice,
    welcomeTitle: '',
    welcomeSubtitle: '',
    hasContent: true,
    controlDisabled: true,
    pauseDisabled: true,
    onModeChange: noop,
    onControl: noop,
    onMute: noop,
    onPause: noop,
    onComplete: noop,
    finished: true,
    backHref,
    backHidden: !backHref,
    footerAction: !canShare ? undefined
      : meeting ? <MeetingRecordShare historyId={data.historyId} />
        : <ConsumerSessionShare historyId={data.historyId} sessionId={data.sessionIds.join(':')} saving={false} onResolved={noop} />,
  }
  // 会议记录没有音频（会中只存文字），不出「完整音频」卡。
  if (data.meetingRows) return <MeetingFinished rows={data.meetingRows} summary={summary} frameProps={frameProps} extra={extra} footer={footer} publicShare={readOnly} />
  return data.mode === 'duo'
    ? <DuoFinished data={data} playback={playback} summary={summary} frameProps={frameProps} extra={<><SessionAudioDownloads archives={archives === null ? null : playback.archives} sessionIds={data.sessionIds} playingKey={playback.playingKey} onPlay={playback.stop} />{extra}</>} footer={footer} readOnly={!canRate} />
    : <SoloFinished data={data} playback={playback} summary={summary} frameProps={frameProps} extra={<><SessionAudioDownloads archives={archives === null ? null : playback.archives} sessionIds={data.sessionIds} playingKey={playback.playingKey} onPlay={playback.stop} />{extra}</>} footer={footer} readOnly={!canRate} />
}

/**
 * 会议记录的「分享」：会议记录的分享页保留各句的说话人显示名，生成链接前先确认（MEETING_SHARE_WARNING）。
 * 本页确认过、拿到链接之后再点直接开分享面板，不重复确认。同一条记录后端只保留一个有效链接（复用）。
 */
function MeetingRecordShare({ historyId }: { historyId: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    setShareUrl('')
    setNotice('')
  }, [historyId])
  const open = () => {
    if (sharing) return
    setNotice('')
    if (shareUrl) setDialogOpen(true)
    else setConfirmOpen(true)
  }
  const share = async () => {
    setConfirmOpen(false)
    if (sharing) return
    setSharing(true)
    try {
      const { url } = await createConsumerShareLink(historyId, window.location.origin)
      setShareUrl(url)
      setDialogOpen(true)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '无法生成分享链接。')
    } finally {
      setSharing(false)
    }
  }
  return (
    <div className="showcase-session-share">
      <ShowcaseConfirmDialog
        open={confirmOpen}
        title="分享会议记录？"
        titleId="meeting-record-share-title"
        onDismiss={() => setConfirmOpen(false)}
        actions={[
          { label: '取消', onClick: () => setConfirmOpen(false) },
          { label: '继续分享', primary: true, onClick: () => { void share() } },
        ]}
      >
        <p className="showcase-confirm-dialog__lead">{MEETING_SHARE_WARNING}</p>
      </ShowcaseConfirmDialog>
      <SessionShareDialog meeting link={dialogOpen && shareUrl ? { token: shareUrl.split('/').pop() || '', url: shareUrl } : undefined} onClose={() => setDialogOpen(false)} />
      <button type="button" aria-label="点击分享" aria-haspopup="dialog" aria-busy={sharing} disabled={sharing} onClick={open}>
        {!sharing && <img src="/showcase/share.svg" alt="" aria-hidden="true" />}
        {sharing ? '生成中…' : '分享'}
      </button>
      {notice && <span className="showcase-session-share-toast" role="status">{notice}</span>}
    </div>
  )
}

// 说话人标签（App MeetingSpeakerLabel，289:3293「头像 + 文本」）：20 圆头像 + 名字，间距 4。头像是 Canary 绿渐变上的
// 反白字，取字规则与资料头像同一份（profileAvatarText，20 档只取一个字）；取不到字或是占位名时画人形。
// 「发言人：」只给读屏（<p> 不能用 aria-label 命名），视觉上只有头像和名字。
const visuallyHiddenStyle: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }
const speakerLabelStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.04rem', maxWidth: '100%', margin: 0, color: 'rgba(10, 15, 10, 0.55)', font: '600 0.14rem/0.2rem "Songti SC", "Noto Serif SC Variable", serif' }
const speakerAvatarStyle: CSSProperties = { display: 'grid', placeItems: 'center', flex: 'none', width: '0.2rem', height: '0.2rem', borderRadius: '50%', overflow: 'hidden', color: '#F8FAF8', background: PROFILE_AVATAR_GRADIENT, font: '700 0.12rem/0.16rem "Songti SC", "Noto Serif SC Variable", serif' }
const speakerNameStyle: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const meetingTurnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.08rem' }

/**
 * 历史详情（本人）：本人那几句写「我」；公开分享页：写分享者的显示名并标「（分享者）」——看链接的人不是「我」。
 * 头像仍按说话人的显示名取字。
 */
export function meetingSpeakerLabelText(speaker: MeetingSpeakerMark, publicShare: boolean) {
  if (!speaker.self) return speaker.name
  return publicShare ? `${speaker.name}（分享者）` : '我'
}

function MeetingSpeakerLabel({ speaker, publicShare }: { speaker: MeetingSpeakerMark; publicShare: boolean }) {
  const shown = meetingSpeakerLabelText(speaker, publicShare)
  const initial = speaker.placeholder ? null : profileAvatarText(speaker.name, 1)
  return (
    <p className="showcase-meeting-speaker" style={speakerLabelStyle}>
      <span className="showcase-meeting-speaker-avatar" style={speakerAvatarStyle} aria-hidden="true">
        {initial ?? (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="4.5" r="3.5" /><path d="M1 16a7 7 0 0 1 14 0z" /></svg>
        )}
      </span>
      <span style={visuallyHiddenStyle}>发言人：</span>
      <span className="showcase-meeting-speaker-name" style={speakerNameStyle} dir="auto">{shown}</span>
    </p>
  )
}

function MeetingFinished({ rows, summary, frameProps, extra, footer, publicShare }: { rows: MeetingFinishedRow[]; summary: ReactNode; frameProps: FrameProps; extra?: ReactNode; footer?: ReactNode; publicShare: boolean }) {
  const follow = useTranscriptFollow(rows.length, false)
  return (
    <ShowcaseFrame
      {...frameProps}
      mode="solo"
      toolbar={(
        <div className="showcase-language-rail showcase-language-rail--completed showcase-language-rail--finished" aria-label="输出语言">
          {summary}
        </div>
      )}
    >
      <div className="realtime-showcase-transcript showcase-multilingual-transcript showcase-multilingual-transcript--completed showcase-multilingual-transcript--finished showcase-meeting-record-transcript" ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
        <div className="realtime-showcase-transcript-track">
          {/* 不做跨行的行首标点挪移（moveLeadingTranslationPunctuation）：相邻两行可能是不同的人。 */}
          {rows.map((row) => (
            <div key={row.id} className="showcase-meeting-turn" style={meetingTurnStyle}>
              {row.speaker && <MeetingSpeakerLabel speaker={row.speaker} publicShare={publicShare} />}
              {/* 与单人历史行同一套样式（原文 + 这一路译文），但没有音频可播、不收赞踩，所以不出页脚；
                  本人那句只有原文，不出「…」占位的译文行。 */}
              <article className="showcase-multilingual-row showcase-multilingual-row--history" data-showcase-row-id={row.id}>
                <p className="realtime-showcase-source" lang={row.sourceLanguage} dir="auto">
                  <ShowcaseTypewriterText text={asrDisplayText(row.source)} enabled={false} onProgress={follow.onTextProgress} />
                </p>
                {Boolean(row.translations[row.language]?.trim()) && (
                  <ShowcaseTranslationList
                    translations={row.translations}
                    targetLanguages={[row.language]}
                    primaryLanguage={row.language}
                    featured={false}
                    terminal
                    solo
                    chips={false}
                    primaryOnly
                    onPrimaryLanguage={noop}
                    typewriterEnabled={false}
                    onTextProgress={follow.onTextProgress}
                  />
                )}
              </article>
            </div>
          ))}
          {rows.length === 0 && <p className="showcase-finished-empty-title">本次没有识别到语音</p>}
          {extra && <div className="showcase-finished-extras">{extra}</div>}
        </div>
      </div>
      {footer && <div className="showcase-finished-footer">{footer}</div>}
    </ShowcaseFrame>
  )
}

type Playback = ReturnType<typeof useArchivedAudioPlayback>
type FrameProps = Omit<Parameters<typeof ShowcaseFrame>[0], 'mode' | 'toolbar' | 'children'>

function FinishedTranscriptRow({ sessionId, ...props }: Omit<Parameters<typeof SoloTranscriptRow>[0], 'feedback'> & { sessionId: string }) {
  // A conversation can have more than two turns; feedback must reference the
  // same allowlisted real turn as that row's audio, rather than its first turn.
  const feedback = useSentenceFeedback(sessionId)
  return <SoloTranscriptRow {...props} feedback={feedback} />
}

function SoloFinished({ data, playback, summary, frameProps, extra, footer, readOnly }: { data: FinishedSessionData; playback: Playback; summary: ReactNode; frameProps: FrameProps; extra?: ReactNode; footer?: ReactNode; readOnly: boolean }) {
  const languages = data.targetLanguages
  const [primaryLanguage, setPrimaryLanguage] = useState(languages[0] || '')
  useEffect(() => {
    if (!languages.includes(primaryLanguage)) setPrimaryLanguage(languages[0] || '')
  }, [languages, primaryLanguage])
  const rows = data.rowsByPrimaryLanguage[primaryLanguage] || []
  const sessionId = data.sessionIds[0] || ''
  const follow = useTranscriptFollow(rows.length, false)
  return (
    <ShowcaseFrame
      {...frameProps}
      mode="solo"
      toolbar={(
        <div className="showcase-language-rail showcase-language-rail--completed showcase-language-rail--finished" aria-label="输出语言">
          {summary}
          <CompletedLanguageSwitch groups={[{ languages, value: primaryLanguage, onChange: setPrimaryLanguage }]} />
        </div>
      )}
    >
      <div className="realtime-showcase-transcript showcase-multilingual-transcript showcase-multilingual-transcript--completed showcase-multilingual-transcript--finished" {...follow.playbackGesture} ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
        <div className="realtime-showcase-transcript-track">
          {moveLeadingTranslationPunctuation(rows).map((row, rowIndex) => {
            const rowSessionId = conversationHistoryRowSessionId(row.id, data.sessionIds) || sessionId
            const audioRows = rows.filter(candidate => (conversationHistoryRowSessionId(candidate.id, data.sessionIds) || sessionId) === rowSessionId)
            const audioRowIndex = audioRows.findIndex(candidate => candidate.id === row.id)
            const sourceKey = `source:${row.id}`
            const playableLanguages = new Set(languages.filter((language) => playback.hasTrack(rowSessionId, language)))
            const playingLanguages = new Set(languages.filter((language) => playback.playingKey === `translation:${row.id}:${language}`))
            const playedLanguages = new Set(languages.filter((language) => playback.playedKeys.has(`translation:${row.id}:${language}`)))
            return (
              <FinishedTranscriptRow
                key={row.id}
                sessionId={rowSessionId}
                row={row}
                variant="history"
                targetLanguages={languages}
                primaryLanguage={primaryLanguage}
                terminal
                onPrimaryLanguage={setPrimaryLanguage}
                sourcePlayable={playback.hasTrack(rowSessionId)}
                sourcePlaying={playback.playingKey === sourceKey}
                playableLanguages={playableLanguages}
                fullTrackLanguages={new Set([...playableLanguages].filter(lang => translatedPlaybackRange(audioRows, audioRowIndex, lang).fullTrack))}
                playingLanguages={playingLanguages}
                playedLanguages={playedLanguages}
                showFeedback={!readOnly}
                typewriterEnabled={false}
                onTextProgress={follow.onTextProgress}
                onPlaySource={() => { void playback.play({ sessionId: rowSessionId, startMs: row.startMs, endMs: showcaseAudioEndMs(audioRows, audioRowIndex), outputDeviceId: 'default', key: sourceKey }) }}
                onPlayTranslation={(language) => { void playback.play({ sessionId: rowSessionId, language, ...translatedPlaybackRange(audioRows, audioRowIndex, language), outputDeviceId: 'default', key: `translation:${row.id}:${language}` }) }}
              />
            )
          })}
          {rows.length === 0 && <p className="showcase-finished-empty-title">本次没有识别到语音</p>}
          {extra && <div className="showcase-finished-extras">{extra}</div>}
        </div>
      </div>
      {footer && <div className="showcase-finished-footer">{footer}</div>}
    </ShowcaseFrame>
  )
}

function DuoFinished({ data, playback, summary, frameProps, extra, footer, readOnly }: { data: FinishedSessionData; playback: Playback; summary: ReactNode; frameProps: FrameProps; extra?: ReactNode; footer?: ReactNode; readOnly: boolean }) {
  const leftLanguages = data.leftTargetLanguages || []
  const rightLanguages = data.rightTargetLanguages || []
  const [leftPrimaryLanguage, setLeftPrimaryLanguage] = useState(leftLanguages[0] || '')
  const [rightPrimaryLanguage, setRightPrimaryLanguage] = useState(rightLanguages[0] || '')
  const bubbles = selectDuoLanguageLayouts(data.bubbles || [], leftPrimaryLanguage, rightPrimaryLanguage)
  const leftSessionId = data.sessionIds[0] || ''
  const rightSessionId = data.sessionIds[1] || leftSessionId
  const leftFeedback = useSentenceFeedback(leftSessionId)
  const rightFeedback = useSentenceFeedback(rightSessionId)
  const follow = useTranscriptFollow(bubbles.length, false)
  return (
    <ShowcaseFrame
      {...frameProps}
      mode="duo"
      toolbar={(
        <div className="showcase-language-rail showcase-duo-rail showcase-language-rail--completed showcase-language-rail--finished" aria-label="输出语言">
          {summary}
          <CompletedLanguageSwitch groups={[
            { side: '甲', sourceLanguage: bubbles.find(b => b.side === 'a')?.sourceLanguage, languages: leftLanguages, value: leftPrimaryLanguage, onChange: setLeftPrimaryLanguage },
            { side: '乙', sourceLanguage: bubbles.find(b => b.side === 'b')?.sourceLanguage, languages: rightLanguages, value: rightPrimaryLanguage, onChange: setRightPrimaryLanguage },
          ]} />
        </div>
      )}
    >
      <div className="realtime-showcase-transcript showcase-multilingual-transcript showcase-duo-transcript showcase-multilingual-transcript--completed showcase-multilingual-transcript--finished" {...follow.playbackGesture} ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
        <div className="realtime-showcase-transcript-track">
          {moveLeadingTranslationPunctuation(bubbles).map((bubble) => {
            const source = asrDisplayText(bubble.source)
            const primaryLanguage = bubble.side === 'a' ? leftPrimaryLanguage : rightPrimaryLanguage
            const sessionId = bubble.side === 'a' ? leftSessionId : rightSessionId
            const sideRows = bubbles.filter((candidate) => candidate.side === bubble.side)
            const sideRowIndex = sideRows.findIndex((candidate) => candidate.id === bubble.id)
            const sourceKey = `${bubble.side}:source:${bubble.id}`
            const playableLanguages = new Set(bubble.targetLanguages.filter((language) => playback.hasTrack(sessionId, language)))
            const playingLanguages = new Set(bubble.targetLanguages.filter((language) => playback.playingKey === `${bubble.side}:translation:${bubble.id}:${language}`))
            const playedLanguages = new Set(bubble.targetLanguages.filter((language) => playback.playedKeys.has(`${bubble.side}:translation:${bubble.id}:${language}`)))
            return (
              <article key={`${bubble.side}-${bubble.id}`} className={`showcase-duo-bubble showcase-duo-bubble--${bubble.side} showcase-duo-bubble--history`}>
                {/* Figma 938:5168：左侧 28×28 甲/乙角标；脚注行放点赞点踩与时间戳。 */}
                <span className="showcase-duo-bubble-badge" aria-hidden="true">{bubble.side === 'a' ? '甲' : '乙'}</span>
                <div className="showcase-duo-bubble-body">
                {playback.hasTrack(sessionId) ? (
                  <button
                    type="button"
                    className={`realtime-showcase-source showcase-source-playback${playback.playingKey === sourceKey ? ' is-playing' : ''}`}
                    title={playback.playingKey === sourceKey ? '正在播放，点击停止' : '播放实际传入模型的音频（按本次降噪/VAD设置处理）'}
                    aria-pressed={playback.playingKey === sourceKey}
                    aria-label={`播放${bubble.side === 'a' ? '甲' : '乙'}原文音频：${source}`}
                    onClick={() => { void playback.play({ sessionId, startMs: bubble.startMs, endMs: showcaseAudioEndMs(sideRows, sideRowIndex), outputDeviceId: 'default', key: sourceKey }) }}
                  >
                    <ShowcaseTypewriterText text={source} enabled={false} onProgress={follow.onTextProgress} />
                    <SentencePlaybackIcon playing={playback.playingKey === sourceKey} />
                  </button>
                ) : (
                  <p className="realtime-showcase-source"><ShowcaseTypewriterText text={source} enabled={false} onProgress={follow.onTextProgress} /></p>
                )}
                <ShowcaseTranslationList
                  translations={bubble.translations}
                  targetLanguages={bubble.targetLanguages}
                  primaryLanguage={primaryLanguage}
                  featured={false}
                  terminal
                  solo
                  primaryOnly
                  onPrimaryLanguage={(language) => { if (bubble.side === 'a') setLeftPrimaryLanguage(language); else setRightPrimaryLanguage(language) }}
                  playableLanguages={playableLanguages}
                  fullTrackLanguages={new Set([...playableLanguages].filter(lang => translatedPlaybackRange(sideRows, sideRowIndex, lang).fullTrack))}
                  playingLanguages={playingLanguages}
                  playedLanguages={playedLanguages}
                  typewriterEnabled={false}
                  onTextProgress={follow.onTextProgress}
                  onPlayTranslation={(language) => { void playback.play({ sessionId, language, ...translatedPlaybackRange(sideRows, sideRowIndex, language), outputDeviceId: 'default', key: `${bubble.side}:translation:${bubble.id}:${language}` }) }}
                />
                <footer className="showcase-row-footer">
                  {!readOnly ? <SentenceFeedback unitId={bubble.id} feedback={bubble.side === 'a' ? leftFeedback : rightFeedback} context={{ sourceText: bubble.source, translationText: bubble.translations[primaryLanguage], targetLanguage: primaryLanguage, side: bubble.side, startMs: Math.round(bubble.startMs) }} /> : <span />}
                </footer>
                </div>
              </article>
            )
          })}
          {(data.unassignedRows || []).map(row => <section key={row.id} aria-label="未标注说话人的转录">
            <p>已保存内容（未标注说话人）</p>
            {row.source && <p>{asrDisplayText(row.source)}</p>}
            {Object.entries(row.translations).map(([language, text]) => text.trim() ? <p key={language}>{chineseLanguageNames[language] || language}：{text}</p> : null)}
          </section>)}
          {(['a', 'b'] as const).map(side => {
            const language = side === 'a' ? leftPrimaryLanguage : rightPrimaryLanguage
            return language && (data.bubbles || []).some(bubble => bubble.side === side)
              && !bubbles.some(bubble => bubble.side === side && bubble.translations[language]?.trim())
              ? <p key={side} className="realtime-showcase-listening">{side === 'a' ? '甲' : '乙'}：该记录未保存{chineseLanguageNames[language] || language}的完整译文分段。</p> : null
          })}
          {!data.bubbles?.length && !data.unassignedRows?.length && <p className="showcase-finished-empty-title">本次没有识别到语音</p>}
          {extra && <div className="showcase-finished-extras">{extra}</div>}
        </div>
      </div>
      {footer && <div className="showcase-finished-footer">{footer}</div>}
    </ShowcaseFrame>
  )
}
