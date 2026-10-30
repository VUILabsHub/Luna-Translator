import { useEffect, useRef, useState } from 'react'
import { createPCMStreamPlayer, type PCMStreamPlayer } from '@simultrans/ui-shared/src/audio'
import { ShowcaseFrame, SoloTranscriptRow, ShowcaseTranslationList, readShowcaseFontSize, useTranscriptFollow } from './MultilingualShowcasePage'
import { useSentenceFeedback } from '../components/SentenceFeedback'
import { finishedSessionDataFromRecord } from '../lib/finishedSessionData'
import { SharedSessionReady, type SharedSessionData } from './SharedSessionPage'
import type { ConsumerHistoryRecord } from '../lib/consumerHistory'
import { moveLeadingTranslationPunctuation } from '../lib/showcasePunctuation'
import { asrDisplayText } from '../lib/showcaseTranscript'

type LiveResponse = { record: ConsumerHistoryRecord; status: 'live' | 'paused' | 'reconnecting' | 'ended'; cursor: number; targetLanguages: string[]; expiresAt: string; audio: { seq: number; sessionId: string; language: string; sampleRate: number; audio: string }[] }
const noop = () => undefined
export function SharedLiveSession({ token, initial }: { token: string; initial: SharedSessionData }) {
  const [data, setData] = useState<LiveResponse>({ record: initial.record, status: 'live', cursor: 0, targetLanguages: [initial.record.targetLanguage], expiresAt: initial.expiresAt, audio: [] })
  const [language, setLanguage] = useState(initial.record.targetLanguage)
  const [listening, setListening] = useState(false)
  const [notice, setNotice] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [ended, setEnded] = useState(false)
  const [fontSize] = useState(readShowcaseFontSize)
  const player = useRef<PCMStreamPlayer | null>(null)
  const languageRef = useRef(language); languageRef.current = language
  const mounted = useRef(true)
  const generation = useRef(0)
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, cursor: number | undefined
    let controller: AbortController | undefined
    const poll = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 8000)
      try {
        const response = await fetch(`/api/shares/${encodeURIComponent(token)}/live${cursor === undefined ? '' : `?after=${cursor}`}`, { signal: controller.signal, cache: 'no-store' })
        if (response.status === 410 || response.status === 404) { if (!disposed) { setUnavailable(true); void player.current?.close(); player.current = null }; return }
        if (!response.ok) throw new Error('正在恢复分享连接…')
        const next = await response.json() as LiveResponse
        if (disposed) return
        setNotice('')
        for (const chunk of next.audio) {
          if (cursor !== undefined && chunk.seq <= cursor) continue
          if (chunk.language !== languageRef.current || !player.current) continue
          // TTS arrives in bursts faster than speech. A few seconds of queued
          // audio is normal, not a network failure. Keep the user-unlocked
          // AudioContext alive when catching up after a prolonged backlog.
          if ((player.current.getBufferedDurationMs?.() || 0) > 15000) {
            player.current.clearBuffer?.()
          }
          const bytes = Uint8Array.from(atob(chunk.audio), c => c.charCodeAt(0))
          player.current.push(bytes, chunk.sampleRate)
        }
        cursor = next.cursor
        setData(previous => ({ ...next, record: JSON.stringify(previous.record) === JSON.stringify(next.record) ? previous.record : next.record }))
        if (next.status === 'ended') {
          await player.current?.drain()
          if (!disposed) { await player.current?.close(); player.current = null; setEnded(true); setListening(false) }
        }
      } catch { if (!disposed) setNotice('正在恢复分享连接…') }
      finally { clearTimeout(timeout) }
      if (!disposed) timer = setTimeout(() => { void poll() }, 500)
    }
    void poll()
    return () => { disposed = true; controller?.abort(); if (timer) clearTimeout(timer) }
  }, [token])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; void player.current?.close(); player.current = null } }, [])
  const listen = async () => {
    const current = ++generation.current
    if (player.current) { void player.current.close(); player.current = null; setListening(false); return }
    try {
      const next = await createPCMStreamPlayer()
      if (!mounted.current || current !== generation.current) { await next.close(); return }
      player.current = next; setListening(true); setNotice('')
    } catch { setNotice('无法播放译音，请再次点击收听') }
  }
  const changeLanguage = (next: string) => {
    if (next === languageRef.current) return
    const wasListening = Boolean(player.current)
    generation.current++; void player.current?.close(); player.current = null; setListening(false)
    languageRef.current = next; setLanguage(next)
    if (wasListening) void listen()
  }
  const view = finishedSessionDataFromRecord(data.record)
  const rows = moveLeadingTranslationPunctuation(view.rowsByPrimaryLanguage[language] || Object.values(view.rowsByPrimaryLanguage)[0] || [])
  const follow = useTranscriptFollow(data.record.units)
  // 中途加入时已有的句子不播入场动画，只对加入后新来的句子播。
  const initialRowIds = useRef<Set<string> | null>(null)
  if (initialRowIds.current === null) initialRowIds.current = new Set(rows.map((row) => row.id))
  const initialIds = initialRowIds.current
  const feedback = useSentenceFeedback('')
  if (unavailable) return <div className="shared-session-page"><div className="shared-session-status" role="alert">分享已失效或不存在</div></div>
  if (ended) return <SharedSessionReady token={token} data={{ ...initial, record: data.record, live: true }} />
  return <ShowcaseFrame mode={view.mode} status="recording" busy paused={false} muted={!listening} guest guestListening={listening} fontSize={fontSize} restoreHeader={false}
    settings={<><a className="live-share-menu" href={`luna://share/${token}?host=${typeof window === 'undefined' ? '' : window.location.hostname}`}>在 App 中打开</a></>}
    toolbar={null} notice={notice || (data.status === 'paused' ? '同传已暂停' : data.status === 'reconnecting' ? '发起者正在恢复连接…' : '')}
    welcomeTitle="" welcomeSubtitle="" hasContent controlDisabled pauseDisabled onModeChange={noop} onControl={noop} onPause={noop} onComplete={noop} onMute={() => { void listen() }}>
    <div className={`realtime-showcase-transcript showcase-multilingual-transcript${view.mode === 'duo' ? ' showcase-duo-transcript' : ''}`} ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
      <div className="realtime-showcase-transcript-track">
        {view.mode === 'solo' ? rows.map((row, index) => <SoloTranscriptRow key={row.id} row={row} variant={index === rows.length - 1 ? 'featured' : 'history'} targetLanguages={data.targetLanguages} primaryLanguage={language} terminal={false} feedback={feedback} showFeedback={false} onPrimaryLanguage={changeLanguage} typewriterEnabled={false} onTextProgress={follow.onTextProgress} animate={!initialIds.has(row.id)} />)
        : moveLeadingTranslationPunctuation(view.bubbles || []).map((bubble, index, all) => {
          const featured = !all.slice(index + 1).some(other => other.side === bubble.side)
          return <article key={`${bubble.side}-${bubble.id}`} className={`showcase-duo-bubble showcase-duo-bubble--${bubble.side} showcase-duo-bubble--${featured ? 'featured' : 'history'}`}><p className="realtime-showcase-source">{asrDisplayText(bubble.source)}</p><ShowcaseTranslationList translations={bubble.translations} targetLanguages={bubble.targetLanguages} primaryLanguage={bubble.targetLanguages.includes(language) ? language : bubble.targetLanguages[0]} featured={featured} terminal={false} solo primaryOnly={!featured} onPrimaryLanguage={changeLanguage} typewriterEnabled={false} onTextProgress={follow.onTextProgress} /></article>
        })}
        {data.record.units.length === 0 && <p className="realtime-showcase-listening">等待发起者说话…</p>}
      </div>
    </div>
  </ShowcaseFrame>
}
