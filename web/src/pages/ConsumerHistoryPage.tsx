import { consumerSessionSummaryRows } from '@simultrans/core/consumerSessionSummary'
import { canaryDesignEnabled, useCanaryMobileDesign } from '../lib/canaryDesign'
import { pollPendingHistoryTitles } from '@simultrans/core/historyListTitlePolling'
import { historyScene, historySceneLabel } from '@simultrans/core/historyTitle'
import { formatMeetingCode, meetingElapsedText, normalizeMeetingCode } from '@simultrans/core/meeting'
import { isOngoingMeetingCheckpoint } from '@simultrans/core/meetingRecord'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import '@fontsource/poppins/600.css'
import '../styles/consumer-history.css'
import ConsumerPageFrame from '../components/ConsumerPageFrame'
import { ConsumerHistoryRejoinableMeetings } from '../components/ConsumerHistoryRejoinableMeetings'
import { loadHistoryAudio, type HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { sessionExitLabel } from '../lib/sessionRecovery'
import { FinishedSessionView } from '../components/FinishedSessionView'
import { finishedSessionDataFromRecord } from '../lib/finishedSessionData'
import { historyShortTitle } from '../lib/historyTitle'
import {
  ACTIVE_MEETING_TAB_GRACE_MS,
  activeConsumerHistoryShare,
  consumerHistoryCheckpointOwner,
  copySnapshotLink,
  deleteConsumerHistory,
  findActiveMeeting,
  listConsumerHistory,
  loadConsumerHistoryAudio,
  loadConsumerHistory,
  retryConsumerHistoryCheckpoints,
  subscribeActiveMeetingChanges,
  type ActiveMeetingLookup,
  type ConsumerHistoryRecord,
  type ConsumerHistorySummary,
} from '../lib/consumerHistory'
import {
  sessionSettingsAudioLabel,
  sessionSettingsClientLabel,
  sessionSettingsFontSizeLabel,
  sessionSettingsLoudnessLabel,
  sessionSettingsNoisePresetLabel,
  sessionSettingsServiceLabel,
  sessionSettingsToggleLabel,
  sessionSettingsTranslationModelLabel,
  sessionSettingsTTSModelLabel,
  sessionSettingsVoiceModeLabel,
} from '../lib/sessionSettings'
import {
  formatHistoryDevices,
  formatShareDuration,
  formatShareTimestamp,
  historyLanguageName,
} from './SharedSessionPage'

type HistoryPageState =
  | { status: 'loading' }
  | { status: 'ready'; record: ConsumerHistoryRecord }
  | { status: 'error'; message: string }

type HistoryListState =
  | { status: 'loading' }
  | { status: 'ready'; records: ConsumerHistorySummary[] }
  | { status: 'error'; message: string }


const consumerHistoryReturnKey = 'simultrans.consumerHistoryReturn'

// 历史里的语言名（Canary 手机版中文名、Canary 主机 RTL 名字加隔离符）与分享页同一份，定义在 SharedSessionPage。
export { historyLanguageName }

/** 空态文案（与 mobile HistoryScreen 的 HISTORY_EMPTY_TITLE / HINT 一致）。 */
export const CONSUMER_HISTORY_EMPTY_TITLE = '还没有会话记录'
export const CONSUMER_HISTORY_EMPTY_HINT = '回到主界面开始一次同传。'

export function validConsumerHistoryReturnPath(value: string, origin: string) {
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return ''
    if (url.pathname !== '/' && url.pathname !== '/ui-showcase' && url.pathname !== '/ui-showcase/multilingual') return ''
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return ''
  }
}

function returnFromConsumerHistory() {
  let returnPath = ''
  try {
    returnPath = sessionStorage.getItem(consumerHistoryReturnKey) || ''
    sessionStorage.removeItem(consumerHistoryReturnKey)
  } catch {
    // Fall back to a regular navigation when sessionStorage is unavailable.
  }
  window.location.assign(validConsumerHistoryReturnPath(returnPath, window.location.origin) || '/')
}

function returnToConsumerHistoryList() {
  window.location.assign('/history')
}

// 列表页与详情加载态共用 9:16 页框（Figma 971:7559 顶栏：chevron + 「返回」）。
// 详情就绪后改由 FinishedSessionView 自带页框渲染，不经过这里。
function ConsumerHistoryFrame({ children, detail = false }: { children: ReactNode; detail?: boolean }) {
  return (
    <ConsumerPageFrame
      className="consumer-history-page"
      labelledBy="consumer-history-title"
      onBack={detail ? returnToConsumerHistoryList : returnFromConsumerHistory}
    >
      <h1 id="consumer-history-title" className="consumer-history-title">{detail ? '同传记录' : '历史记录'}</h1>
      {children}
    </ConsumerPageFrame>
  )
}

function useConsumerHistoryTracks(record: ConsumerHistoryRecord) {
  // 结束页视图按 sessionId 取归档做逐句回放；与 <audio> 列表共用同一次加载。
  const [archives, setArchives] = useState<Record<string, HistoryAudioArchive> | null>(null)

  useEffect(() => {
    // 会议记录没有音频（会中只存文字）：不去拉注定 404 的几条音轨。
    if (historyScene(record) === 'meeting') {
      setArchives({})
      return
    }
    let active = true
    const sessionIds = record.sessionId.split(':').map((id) => id.trim()).filter(Boolean)
    const targetLanguages = [...new Set([
      record.targetLanguage,
      ...record.units.flatMap((unit) => Object.keys(unit.translations || {})),
    ].filter(Boolean))]
    void Promise.all(sessionIds.map(async (id) => {
      const local = await loadHistoryAudio(id).catch((): HistoryAudioArchive => ({}))
      const input = local.input || await loadConsumerHistoryAudio(record.id, id, 'input').catch(() => undefined)
      const modelInput = await loadConsumerHistoryAudio(record.id, id, 'input-model').catch(() => undefined)
      const output = local.output || await loadConsumerHistoryAudio(record.id, id, 'output').catch(() => undefined)
      const outputs = { ...local.outputs }
      await Promise.all(targetLanguages.map(async (language) => {
        if (outputs[language]) return
        const audio = await loadConsumerHistoryAudio(record.id, id, `output-${language}`).catch(() => undefined)
        if (audio) outputs[language] = audio
      }))
      return { input, modelInput, output, outputs }
    })).then((archives) => {
      if (!active) return
      setArchives(Object.fromEntries(archives.map((archive, index) => [sessionIds[index], archive])))

    })
    return () => {
      active = false
    }
  }, [record])

  return { archives }
}


// 会话设置折叠区（docs/session-settings-history-plan.md §二）。旧记录不带
// settings 时整块隐藏；每一行只在对应值上报过时出现，避免把「未记录」显示成
// 「关闭」。traceId 与后端 trace / 客户端日志同键，故给一个复制入口。
export function consumerHistorySettingsRows(record: ConsumerHistoryRecord): Array<[string, string]> {
  const settings = record.settings
  if (!settings) return []
  const targetLanguages = settings.targetLanguages?.filter(Boolean) || []
  const rows: Array<[string, string | undefined]> = [
    ['模式', historySceneLabel(record)],
    ['输入语言', settings.sourceLanguage ? historyLanguageName(settings.sourceLanguage, canaryDesignEnabled()) : undefined],
    ['输出语言', targetLanguages.length > 0 ? targetLanguages.map(code => historyLanguageName(code, canaryDesignEnabled())).join(' / ') : undefined],
    ['翻译模型', sessionSettingsTranslationModelLabel(settings.translationModel)],
    ['使用场景', sessionSettingsTTSModelLabel(settings.ttsModel)],
    ['设备模式', sessionSettingsNoisePresetLabel(settings.noisePreset)],
    ['链路', sessionSettingsServiceLabel(settings.service)],
    ['回声消除', sessionSettingsToggleLabel(settings.echoCancellation)],
    ['服务端降噪', sessionSettingsToggleLabel(settings.deepFilterNet)],
    ['响度门控', sessionSettingsLoudnessLabel(settings.vadLoudnessMode, settings.vadLoudnessThresholdDbfs)],
    ['声音克隆', sessionSettingsToggleLabel(settings.voiceClone)],
    ['音色模式', sessionSettingsVoiceModeLabel(settings.voiceMode)],
    ['显示字号', sessionSettingsFontSizeLabel(settings.fontSize)],
    ['麦克风', record.devices ? formatHistoryDevices(record.devices, 'inputs') : undefined],
    ['播放设备', record.devices ? formatHistoryDevices(record.devices, 'outputs') : undefined],
    ['客户端版本', sessionSettingsClientLabel(settings.client)],
    ['音频', sessionSettingsAudioLabel(settings.audio)],
  ]
  return rows.flatMap(([label, value]) => (value ? [[label, value] as [string, string]] : []))
}

export function ConsumerHistorySettings({ record }: { record: ConsumerHistoryRecord }) {
  const [copyNotice, setCopyNotice] = useState('')
  const simplified = useCanaryMobileDesign()
  const rows = simplified ? consumerSessionSummaryRows(record.settings as unknown as Record<string, unknown> | undefined, historySceneLabel(record), code => historyLanguageName(code, true)) : consumerHistorySettingsRows(record)
  const traceId = record.traceId?.trim() || ''
  if (rows.length === 0 && (simplified || !traceId)) return null

  const copyTraceId = async () => {
    try {
      await copySnapshotLink(traceId)
      setCopyNotice('trace ID 已复制。')
    } catch (caught) {
      setCopyNotice(caught instanceof Error ? caught.message : '无法复制 trace ID。')
    }
  }

  return (
    <details className="consumer-history-settings">
      <summary>会话设置</summary>
      {rows.length > 0 && (
        <table className="consumer-history-settings-table">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!simplified && traceId && (
        <p className="consumer-history-trace">
          <span>trace ID</span>
          <code>{traceId}</code>
          <button type="button" aria-label="复制 trace ID" onClick={() => { void copyTraceId() }}>复制</button>
          {copyNotice && <small role="status">{copyNotice}</small>}
        </p>
      )}
    </details>
  )
}

// 历史详情 = 结束页视图 + 底部「会话音频」「会话设置」折叠栏（docs/history-detail-finished-view-plan.md）。
function ConsumerHistoryContent({ record, onRefresh, refreshing, refreshError }: { record: ConsumerHistoryRecord; onRefresh: () => void; refreshing: boolean; refreshError: string }) {
  const { archives } = useConsumerHistoryTracks(record)
  const data = useMemo(() => finishedSessionDataFromRecord(record), [record])
  // 删除入口从列表卡片（设计稿无删除按钮）挪到详情页底部：确认 → 删除 → 回列表。
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const remove = async () => {
    if (deleting || !window.confirm('删除后，该会话的原文、译文及关联分享将无法恢复。确定删除吗？')) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteConsumerHistory(record.id)
      returnToConsumerHistoryList()
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '无法删除同传历史记录。')
      setDeleting(false)
    }
  }
  return (
    <FinishedSessionView
      data={data}
      archives={archives}
      backHref="/history"
      extra={(
        <>
          {record.abnormalExit && <button type="button" className="shared-session-retry" disabled={refreshing} onClick={onRefresh}>{refreshing ? '正在读取后台记录…' : '重新读取后台记录'}</button>}
          {refreshError && <p role="status">{refreshError} 已保留当前显示的内容。</p>}
          <ConsumerHistorySettings record={record} />
          <button type="button" className="consumer-history-delete" disabled={deleting} onClick={() => { void remove() }}>
            {deleting ? '删除中…' : '删除此记录'}
          </button>
          {deleteError && <p className="consumer-history-delete-error" role="alert">{deleteError}</p>}
        </>
      )}
    />
  )
}

function summaryTargetLanguages(record: ConsumerHistorySummary) {
  const languages = record.targetLanguages?.filter(Boolean) || []
  return languages.length > 0 ? languages : [record.targetLanguage].filter(Boolean)
}

export function splitConsumerHistoryByDate(records: ConsumerHistorySummary[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const today: ConsumerHistorySummary[] = []
  const earlier: ConsumerHistorySummary[] = []
  for (const record of records) {
    const createdAt = new Date(record.createdAt).getTime()
    if (createdAt >= startOfToday && createdAt < startOfTomorrow) today.push(record)
    else earlier.push(record)
  }
  return { today, earlier }
}

/** 历史卡片第二行的模式文案：「单麦多语 / 双麦多语」，异常结束时追加 「 · 未正常结束」。 */
export function consumerHistoryModeLabel(record: Pick<ConsumerHistorySummary, 'scene' | 'mode' | 'abnormalExit' | 'completionReason'>) {
  const mode = historySceneLabel(record)
  return record.abnormalExit ? `${mode} · ${sessionExitLabel(record.completionReason)}` : mode
}

/** 进行中卡片的徽标字（与 App HISTORY_ONGOING_BADGE 同字）。 */
export const CONSUMER_HISTORY_ONGOING_BADGE = '进行中'
/** 卡片标题前缀（与 App CANARY_MEETING_TITLE 同字）。 */
const ONGOING_MEETING_TITLE = '会议同传'

/** 会议开在其他标签页时卡片上的说明（这时卡片不是链接）。 */
export const CONSUMER_HISTORY_OTHER_TAB_HINT = '在其他标签页中进行，请切换到该标签页'

/** 点进行中卡片回到会议：会议页按 ?code= 预填加入表单（只给本标签页离开会议页的那场）。 */
export function consumerHistoryOngoingHref(code: string): string {
  return `/meeting?code=${encodeURIComponent(normalizeMeetingCode(code))}`
}

/**
 * 列表里要列的记录：会议进行中时，这场会议本人这次出席的会中检查点（「会话恢复记录」）是同一场会议的半截，
 * 顶上已经钉着进行中卡片，先不列；会议结束后终稿覆盖它，照常列出（与 App HistoryScreen 同一条规则）。
 */
export function consumerHistoryVisibleRecords(records: ConsumerHistorySummary[], ongoing: ActiveMeetingLookup | null): ConsumerHistorySummary[] {
  return ongoing ? records.filter((record) => !isOngoingMeetingCheckpoint(record.settings, ongoing.presence)) : records
}

// 徽标（App canaryStyles.ongoingBadge 的 Web 版）：Canary 绿浅底圆角小字，跟在「会议」后面。
const ongoingBadgeStyle: CSSProperties = {
  display: 'inline-block', marginLeft: '0.06rem', padding: '0 0.06rem', borderRadius: '0.09rem', background: 'rgba(86, 129, 87, 0.12)',
  color: '#456446', fontSize: '0.11rem', lineHeight: '0.18rem', verticalAlign: 'middle',
}

/** 卡片上的会议时长（HH:MM:SS，与会中页头同一条规则）：自己每秒走，整页不跟着重渲染。 */
function OngoingMeetingElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return <span className="consumer-history-entry-duration" role="timer">{meetingElapsedText(since, now)}</span>
}

// 会议开在其他标签页时：卡片不是链接，底色不随 hover 变（行内样式压过 :hover），多一行说明（Songti 14/22 墨色 45%）。
const otherTabCardStyle: CSSProperties = { background: '#f8f8f8', cursor: 'default' }
const otherTabHintStyle: CSSProperties = { font: '400 0.14rem / 0.22rem "Songti SC", "Noto Serif SC Variable", serif', color: 'rgba(10, 15, 10, 0.45)' }

/**
 * 历史列表顶上钉的「进行中」会议卡（Canary；2026-10-21：只给本人此刻仍在会中的那场——其他标签页开着会议页，
 * 或本标签页刚离开会议页、服务端还留着本人）。样式复用列表卡：行1 标题，行2 开始时间 + 会议时长，行3 会议 +
 * 「进行中」徽标 + 收听语言。本标签页的那场点它回到 /meeting?code=<会议码>；开在其他标签页的那场不给链接，只写明
 * 「在其他标签页中进行」——在这里重新加入会走「退出原会议并继续」，把那个标签页的出席顶掉（记成被移出）。
 */
export function ConsumerHistoryOngoingCard({ ongoing, chineseNames }: { ongoing: ActiveMeetingLookup; chineseNames: boolean }) {
  const { presence, where } = ongoing
  const displayCode = formatMeetingCode(presence.code)
  const startedAt = new Date(presence.startedAt)
  const iso = Number.isNaN(startedAt.getTime()) ? '' : startedAt.toISOString()
  const content = (
    <>
      <strong className="consumer-history-entry-title">{`${ONGOING_MEETING_TITLE} ${displayCode}`}</strong>
      <span className="consumer-history-entry-head">
        <time className="consumer-history-entry-time" dateTime={iso || undefined}>{formatShareTimestamp(iso) || '时间未知'}</time>
        <OngoingMeetingElapsed since={presence.startedAt} />
      </span>
      <span className="consumer-history-entry-foot">
        <span className="consumer-history-entry-mode">
          <img src="/showcase/mode-mic.svg" alt="" aria-hidden="true" />
          {historySceneLabel({ scene: 'meeting' })}
          <span className="consumer-history-ongoing-badge" style={ongoingBadgeStyle}>{CONSUMER_HISTORY_ONGOING_BADGE}</span>
        </span>
        {presence.targetLanguage && <span className="consumer-history-entry-languages">{historyLanguageName(presence.targetLanguage, chineseNames)}</span>}
      </span>
      {where === 'other-tab' && <span className="consumer-history-ongoing-where" style={otherTabHintStyle}>{CONSUMER_HISTORY_OTHER_TAB_HINT}</span>}
    </>
  )
  return (
    <section className="consumer-history-section consumer-history-ongoing" aria-label="进行中的会议">
      <ol className="consumer-history-entries" aria-label={CONSUMER_HISTORY_ONGOING_BADGE}>
        <li className="consumer-history-entry">
          {where === 'this-tab' ? (
            <a className="consumer-history-entry-link" href={consumerHistoryOngoingHref(presence.code)} aria-label={`返回会议同传，会议码 ${displayCode}`}>
              {content}
            </a>
          ) : (
            <div className="consumer-history-entry-link" style={otherTabCardStyle} role="group" aria-label={`会议同传，会议码 ${displayCode}，${CONSUMER_HISTORY_OTHER_TAB_HINT}`}>
              {content}
            </div>
          )}
        </li>
      </ol>
    </section>
  )
}

function ConsumerHistoryListPage() {
  const chineseNames = canaryDesignEnabled()
  // replay：这次加载先补存本机待补存（打开页面、点「重新加载」时）。其他标签页的会议开始 / 结束 / 记录存好时只重拉
  // 列表：那边的终稿这时多半还在发，同时补存本机那份只会重复发同一条。
  const [load, setLoad] = useState({ attempt: 0, replay: true })
  const [state, setState] = useState<HistoryListState>({ status: 'loading' })
  // 进行中的会议（Canary）：与列表并行查（没有会议页开着时要等一小会儿才知道，不拖慢列表）。
  const [ongoing, setOngoing] = useState<ActiveMeetingLookup | null>(null)
  const [presenceCheck, setPresenceCheck] = useState(0)
  useEffect(() => {
    let cancelled = false
    // 已有列表时（会议结束后的重拉）不闪回加载态。
    setState(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void (load.replay ? retryConsumerHistoryCheckpoints() : Promise.resolve()).then(() => listConsumerHistory()).then((records) => {
      if (!cancelled) setState({ status: 'ready', records })
    }).catch((caught) => {
      if (!cancelled) setState(previous => previous.status === 'ready' ? previous : {
        status: 'error',
        message: caught instanceof Error ? caught.message : '无法读取同传历史记录。',
      })
    })
    return () => { cancelled = true }
  }, [load])
  useEffect(() => {
    if (!canaryDesignEnabled()) return
    let cancelled = false
    void findActiveMeeting(consumerHistoryCheckpointOwner()).then((found) => {
      if (!cancelled) setOngoing(found)
    }, () => undefined)
    return () => { cancelled = true }
  }, [presenceCheck])
  // 其他标签页的会议开始 / 结束、会议记录存好：重查卡片并重拉列表（换上刚存好的那条记录）。
  useEffect(() => {
    if (!canaryDesignEnabled()) return undefined
    return subscribeActiveMeetingChanges(() => {
      setPresenceCheck((value) => value + 1)
      setLoad((value) => ({ attempt: value.attempt + 1, replay: false }))
    })
  }, [])
  // 本标签页离开会议页后的宽限到点：撤卡。
  useEffect(() => {
    if (ongoing?.where !== 'this-tab') return undefined
    const timer = setTimeout(() => setPresenceCheck((value) => value + 1), Math.max(0, ongoing.presence.updatedAt + ACTIVE_MEETING_TAB_GRACE_MS - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [ongoing])
  const ongoingCard = ongoing && <ConsumerHistoryOngoingCard ongoing={ongoing} chineseNames={chineseNames} />
  const rejoinableCards = canaryDesignEnabled() && <ConsumerHistoryRejoinableMeetings ongoing={ongoing} refreshKey={`${presenceCheck}:${load.attempt}`} />

  const pendingTitleIds = state.status === 'ready' ? state.records.filter(record => record.titleStatus === 'pending').map(record => record.id).sort().join(',') : ''
  useEffect(() => pollPendingHistoryTitles({
    ids: pendingTitleIds ? pendingTitleIds.split(',') : [], read: listConsumerHistory,
    update: records => setState(previous => previous.status === 'ready' ? {
      ...previous, records: previous.records.map(record => {
        const next = records.find(item => item.id === record.id)
        return next ? { ...record, title: next.title, titleStatus: next.titleStatus } : record
      }),
    } : previous),
  }), [pendingTitleIds])

  if (state.status !== 'ready') {
    return (
      <ConsumerHistoryFrame>
        {rejoinableCards}
        {/* 列表还没出来（或读失败）也先给回到会议的入口。 */}
        {ongoingCard && <div className="consumer-history-sections">{ongoingCard}</div>}
        <div className={`consumer-history-state${state.status === 'error' ? ' is-error' : ''}`} role={state.status === 'error' ? 'alert' : 'status'}>
          <p>{state.status === 'loading' ? '正在加载历史记录…' : state.message}</p>
          {state.status === 'error' && <button type="button" className="consumer-history-retry" onClick={() => setLoad((value) => ({ attempt: value.attempt + 1, replay: true }))}>重新加载</button>}
        </div>
      </ConsumerHistoryFrame>
    )
  }

  return (
    <ConsumerHistoryFrame>
      {rejoinableCards}
      <ConsumerHistoryListView records={state.records} ongoing={ongoing} chineseNames={chineseNames} />
    </ConsumerHistoryFrame>
  )
}

/**
 * 列表就绪后的内容：顶上进行中卡片（有的话），再按「今天 / 更早记录」分组。进行中会议的会中检查点先不列；
 * 一条都没有时出空态，但有进行中卡片时只出卡片。clampTitles（默认跟 Canary 主机走）：卡片标题最多 13 个字，
 * 旧上限 28 时存下的老标题显示前 13 个字加「…」（lib/historyTitle）。
 */
export function ConsumerHistoryListView({ records, ongoing, chineseNames, clampTitles = canaryDesignEnabled() }: { records: ConsumerHistorySummary[]; ongoing: ActiveMeetingLookup | null; chineseNames: boolean; clampTitles?: boolean }) {
  const listed = consumerHistoryVisibleRecords(records, ongoing)
  const { today, earlier } = splitConsumerHistoryByDate(listed)
  // 卡片（Figma Frame 2147226380）：行1 时间 + 时长，行2 模式图标/文案 + 目标语言母语名（Canary 为中文名）。
  const historyList = (records: ConsumerHistorySummary[], label: string) => (
    <ol className="consumer-history-entries" aria-label={label}>
      {records.map((record) => {
        const targets = summaryTargetLanguages(record)
        return (
          <li className="consumer-history-entry" key={record.id}>
            <a className="consumer-history-entry-link" href={`/history/${encodeURIComponent(record.id)}`}>
              <strong className="consumer-history-entry-title">{historyShortTitle(record, clampTitles)}</strong>
              <span className="consumer-history-entry-head">
                <time className="consumer-history-entry-time" dateTime={record.createdAt}>{formatShareTimestamp(record.createdAt) || '时间未知'}</time>
                <span className="consumer-history-entry-duration">{formatShareDuration(record.durationMs)}</span>
              </span>
              <span className="consumer-history-entry-foot">
                <span className="consumer-history-entry-mode">
                  <img src={record.mode === 'duo' ? '/showcase/mode-duo.svg' : '/showcase/mode-mic.svg'} alt="" aria-hidden="true" />
                  {consumerHistoryModeLabel(record)}
                  {canaryDesignEnabled() && activeConsumerHistoryShare(record.share) && <span className="consumer-history-share-badge" style={ongoingBadgeStyle}>分享中</span>}
                </span>
                <span className="consumer-history-entry-languages">{targets.map(code => historyLanguageName(code, chineseNames)).join(' / ') || '未知语言'}</span>
              </span>
            </a>
          </li>
        )
      })}
    </ol>
  )

  return (
    <>
      {listed.length === 0 && !ongoing ? (
        <div className="consumer-history-blank">
          <p className="consumer-history-blank-title">{CONSUMER_HISTORY_EMPTY_TITLE}</p>
          <p className="consumer-history-blank-hint">{CONSUMER_HISTORY_EMPTY_HINT}</p>
        </div>
      ) : (
        <div className="consumer-history-sections">
          {ongoing && <ConsumerHistoryOngoingCard ongoing={ongoing} chineseNames={chineseNames} />}
          {today.length > 0 && (
            <section className="consumer-history-section" aria-labelledby="consumer-history-today-title">
              <h2 id="consumer-history-today-title" className="consumer-history-section-title">今天</h2>
              {historyList(today, '今天')}
            </section>
          )}
          {earlier.length > 0 && (
            <section className="consumer-history-section" aria-labelledby="consumer-history-all-title">
              <h2 id="consumer-history-all-title" className="consumer-history-section-title">更早记录</h2>
              {historyList(earlier, '更早记录')}
            </section>
          )}
        </div>
      )}
    </>
  )
}

function ConsumerHistoryDetailPage({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [state, setState] = useState<HistoryPageState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setRefreshing(true)
    setRefreshError('')
    setState(previous => previous.status === 'ready' && previous.record.id === id ? previous : { status: 'loading' })
    void loadConsumerHistory(id).then((record) => {
      if (!cancelled) setState({ status: 'ready', record })
    }).catch((caught) => {
      if (!cancelled) {
        const message = caught instanceof Error ? caught.message : '无法读取同传历史记录。'
        setRefreshError(message)
        setState(previous => previous.status === 'ready' && previous.record.id === id ? previous : { status: 'error', message })
      }
    }).finally(() => {
      if (!cancelled) setRefreshing(false)
    })
    return () => { cancelled = true }
  }, [attempt, id])

  if (state.status !== 'ready') {
    return (
      <ConsumerHistoryFrame detail>
        <div className={`consumer-history-state${state.status === 'error' ? ' is-error' : ''}`} role={state.status === 'error' ? 'alert' : 'status'}>
          <p>{state.status === 'loading' ? '正在加载同传记录…' : state.message}</p>
          {state.status === 'error' && <button type="button" className="consumer-history-retry" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>}
        </div>
      </ConsumerHistoryFrame>
    )
  }

  return <ConsumerHistoryContent record={state.record} refreshing={refreshing} refreshError={refreshError} onRefresh={() => setAttempt(value => value + 1)} />
}

export default function ConsumerHistoryPage({ id }: { id?: string }) {
  return id ? <ConsumerHistoryDetailPage id={id} /> : <ConsumerHistoryListPage />
}
