// 结束页「完整音频」卡片（Figma 727:4741 / 音频卡 929:4182）。
//
// 每条音轨仍由一个原生 <audio> 承载播放（保留 aria-label「${label}完整音频」给
// Playwright getByLabel），但它在视觉上被隐藏，改由自绘的播放胶囊驱动：播放/暂停
// 按钮、mm:ss 当前时间、可点击/键盘拖动的进度条（role=slider）、倍速 chip
// （1.0 → 1.25 → 1.5 → 2.0 循环）、以及右侧的下载 <a download>。
//
// 行为约束（与改版前一致）：
// - 同一时间只播放一条：section 的 onPlayCapture 暂停其余 <audio>；
// - 任一音轨开始播放时上报 trackProduct('history_playback') 并回调 onPlay()，让句级
//   播放停下；
// - 外部 playingKey 变化（句级播放开始）时暂停本卡片全部音轨。
//
// 注意 <audio> 保留 controls 属性：Chromium UA 样式对 audio:not([controls]) 强制
// display:none !important，那会让 e2e 里的 toBeVisible() 失败；视觉隐藏交给
// .session-audio-native（裁剪到 .01rem、透明、不可点）。
import { formatPlaybackRate, nextPlaybackRate, PLAYBACK_RATES } from '@simultrans/core/playbackRate'
import { trackProduct } from '@simultrans/ui-shared/src/lib/productAnalytics'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { hasHistoryAudioSamples, type HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { useActionToast } from './ActionToast'
import { useCanaryMobileDesign } from '../lib/canaryDesign'
import { displayLanguageName } from '../pages/MultilingualShowcasePage'
import '../styles/session-audio-downloads.css'

/**
 * 倍速循环顺序；点击 chip 依次切换，到末尾回到 1.0。
 *
 * finished-09：档位表与格式化下沉到 `@simultrans/core/playbackRate`，移动端的
 * 「完整音频」卡用的是同一份（以前它只有 1x / 2x，按钮上印的还是下一档）。
 * 这里保留同名再导出，本组件既有的测试与调用点不必改。
 */
export const playbackRates = PLAYBACK_RATES
export { formatPlaybackRate, nextPlaybackRate }

/** 秒 → mm:ss；NaN/Infinity/负数（元数据未就绪、流式 blob）一律显示 00:00。 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/** 进度百分比（0~100），时长未知时为 0。 */
export function progressPercent(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return 0
  return Math.min(100, Math.max(0, (currentTime / duration) * 100))
}

const SEEK_STEP_SECONDS = 5

export type AudioPlayerPillProps = {
  label: string
  url: string
  filename: string
  playing: boolean
  currentTime: number
  duration: number
  rate: number
  onToggle: () => void
  /** fraction ∈ [0, 1] 或 delta 秒（keyboard），由调用方换算成 currentTime。 */
  onSeekFraction: (fraction: number) => void
  onSeekBy: (deltaSeconds: number) => void
  onCycleRate: () => void
  onDownload?: () => void
}

/** 纯展示的播放胶囊：不含 <audio>，方便 renderToStaticMarkup 直接断言标记。 */
export function AudioPlayerPill({ label, url, filename, playing, currentTime, duration, rate, onToggle, onSeekFraction, onSeekBy, onCycleRate, onDownload }: AudioPlayerPillProps) {
  const percent = progressPercent(currentTime, duration)
  const hasDuration = Number.isFinite(duration) && duration > 0
  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0) return
    onSeekFraction(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)))
  }
  const seekFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowDown': event.preventDefault(); onSeekBy(-SEEK_STEP_SECONDS); break
      case 'ArrowRight': case 'ArrowUp': event.preventDefault(); onSeekBy(SEEK_STEP_SECONDS); break
      case 'Home': event.preventDefault(); onSeekFraction(0); break
      case 'End': event.preventDefault(); onSeekFraction(1); break
      case ' ': case 'Enter': event.preventDefault(); onToggle(); break
      default: break
    }
  }
  return (
    <div className={`session-audio-player${playing ? ' is-playing' : ''}`}>
      <div className="session-audio-player-main">
        <button
          type="button"
          className="session-audio-play"
          aria-label={`${playing ? '暂停' : '播放'}${label}`}
          aria-pressed={playing}
          onClick={onToggle}
        >
          {playing
            ? <span className="session-audio-pause-glyph" aria-hidden="true" />
            : <img src="/showcase/play.svg" alt="" aria-hidden="true" />}
        </button>
        <span className="session-audio-time">{formatClock(currentTime)}</span>
        <div
          className="session-audio-progress"
          role="slider"
          tabIndex={0}
          aria-label={`${label}进度`}
          aria-valuemin={0}
          aria-valuemax={hasDuration ? Math.round(duration) : 0}
          aria-valuenow={hasDuration ? Math.round(Math.min(currentTime, duration)) : 0}
          aria-valuetext={`${formatClock(currentTime)} / ${formatClock(duration)}`}
          onClick={seekFromPointer}
          onKeyDown={seekFromKeyboard}
        >
          <div className="session-audio-progress-track">
            <div className="session-audio-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <button
          type="button"
          className="session-audio-rate"
          aria-label={`播放速度 ${formatPlaybackRate(rate)}`}
          onClick={onCycleRate}
        >
          {formatPlaybackRate(rate)}
        </button>
      </div>
      {url
        ? <a className="session-audio-download" href={url} download={filename} aria-label={`下载${label}`} onClick={onDownload}>
            <img src="/showcase/download.svg" alt="" aria-hidden="true" />
          </a>
        : <span className="session-audio-download is-pending" aria-hidden="true">
            <img src="/showcase/download.svg" alt="" />
          </span>}
    </div>
  )
}

function AudioTrack({ blob, label, filename, onDownload }: { blob: Blob; label: string; filename: string; onDownload: () => void }) {
  const [url, setUrl] = useState('')
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState<number>(playbackRates[0])

  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  // 倍速跟随 state；src 变化后元素重建，也要重新应用。
  useEffect(() => {
    const audio = audioRef.current
    if (audio && Math.abs(audio.playbackRate - rate) > 1e-6) audio.playbackRate = rate
  }, [rate, url])

  const syncDuration = useCallback(() => {
    const audio = audioRef.current
    if (audio) setDuration(audio.duration)
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => undefined)
    else audio.pause()
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    const clamped = Math.min(audio.duration, Math.max(0, seconds))
    audio.currentTime = clamped
    setCurrentTime(clamped)
  }, [])

  const seekFraction = useCallback((fraction: number) => {
    const audio = audioRef.current
    if (audio) seekTo(fraction * audio.duration)
  }, [seekTo])

  const seekBy = useCallback((delta: number) => {
    const audio = audioRef.current
    if (audio) seekTo(audio.currentTime + delta)
  }, [seekTo])

  const cycleRate = useCallback(() => setRate((current) => nextPlaybackRate(current)), [])

  return (
    <div className="session-audio-track">
      <div className="session-audio-track-label">{label}</div>
      <AudioPlayerPill
        label={label}
        url={url}
        filename={filename}
        playing={playing}
        currentTime={currentTime}
        duration={duration}
        rate={rate}
        onToggle={toggle}
        onSeekFraction={seekFraction}
        onSeekBy={seekBy}
        onCycleRate={cycleRate}
        onDownload={onDownload}
      />
      {url && (
        <audio
          ref={audioRef}
          className="session-audio-native"
          controls
          preload="metadata"
          src={url}
          tabIndex={-1}
          aria-label={`${label}完整音频`}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={syncDuration}
          onDurationChange={syncDuration}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onRateChange={(event) => {
            const next = event.currentTarget.playbackRate
            if (next > 0) setRate(next)
          }}
        />
      )}
    </div>
  )
}

export function SessionAudioDownloads({ archives, sessionIds, playingKey, onPlay }: {
  archives: Record<string, HistoryAudioArchive> | null
  sessionIds: string[]
  playingKey: string
  onPlay: () => void
}) {
  const container = useRef<HTMLElement>(null)
  const { toast, showToast } = useActionToast()
  // 音轨名里的语言：Canary 手机版写中文名（阿拉伯语译文音频），其余照旧母语名（العربية译文音频）。
  const chineseNames = useCanaryMobileDesign()
  useEffect(() => {
    if (playingKey) container.current?.querySelectorAll('audio').forEach((audio) => audio.pause())
  }, [playingKey])
  if (archives === null) return <p className="session-audio-status session-audio-loading" role="status">正在检查可播放内容…</p>
  const ids = [...new Set(sessionIds.filter(Boolean))]
  const groups = ids.map((sessionId, index) => {
    const archive = archives[sessionId] || {}
    const side = ids.length > 1 ? `${index === 0 ? '甲' : '乙'}方 · ` : ''
    const outputs = Object.entries(archive.outputs || {}).filter(([, blob]) => hasHistoryAudioSamples(blob))
    const tracks = [
      ...(hasHistoryAudioSamples(archive.input) ? [{ blob: archive.input, label: `${side}原音频`, filename: `${sessionId}-original.wav` }] : []),
      ...outputs.map(([language, blob]) => ({ blob, label: `${side}${displayLanguageName(language, chineseNames)}译文音频`, filename: `${sessionId}-translation-${language}.wav` })),
      ...(outputs.length === 0 && hasHistoryAudioSamples(archive.output) ? [{ blob: archive.output, label: `${side}译文音频`, filename: `${sessionId}-translation.wav` }] : []),
    ]
    return { sessionId, tracks }
  }).filter(({ tracks }) => tracks.length > 0)
  if (groups.length === 0) return (
    <div className="session-audio-empty" role="status">
      <p>本次没有可播放的音频</p>
      <span>可查看已有文字内容，或重新开始一次同传。</span>
    </div>
  )
  return (
    <section className="session-audio-downloads" aria-label="完整音频" ref={container} onPlayCapture={(event) => {
      container.current?.querySelectorAll('audio').forEach((audio) => { if (audio !== event.target) audio.pause() })
      trackProduct('history_playback', { result: 'success' })
      onPlay()
    }}>
      <div className="session-audio-title">
        <h3>完整音频</h3>
      </div>
      <div className="session-audio-tracks">
        {groups.map(({ sessionId, tracks }) => <div key={sessionId} className="session-audio-group">
          {tracks.map(track => <AudioTrack key={track.filename} {...track} onDownload={() => showToast('已发起音频下载，请查看浏览器下载记录')} />)}
        </div>)}
      </div>
      {toast}
    </section>
  )
}
