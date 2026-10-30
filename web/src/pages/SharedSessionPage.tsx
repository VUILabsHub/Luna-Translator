import { historyScene, historySceneLabel } from '@simultrans/core/historyTitle'
import { SharedLiveSession } from './SharedLiveSession'
import { asrDisplayText } from '../lib/showcaseTranscript'
import type { HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { useEffect, useState, type ReactNode } from 'react'
import type { ConsumerHistoryRecord, ConsumerHistoryUnit } from '../lib/consumerHistory'
import { omniTargetLanguages } from '@simultrans/ui-shared/src/languageCapabilities'
import '../styles/shared-session.css'
import { FinishedSessionView } from '../components/FinishedSessionView'
import { buildSharedSessionRows, finishedSessionDataFromRecord, type SharedSessionRow } from '../lib/finishedSessionData'
import { canaryDesignEnabled } from '../lib/canaryDesign'
import { historyShortTitle } from '../lib/historyTitle'
import { chineseLanguageNames } from './MultilingualShowcasePage'

export { buildSharedSessionRows, type SharedSessionRow }

// 分享落地页（/s/{token}）。只读、免登录，消费同源 GET /api/shares/{token}。
// 响应契约见 backend/consumer_share.go：顶层 { historyId, expiresAt, aigcLabel, record }，
// record 与登录态 GET /api/consumer/history/{id} 同构（consumer_history.go consumerHistoryDetail）。

export type SharedSessionUnit = ConsumerHistoryUnit
export type SharedSessionRecord = ConsumerHistoryRecord

export type SharedSessionData = {
  live?: boolean
  historyId: string
  expiresAt: string
  aigcLabel: boolean
  record: SharedSessionRecord
}

export type SharedSessionViewState =
  | { status: 'loading' }
  | { status: 'ready'; data: SharedSessionData }
  | { status: 'unavailable' }
  | { status: 'retry' }


const languageLabels: Record<string, string> = {
  auto: '自动', zh: '中', en: '英', ja: '日', ko: '韩', de: '德', fr: '法', ru: '俄', pt: '葡',
  es: '西', it: '意', ar: '阿', id: '印', vi: '越', th: '泰', ms: '马', ur: '乌', tr: '土', sw: '斯',
}
const languageNames: Record<string, string> = {
  auto: '自动识别',
  ...Object.fromEntries(omniTargetLanguages.map(({ code, name }) => [code, name.replace(/\([^)]*\)$/, '')])),
}

export const shareLanguageBadge = (code: string) => (
  languageLabels[code] || (code || '?').slice(0, 2).toUpperCase()
)

export const shareLanguageName = (code: string) => languageNames[code] || code || '未知语言'

const rtlScript = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u
/**
 * 历史 / 分享页里的语言名。chinese（Canary 手机版）用中文名（阿拉伯语、乌尔都语）；否则用母语名。
 * isolate 默认只在 Canary 主机开启：从右往左的名字（العربية、اردو）用 FSI…PDI 隔离，和「 / 」拼接后顺序不乱；
 * prod 原样返回母语名，不插隔离符。历史页（ConsumerHistoryPage）从这里转导出，两页同一条规则。
 */
export function historyLanguageName(code: string, chinese = false, isolate = canaryDesignEnabled()) {
  if (chinese && chineseLanguageNames[code]) return chineseLanguageNames[code]
  const name = shareLanguageName(code)
  return isolate && rtlScript.test(name) ? `\u2068${name}\u2069` : name
}

export const formatShareTimestamp = (iso: string) => {
  const date = new Date(iso)
  if (!iso || Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const formatShareDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [hours, minutes, seconds % 60].map((value) => String(value).padStart(2, '0')).join(':')
}

export function formatHistoryDevices(devices: ConsumerHistoryRecord['devices'], kind: 'inputs' | 'outputs') {
  const sideLabels = { a: '甲', b: '乙', shared: '共享' }
  const values = devices?.[kind] || []
  if (values.length === 0) return '未记录'
  return values.map((device) => (
    device.side ? `${sideLabels[device.side]}：${device.label}` : device.label
  )).join('；')
}

// 拉取并归一化分享数据。UI 映射约定：
// - 410 / 404 / 网络错误 → unavailable（整页「分享已失效或不存在」）
// - 500 / 503 及其他异常响应 → retry（整页「服务暂时不可用，请稍后重试」）
export async function loadSharedSession(token: string): Promise<SharedSessionViewState> {
  let response: Response
  try {
    response = await fetch(`/api/shares/${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { status: 'unavailable' }
  }
  if (response.ok) {
    try {
      const data = (await response.json()) as SharedSessionData
      if (!data || typeof data !== 'object' || !data.record || typeof data.record !== 'object') {
        return { status: 'retry' }
      }
      return { status: 'ready', data }
    } catch {
      return { status: 'retry' }
    }
  }
  if (response.status === 410 || response.status === 404) return { status: 'unavailable' }
  return { status: 'retry' }
}


function SharedSessionStatusCard({
  tone,
  title,
  detail,
  onRetry,
}: {
  tone: 'loading' | 'error'
  title: string
  detail?: string
  onRetry?: () => void
}) {
  return (
    <section className="shared-session-page">
      <div
        className={`shared-session-status${tone === 'error' ? ' shared-session-status--error' : ''}`}
        role={tone === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        {tone === 'loading' && <span className="shared-session-spinner" aria-hidden="true" />}
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
        {onRetry && (
          <button type="button" className="shared-session-retry" onClick={onRetry}>重新加载</button>
        )}
        <SharedSessionCta />
      </div>
    </section>
  )
}

// 引导访客进入 webui 竖屏体验(/),分享页的唯一转化出口。
function SharedSessionCta() {
  return (
    <a className="shared-session-cta" href="/">
      免费体验 Luna翻译 实时同传
    </a>
  )
}

export function SessionSnapshotView({
  record,
  expiresAt = '',
  action,
  audioPlayback,
  transcript,
  settings,
  showCta = true,
  showDevices = false,
}: {
  record: SharedSessionRecord
  expiresAt?: string
  action?: ReactNode
  audioPlayback?: ReactNode
  transcript?: ReactNode
  /** 会话设置折叠区；分享页不返回 settings，只有登录态历史详情传入。 */
  settings?: ReactNode
  showCta?: boolean
  showDevices?: boolean
}) {
  const rows = buildSharedSessionRows(record)
  const targetLanguages = [...new Set([
    record.targetLanguage,
    ...rows.flatMap((row) => Object.keys(row.translations)),
  ].filter(Boolean))]
  const recordedAt = formatShareTimestamp(record.createdAt)
  const formattedExpiry = formatShareTimestamp(expiresAt)
  const titleContext = finishedSessionDataFromRecord(record)
  // 语言名与历史列表同一条规则：Canary 手机版写中文名，其余母语名（Canary 主机上 RTL 名字加隔离符）；prod 不变。
  const chineseNames = canaryDesignEnabled()
  const languageName = (code: string) => historyLanguageName(code, chineseNames)

  return (
    <section className="shared-session-page" aria-labelledby="shared-session-title">
      <div className="shared-session-sheet">
        <header className="shared-session-card">
          <div className="shared-session-card-top shared-session-card-top--actions-only">
            {action}
          </div>
          <h1 id="shared-session-title">{historyShortTitle(titleContext)}</h1>
          {record.abnormalExit && (
            <p className="shared-session-abnormal" role="note">异常退出 · 尾部文本或音频可能不完整</p>
          )}
          <p className="shared-session-languages">
            <span>{languageName(record.sourceLanguage)}</span>
            <span className="shared-session-languages-arrow" aria-hidden="true">→</span>
            <span>{targetLanguages.map(languageName).join(' / ') || '未知语言'}</span>
          </p>
          <dl className="shared-session-meta">
            <div><dt>场景</dt><dd>{historySceneLabel(titleContext)}</dd></div>
            <div>
              <dt>记录时间</dt>
              <dd><time dateTime={record.createdAt}>{recordedAt || '—'}</time></dd>
            </div>
            {record.durationMs > 0 && (
              <div>
                <dt>时长</dt>
                <dd>{formatShareDuration(record.durationMs)}</dd>
              </div>
            )}
            {showDevices && (
              <>
                <div>
                  <dt>麦克风</dt>
                  <dd>{formatHistoryDevices(record.devices, 'inputs')}</dd>
                </div>
                <div>
                  <dt>输出设备</dt>
                  <dd>{formatHistoryDevices(record.devices, 'outputs')}</dd>
                </div>
              </>
            )}
            {formattedExpiry && (
              <div>
                <dt>链接有效期至</dt>
                <dd><time dateTime={expiresAt}>{formattedExpiry}</time></dd>
              </div>
            )}
          </dl>
        </header>

        {audioPlayback}

        {transcript ?? (rows.length > 0 ? (
          <ol className="shared-session-rows">
            {rows.map((row, index) => {
              const rowLanguages = targetLanguages.filter((language) => row.translations[language])
              return (
                <li key={row.id}>
                  <article className="shared-session-row">
                    <header className="showcase-row-meta">
                      <strong>{row.speakerName || (row.side ? (row.side === 'a' ? '甲' : '乙') : `${String(index + 1).padStart(2, '0')}.`)}</strong>
                      {typeof row.startMs === 'number' && <time>{formatShareDuration(row.startMs)}</time>}
                    </header>
                    <p className="realtime-showcase-source">{asrDisplayText(row.source) || '—'}</p>
                    <div className="showcase-translation-list">
                      {rowLanguages.map((language, languageIndex) => (
                        <div key={language} className={`showcase-translation-line${languageIndex === 0 ? ' is-primary' : ''}`}>
                          <span className={`showcase-translation-badge${languageIndex === 0 ? ' is-output' : ''}`}>{shareLanguageBadge(language)}</span>
                          <strong>{row.translations[language]}</strong>
                        </div>
                      ))}
                    </div>
                  </article>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="shared-session-empty">该记录暂无可展示的内容。</p>
        ))}

        {settings}

        {showCta && (
          <footer className="shared-session-footer">
            <SharedSessionCta />
          </footer>
        )}
      </div>
    </section>
  )
}

export function SharedSessionView({
  token,
  state,
  onRetry,
}: {
  token?: string
  state: SharedSessionViewState
  onRetry?: () => void
}) {
  if (state.status === 'loading') {
    return <SharedSessionStatusCard tone="loading" title="正在加载分享内容…" />
  }
  if (state.status === 'unavailable') {
    return (
      <SharedSessionStatusCard
        tone="error"
        title="分享已失效或不存在"
        detail="该分享链接可能已过期、已被撤回，或从未存在。"
      />
    )
  }
  if (state.status === 'retry') {
    return (
      <SharedSessionStatusCard
        tone="error"
        title="服务暂时不可用"
        detail="请稍后重试。"
        onRetry={onRetry}
      />
    )
  }

  // 分享页与结束页 / 历史详情同构（docs/history-detail-finished-view-plan.md §三-5）：只读——
  // 无返回、无分享、无反馈；底部保留有效期与「免费体验」入口。
  // aigcLabel 目前不落到页面（设计稿无 AIGC 文案，见 SharedSessionPage.test）。
  if (state.data.live && token) return <SharedLiveSession key={token} token={token} initial={state.data} />
  return <SharedSessionReady key={token} data={state.data} token={token} />
}

export function SharedSessionReady({ data, token }: { data: SharedSessionData; token?: string }) {
  const { record, expiresAt } = data
  const [archives, setArchives] = useState<Record<string, HistoryAudioArchive> | null>(null)
  const [archivePending, setArchivePending] = useState(false)
  // 会议记录的分享（2026-10-21 起允许）：没有音频（会中只存文字，后端分享音频一律 404、sessionId 置空），
  // 不去拉；页面逐句显示说话人，分享者本人说的那几句标「（分享者）」（后端给的 units[].self）。
  const meeting = historyScene(record) === 'meeting'
  useEffect(() => {
    const controller = new AbortController()
    setArchives(null)
    if (!token) return
    if (meeting) {
      setArchives({})
      return
    }
    const languages = [...new Set([record.targetLanguage, ...record.units.flatMap((unit) => Object.keys(unit.translations || {}))].filter(Boolean))]
    const cached = new Map<string, Blob>()
    const load = async (sessionId: string, kind: string) => {
      const key = `${sessionId}/${kind}`
      if (cached.has(key)) return cached.get(key)
      if (data.live && kind.startsWith('input')) return undefined
      try {
        const response = await fetch(`/api/shares/${encodeURIComponent(token)}/audio/${encodeURIComponent(kind)}?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
        if (!response.ok) return undefined
        const blob = await response.blob()
        cached.set(key, blob)
        return blob
      } catch { return undefined }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { void Promise.all(record.sessionId.split(':').filter(Boolean).map(async (sessionId) => {
      const [input, modelInput, output, outputs] = await Promise.all([
        load(sessionId, 'input'),
        load(sessionId, 'input-model'),
        load(sessionId, 'output'),
        Promise.all(languages.map(async (language) => [language, await load(sessionId, `output-${language}`)] as const)),
      ])
      return [sessionId, { input, modelInput, output, outputs: Object.fromEntries(outputs.filter((entry): entry is readonly [string, Blob] => Boolean(entry[1]))) }] as const
    })).then((entries) => {
      if (controller.signal.aborted) return
      setArchives(Object.fromEntries(entries))
      const pending = Boolean(data.live) && record.units.length > 0 && languages.some(language => !entries.some(([, archive]) => archive.outputs[language] || (languages.length === 1 && archive.output)))
      setArchivePending(pending)
      if (pending) timer = setTimeout(refresh, 3000)
    }) }
    refresh()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [record, token, data.live, meeting])
  const formattedExpiry = formatShareTimestamp(expiresAt)
  const titleContext = finishedSessionDataFromRecord(record)
  return (
    <FinishedSessionView
      data={finishedSessionDataFromRecord(record)}
      archives={archives}
      readOnly
      extra={archivePending && <p role="status">译音整理中，完成后可回听。</p>}
      footer={(
        <div className="shared-session-finished-notes">
          {formattedExpiry && <p className="shared-session-expiry">分享有效期至 <time dateTime={expiresAt}>{formattedExpiry}</time></p>}
          <SharedSessionCta />
        </div>
      )}
    />
  )
}

export function SharedSessionPage({ token }: { token: string }) {
  const [state, setState] = useState<SharedSessionViewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // 分享页可能挂在非 /ui-showcase 前缀下，自带字体懒加载保证观感一致。
    void Promise.all([
      import('@fontsource/poppins/400.css'),
      import('@fontsource-variable/noto-sans-sc/wght.css'),
      import('@fontsource-variable/noto-serif-sc/wght.css'),
    ]).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void loadSharedSession(token).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => { cancelled = true }
  }, [token, attempt])

  return <SharedSessionView token={token} state={state} onRetry={() => setAttempt((value) => value + 1)} />
}

export default SharedSessionPage
