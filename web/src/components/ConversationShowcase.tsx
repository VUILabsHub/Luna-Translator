import { CommunityAudioContext } from './CommunityAudioInput'
import { createPCMReplayRecorderFactory } from '../lib/backfillAudio'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePublicConfig } from '@simultrans/ui-shared/src/lib/config'
import { useS2STHealth } from '@simultrans/ui-shared/src/lib/s2stHealth'
import { consumerQuotaLabel, fetchConsumerQuota, useMultilingualRealtimeSession, type ConsumerQuota, type MultilingualSessionMode } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import type { useAudioDevices } from '@simultrans/ui-shared/src/useAudioDevices'
import { saveHistoryAudio, type HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import type { HistoryEntry } from '@simultrans/ui-shared/src/types/history'
import { MEETING_NOISE_REDUCTIONS } from '@simultrans/core/meeting'
import { SESSION_TIME_LIMIT_MS } from '@simultrans/core/sessionLimits'
import { consumerFetch, createConsumerSessionGuard } from '@simultrans/ui-shared/src/lib/consumerSession'
import { DeviceCombobox, ShowcaseFrame, type ShowcaseFontSize } from '../pages/MultilingualShowcasePage'
import { ConversationTranscript } from './HomeConversation'
import { HomeModeSwitch } from './HomeModeSwitch'
import { FinishedSessionView } from './FinishedSessionView'
import { type MultilingualShowcaseRow } from '../lib/multilingualShowcase'
import { buildConsumerHistoryInput, checkpointConsumerHistory, clearConsumerHistoryCheckpoint, saveConsumerHistory, type ConsumerHistoryInput } from '../lib/consumerHistory'
import { finishedSessionDataFromRecord } from '../lib/finishedSessionData'
import { buildSessionSettings } from '../lib/sessionSettings'
import { quickNoiseThreshold } from '../lib/quickAudio'
import { TRANSCRIPT_DISPLAY_OPTIONS } from '../lib/transcriptDisplay'
import { CONVERSATION_LANGUAGE_OPTIONS, conversationDeviceOptions, conversationHistoryRowId, conversationTurnRoute, oppositeConversationSide, readConversationPreferences, saveConversationPreferences, type ConversationPreferences, type ConversationSide } from '../lib/conversationAudio'
import type { WebHomeMode } from '../lib/homeModes'
import { canaryGuestFetch } from '../lib/canaryGuest'
import { useConsumerIdentity } from '../hooks/useConsumerIdentity'
import { ShowcaseLanguagePicker, showcaseLanguageOption } from './ShowcaseLanguagePicker'
import '../styles/conversation-settings.css'
import { canaryAIPrivacyGate } from '../lib/aiConsent'

type AudioDevices = ReturnType<typeof useAudioDevices>
type Turn = { side: ConversationSide; sides: ConversationPreferences; revision: number }
type TurnRows = { sessionId: string; side: ConversationSide; sourceLanguage: string; targetLanguage: string; rows: MultilingualShowcaseRow[] }
const labels = { top: '上方屏幕', bottom: '下方屏幕' }
const noiseLabels = { weak: '弱', medium_weak: '较弱', default: '默认', medium_strong: '较强', strong: '强' }
const secondsLabel = (ms: number) => `${String(Math.floor(Math.max(0, ms) / 60000)).padStart(2, '0')}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`

// The public providers do not share sentence boundaries. Keep one honest pair
// per speaking turn rather than pairing independent ASR/TTS chunks by index.
function wholeTurnRows(id:string, sourceLanguage:string, target:string, source:string, translation:string): MultilingualShowcaseRow[] {
 if (!source.trim() && !translation.trim()) return []
 return [{id:conversationHistoryRowId(id,'whole-turn'),source,sourceLanguage,startMs:0,committed:true,translations:{[sourceLanguage]:source,[target]:translation},outputAudioStarts:{},outputAudioEnds:{}}]
}

type ConversationShowcaseProps = {
  audioDevices: AudioDevices; fontSize: ShowcaseFontSize; sessionMode: MultilingualSessionMode; meetingAvailable: boolean; onHomeModeChange: (mode: WebHomeMode) => void
}

/** Private turns and pending saves belong to one login, even when ConsumerGate keeps its children mounted. */
export function ConversationShowcase(props: ConversationShowcaseProps) {
  const identity = useConsumerIdentity()
  return <OwnedConversationShowcase key={`${props.sessionMode}:${identity}`} {...props} />
}

/** One live direction at a time. Rows and archive IDs outlive a physical turn. */
function OwnedConversationShowcase({ audioDevices, fontSize, sessionMode, meetingAvailable, onHomeModeChange }: ConversationShowcaseProps) {
  const [initial] = useState(readConversationPreferences)
  const [sides, setSides] = useState(initial.sides)
  const sidesRef = useRef(sides); sidesRef.current = sides
  const [languageOpen, setLanguageOpen] = useState<ConversationSide | null>(null)
  const [speaker, setSpeaker] = useState<ConversationSide>('bottom')
  const [turn, setTurn] = useState<Turn>({ side: 'bottom', sides: initial.sides, revision: 0 })
  const turnRef = useRef(turn); turnRef.current = turn
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)
  const [finished, setFinished] = useState(false)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [changing, setChanging] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const pageExited = useRef(false)
  const pageGeneration = useRef(0)
  const pageEnded = useRef(false)
  const [loginCurrent] = useState(() => sessionMode === 'consumer' ? createConsumerSessionGuard() : () => true)
  const isCurrent = () => mounted.current && !pageExited.current && loginCurrent()
    && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const operationLease = () => {
    const generation = pageGeneration.current
    return () => isCurrent() && generation === pageGeneration.current
  }
  const [guestQuota, setGuestQuota] = useState<ConsumerQuota | null>(null)
  const [guestQuotaStatus, setGuestQuotaStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const guestQuotaRevision = useRef(0)
  const receiveGuestQuota = (quota: ConsumerQuota) => {
    if (sessionMode !== 'guest' || !isCurrent()) return
    ++guestQuotaRevision.current
    const valid = Number.isFinite(quota.remainingMinutes)
    setGuestQuota(valid ? quota : null)
    setGuestQuotaStatus(valid ? 'ready' : 'unavailable')
  }
  const commit = useRef<(() => void) | null>(null)
  const [notice, setNotice] = useState('')
  const [completedTurns, setCompletedTurns] = useState<TurnRows[]>([])
  const completedRef = useRef<TurnRows[]>([])
  const archives = useRef<Record<string, HistoryAudioArchive>>({})
  const [savedHistoryId, setSavedHistoryId] = useState('')
  const [liveServerId, setLiveServerId] = useState('')
  const [saving, setSaving] = useState(false)
  const startedAt = useRef(0)
  const finishedAt = useRef(0)
  const completionReason = useRef<'client_stopped' | 'session_time_limit'>('client_stopped')
  const limitTriggered = useRef(false)
  const [now, setNow] = useState(Date.now())
  const { config, loadFailed } = usePublicConfig()
  const provider = config?.providers.find(item => item.id === config.defaultProvider && item.ready && !item.id.endsWith('-volc-rtc'))
    || config?.providers.find(item => item.ready && /qwen3simul/.test(item.id) && !item.id.endsWith('-volc-rtc'))
    || config?.providers.find(item => item.ready && !item.id.endsWith('-volc-rtc'))
  const health = useS2STHealth(Boolean(provider))
  const route = conversationTurnRoute(turn.sides, turn.side, audioDevices.streamOutputSelectionSupported)
  const receiver = route.receiver
  const liveVolume = sides[receiver].volume / 100
  const targetLanguages = useMemo(() => [route.targetLanguage], [route.targetLanguage])
  const mutedLanguages = useMemo(() => new Set(muted ? targetLanguages : []), [muted, targetLanguages])
  const runtimeRef = useRef<ReturnType<typeof useMultilingualRealtimeSession> | null>(null)
  const recordTurn = (entry: HistoryEntry, audio: HistoryAudioArchive) => {
    if (!isCurrent()) return
    const snapshot = turnRef.current
    const target = snapshot.sides[oppositeConversationSide(snapshot.side)].language
    const recordedOutput = entry.multilingualOutputs?.find(output => output.targetLanguage === target)
    const rows = wholeTurnRows(entry.id, snapshot.sides[snapshot.side].language, target, entry.sourceText || '', recordedOutput?.translationText || '')
    const value: TurnRows = { sessionId: entry.id, side: snapshot.side, sourceLanguage: snapshot.sides[snapshot.side].language, targetLanguage: target, rows }
    completedRef.current = [...completedRef.current.filter(turn => turn.sessionId !== entry.id), value]
    archives.current[entry.id] = audio
    void saveHistoryAudio(entry.id, audio).catch(() => undefined)
    if (isCurrent()) setCompletedTurns(completedRef.current)
  }
  const communityAudio=useContext(CommunityAudioContext)
  const communityRecorder=useMemo(()=>communityAudio.pcm?createPCMReplayRecorderFactory({pcm:communityAudio.pcm,paceFactor:1,onDone:()=>window.dispatchEvent(new Event('community:audio-ended'))}):undefined,[communityAudio.pcm])
  const session = useMultilingualRealtimeSession({
    endOnPageExit: true,
    recorderFactory:communityRecorder,
    privacyGate: sessionMode !== 'eval' ? canaryAIPrivacyGate : undefined,
    mode: sessionMode, guestFetcher: sessionMode === 'guest' ? canaryGuestFetch : undefined,
    onQuota: sessionMode === 'guest' ? receiveGuestQuota : undefined,
    provider: provider?.id || '', baseProviderId: provider?.id || '', model: provider?.model || '', service: 'websocket', transport: 'websocket', sessionLayout: 'solo',
    sourceLanguage: route.sourceLanguage, targetLanguages, priorityLanguage: route.targetLanguage,
    inputDeviceId: route.inputDeviceId, outputDeviceId: route.outputDeviceId, playbackVolume: liveVolume,
    effectiveVoiceClone: provider?.voiceClone === true, selectedVoice: '', deepFilterNet: false, qwen3ModelIntervalMs: 2000,
    vadLoudnessMode: 'frame_rms', vadLoudnessThresholdDbfs: quickNoiseThreshold(turn.sides[turn.side].noiseReduction), inputProcessing: 'system', webRTCEchoCancellation: true,
    ready: Boolean(provider?.ready && health.available === true), notReadyReason: loadFailed ? '无法读取服务配置，请稍后刷新。' : health.reason || '同传服务尚未就绪。',
    mutedLanguages, refreshAudioDevices: () => { void audioDevices.refresh() }, onSessionRecorded: recordTurn,
  })
  useEffect(()=>{const stop=()=>{void session.stop()};window.addEventListener('community:audio-ended',stop);return()=>window.removeEventListener('community:audio-ended',stop)},[session.stop])
  useEffect(()=>{communityAudio.setBusy(['connecting','recording','processing'].includes(session.status));return()=>communityAudio.setBusy(false)},[session.status,communityAudio.setBusy])
  runtimeRef.current = session
  useEffect(() => {
    if (sessionMode !== 'guest' || !['idle', 'finished', 'error'].includes(session.status)) return
    let active = true
    const revision = ++guestQuotaRevision.current
    setGuestQuotaStatus('loading')
    void fetchConsumerQuota(canaryGuestFetch).then(quota => {
      if (!active || !isCurrent() || revision !== guestQuotaRevision.current) return
      const valid = quota !== null && Number.isFinite(quota.remainingMinutes)
      setGuestQuota(valid ? quota : null)
      setGuestQuotaStatus(valid ? 'ready' : 'unavailable')
    })
    return () => { active = false }
  }, [sessionMode, session.status, finished])
  useEffect(() => {
    if (started && !finished && !changing && (session.status === 'error' || session.status === 'finished' || session.status === 'idle')) setPaused(true)
  }, [started, finished, changing, session.status])
  useLayoutEffect(() => { commit.current?.(); commit.current = null }, [turn.revision])
  useEffect(() => { saveConversationPreferences(sides) }, [sides])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; commit.current?.(); commit.current = null }
  }, [])
  useEffect(() => {
    if (!started || finished) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [started, finished])

  const assertDevices = (next: ConversationPreferences, side: ConversationSide) => {
    if (!audioDevices.initialized || !audioDevices.permissionGranted) return
    const input = next[side].inputDeviceId
    const output = next[oppositeConversationSide(side)].outputDeviceId
    if (input !== 'default' && !audioDevices.inputDevices.some(device => device.deviceId === input)) throw new Error(`${labels[side]}的输入设备已断开，请重新选择。`)
    if (audioDevices.streamOutputSelectionSupported && output !== 'default' && !audioDevices.outputDevices.some(device => device.deviceId === output)) throw new Error(`${labels[oppositeConversationSide(side)]}的输出设备已断开，请重新选择。`)
  }
  const commitTurn = async (side: ConversationSide, next: ConversationPreferences) => {
    const committed = new Promise<void>(resolve => { commit.current = resolve })
    setTurn(previous => ({ side, sides: next, revision: previous.revision + 1 }))
    await committed
  }
  const switchTurn = async (side: ConversationSide, next = sidesRef.current) => {
    if (!isCurrent() || lock.current || finished || pageEnded.current) return
    const current = operationLease()
    lock.current = true; setChanging(true); setNotice('')
    try {
      assertDevices(next, side)
      if (startedRef.current && !await runtimeRef.current!.stopAndDrain()) throw new Error(runtimeRef.current!.error || '上一轮未能完成收尾，请重试。')
      if (!current()) return
      setLiveServerId('')
      sidesRef.current = next; setSides(next)
      setSpeaker(side)
      await commitTurn(side, next)
      if (!current()) return
      const serverId = await runtimeRef.current!.start({}, current)
      if (!current()) return
      if (typeof serverId !== 'string' || !serverId) throw new Error(runtimeRef.current!.error || '本轮未能开始，请检查设备后重试。')
      if (!startedRef.current) { startedAt.current = Date.now(); startedRef.current = true; setStarted(true) }
      setLiveServerId(serverId)
      setPaused(false)
    } catch (error) { if (current()) { setNotice(error instanceof Error ? error.message : '切换失败，请重试。'); setPaused(startedRef.current) } }
    finally { if (current()) { lock.current = false; setChanging(false) } }
  }
  const update = async (side: ConversationSide, patch: Partial<ConversationPreferences[ConversationSide]>) => {
    if (!isCurrent() || lock.current || finished) return
    const current = operationLease()
    const next = { ...sidesRef.current, [side]: { ...sidesRef.current[side], ...patch } }
    if (patch.language && next.top.language === next.bottom.language) return
    setNotice('')
    if (startedRef.current && (patch.language || (patch.noiseReduction && side === turnRef.current.side)) && !paused) { await switchTurn(speaker, next); return }
    if (startedRef.current && paused) {
      sidesRef.current = next; setSides(next)
      setNotice('恢复收音后应用所选设置。')
      return
    }
    lock.current = true; setChanging(true)
    try {
      if (startedRef.current && !paused && patch.inputDeviceId && side === turnRef.current.side) {
        if (!await runtimeRef.current!.changeInputDevice(patch.inputDeviceId)) throw new Error(runtimeRef.current!.error || '麦克风切换失败，已保留原设备。')
      }
      if (startedRef.current && patch.outputDeviceId && side === oppositeConversationSide(turnRef.current.side)) {
        if (!audioDevices.streamOutputSelectionSupported) throw new Error('当前浏览器不支持切换输出，播放设备跟随系统。')
        if (!paused && !await runtimeRef.current!.changeOutputDevice(patch.outputDeviceId)) throw new Error(runtimeRef.current!.error || '输出设备切换失败，已保留原设备。')
      }
      if (!current()) return
      sidesRef.current = next; setSides(next)
      // Resume/capture and subsequent players must also receive the acknowledged selection.
      await commitTurn(turnRef.current.side, next)
    } catch (error) { if (current()) setNotice(error instanceof Error ? error.message : '设备切换失败。') }
    finally { if (current()) { lock.current = false; setChanging(false) } }
  }
  const volume = (side: ConversationSide, value: number) => {
    if (!isCurrent() || lock.current || finished) return
    const next = { ...sidesRef.current, [side]: { ...sidesRef.current[side], volume: value } }
    sidesRef.current = next; setSides(next)
  }
  const pauseOrResume = async () => {
    if (!isCurrent() || lock.current) return
    const current = operationLease()
    if (paused) { await switchTurn(speaker); return }
    lock.current = true; setChanging(true)
    try {
      const ok = await runtimeRef.current!.pause()
      if (!current()) return
      if (!ok) throw new Error(runtimeRef.current!.error || '暂停未完成，请重试。')
      setPaused(true)
    } catch (error) { if (current()) setNotice(error instanceof Error ? error.message : '暂停未完成，请重试。') }
    finally { if (current()) { lock.current = false; setChanging(false) } }
  }
  const currentRows = liveServerId && session.parentSessionID === liveServerId
    ? wholeTurnRows(liveServerId, route.sourceLanguage, route.targetLanguage, session.sourceText, session.outputs[route.targetLanguage]?.translation || '') : []
  const allTurns = [...completedTurns.filter(turn => turn.sessionId !== liveServerId || currentRows.length === 0), ...(liveServerId && currentRows.length > 0 ? [{ sessionId: liveServerId, side: turn.side, sourceLanguage: route.sourceLanguage, targetLanguage: route.targetLanguage, rows: currentRows }] : [])]
  const allRows = allTurns.flatMap(turn => turn.rows.map(row => ({ ...row, sourceLanguage: turn.sourceLanguage })))
  const settings = buildSessionSettings({ mode: 'solo', scene: 'conversation', provider: provider?.id, sourceLanguage: 'auto', targetLanguages: [...new Set(allTurns.flatMap(turn => [turn.sourceLanguage, turn.targetLanguage]))], service: 'websocket', voiceClone: provider?.voiceClone, echoCancellation: true, vadLoudnessMode: 'frame_rms', vadLoudnessThresholdDbfs: quickNoiseThreshold(sides[speaker].noiseReduction), fontSize })
  const historyInput = (turns: TurnRows[]): ConsumerHistoryInput => buildConsumerHistoryInput({
    sessionId: [...new Set(turns.map(turn => turn.sessionId))].join(':'), provider: provider?.id || '', sourceLanguage: 'auto', targetLanguages: [...new Set(turns.flatMap(turn => [turn.targetLanguage, turn.sourceLanguage]))], durationMs: startedAt.current ? (finishedAt.current || Date.now()) - startedAt.current : 0,
    rows: turns.flatMap(turn => turn.rows), settings,
    devices: {
      inputs: (['top', 'bottom'] as const).map(side => ({ side: side === 'top' ? 'a' : 'b', label: conversationDeviceOptions(audioDevices.inputDevices, sidesRef.current[side].inputDeviceId, 'input', audioDevices.defaultInputDeviceLabel).find(option => option.value === sidesRef.current[side].inputDeviceId)?.label || '跟随系统麦克风' })),
      outputs: (['top', 'bottom'] as const).map(side => ({ side: side === 'top' ? 'a' : 'b', label: conversationDeviceOptions(audioDevices.outputDevices, sidesRef.current[side].outputDeviceId, 'output', audioDevices.defaultOutputDeviceLabel).find(option => option.value === sidesRef.current[side].outputDeviceId)?.label || '跟随系统输出' })),
    },
  })
  const checkpointRef = useRef<ConsumerHistoryInput | null>(null)
  checkpointRef.current = started && !finished && allRows.length ? historyInput(allTurns) : null
  useEffect(() => {
    const exit = () => {
      if (!mounted.current || pageExited.current) return
      const canCheckpoint = loginCurrent()
      // Fence pending speaker/device/save continuations immediately. Preserve
      // the existing local snapshot without waiting for a server on page exit.
      pageExited.current = true
      pageGeneration.current += 1
      const active = startedRef.current || lock.current
      lock.current = false
      commit.current?.(); commit.current = null
      if (active) { pageEnded.current = true; setFinished(true) }
      setChanging(false)
      try {
        if (canCheckpoint && sessionMode === 'consumer' && checkpointRef.current) checkpointConsumerHistory(checkpointRef.current)
      } catch { /* A storage failure must never keep a departed session alive. */ }
    }
    const visible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') pageExited.current = false }
    const visibility = () => { if (document.visibilityState === 'hidden') exit(); else visible() }
    window.addEventListener('pagehide', exit)
    window.addEventListener('pageshow', visible)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pagehide', exit)
      window.removeEventListener('pageshow', visible)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
    }
  }, [sessionMode])
  const finish = async (reason = completionReason.current) => {
    if (!isCurrent() || pageEnded.current) return
    const current = operationLease()
    if (lock.current) throw new Error('正在应用设置，请稍后再结束本场对话。')
    lock.current = true; setChanging(true); setNotice('')
    completionReason.current = reason
    try {
      const stopped = !startedRef.current || await runtimeRef.current!.stopAndDrain()
      if (!current()) return
      if (!stopped) throw new Error('正在等待最后一句完成，请稍后重试。')
      if (!current()) return
      if (!finishedAt.current) finishedAt.current = Date.now()
      const turns = completedRef.current
      if (sessionMode === 'consumer' && turns.length > 0) {
        setSaving(true)
        const input = { ...historyInput(turns), completionReason: reason, abnormalExit: false }
        checkpointConsumerHistory(input)
        const result = await saveConsumerHistory(input, consumerFetch)
        if (!current()) return
        clearConsumerHistoryCheckpoint(input.sessionId)
        if (current()) setSavedHistoryId(result.id)
      }
      if (current()) setFinished(true)
    } catch (error) { if (current()) { setNotice(error instanceof Error ? error.message : '无法保存本场对话，请重试。'); setPaused(true); throw error } }
    finally { if (current()) { lock.current = false; setChanging(false); setSaving(false) } }
  }
  useEffect(() => {
    if (!started || finished || limitTriggered.current || !startedAt.current || now - startedAt.current < SESSION_TIME_LIMIT_MS || lock.current) return
    limitTriggered.current = true
    void finish('session_time_limit').catch(() => undefined)
  }, [started, finished, now])

  if (finished) {
    const input = historyInput(pageEnded.current ? allTurns : completedRef.current)
    const data = finishedSessionDataFromRecord({ ...input, id: savedHistoryId, createdAt: new Date().toISOString(), completionReason: completionReason.current, abnormalExit: pageEnded.current })
    return <FinishedSessionView data={data} archives={archives.current} backHref="/?mode=conversation" />
  }
  const ready = Boolean(provider?.ready && health.available === true)
  const remaining = startedAt.current ? SESSION_TIME_LIMIT_MS - (now - startedAt.current) : SESSION_TIME_LIMIT_MS
  const drawer = <div className="conversation-settings" aria-label="对话模式设置">
    <h2>对话模式设置</h2>
    {(['top', 'bottom'] as const).map(side => <fieldset key={side} className="conversation-settings-side" aria-label={`${labels[side]}设置`}>
      <legend>{labels[side]}（{side === 'top' ? '对方' : '自己'}）</legend>
      <div className="conversation-settings-row"><span>语言</span><ShowcaseLanguagePicker ariaLabel={`${labels[side]}语言`} value={[sides[side].language]} options={CONVERSATION_LANGUAGE_OPTIONS.map(option => ({ ...showcaseLanguageOption(option.value), disabled: option.value === sides[oppositeConversationSide(side)].language }))} open={languageOpen === side} disabled={changing} onOpenChange={value => setLanguageOpen(value ? side : null)} onSelect={language => { void update(side, { language }) }} /></div>
      <div className="conversation-settings-row"><span>输入设备</span><DeviceCombobox ariaLabel={`选择${labels[side]}输入设备`} options={conversationDeviceOptions(audioDevices.inputDevices, sides[side].inputDeviceId, 'input', audioDevices.defaultInputDeviceLabel)} value={sides[side].inputDeviceId} disabled={changing || !audioDevices.mediaDeviceSupported} onOpen={() => { void audioDevices.refresh() }} onChange={value => { void update(side, { inputDeviceId: value }) }} /></div>
      <div className="conversation-settings-row"><span>输出设备</span>{audioDevices.streamOutputSelectionSupported ? <DeviceCombobox ariaLabel={`选择${labels[side]}输出设备`} options={conversationDeviceOptions(audioDevices.outputDevices, sides[side].outputDeviceId, 'output', audioDevices.defaultOutputDeviceLabel)} value={sides[side].outputDeviceId} disabled={changing} onOpen={() => { void audioDevices.refresh() }} onChange={value => { void update(side, { outputDeviceId: value }) }} /> : <span className="conversation-device-system" aria-label={`${labels[side]}输出设备：跟随系统`}>跟随系统</span>}</div>
      <label className="conversation-settings-row"><span>原译显示</span><select aria-label={`${labels[side]}原译显示`} value={sides[side].displayMode} onChange={event => { void update(side, { displayMode: event.target.value as ConversationPreferences[ConversationSide]['displayMode'] }) }}>{TRANSCRIPT_DISPLAY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="conversation-settings-volume">降噪模式 <span>{noiseLabels[sides[side].noiseReduction]}</span><input aria-label={`${labels[side]}降噪模式`} aria-valuetext={noiseLabels[sides[side].noiseReduction]} type="range" min="0" max="2" step="1" value={MEETING_NOISE_REDUCTIONS.indexOf(sides[side].noiseReduction)} disabled={changing} onChange={event => { void update(side, { noiseReduction: MEETING_NOISE_REDUCTIONS[Number(event.target.value)] }) }} /></label>
      <label className="conversation-settings-volume">播放音量 <span>{sides[side].volume}%</span><input aria-label={`${labels[side]}播放音量`} type="range" min="0" max="100" disabled={changing} value={sides[side].volume} onChange={event => volume(side, Number(event.target.value))} /></label>
    </fieldset>)}
    {!audioDevices.streamOutputSelectionSupported && <p className="conversation-settings-note">当前浏览器不支持网页分别选择输出设备，双方均跟随系统；两侧译音音量仍独立生效。</p>}
    <p className="conversation-settings-note">过滤本人识别与翻译输入中的轻声；强档可能忽略较轻讲话。{started ? '调整后完成当前句并应用。' : ''}</p>
    {(notice || session.error) && <p role="alert" className="conversation-settings-note">{notice || session.error}</p>}
    {changing && <p role="status" className="conversation-settings-note">正在应用设置，保留已有字幕…</p>}
    <div className="conversation-settings-row"><span>本场剩余时间</span><time>{secondsLabel(remaining)}</time></div>
    {sessionMode === 'guest' && <>
      <p role="status" className="conversation-settings-note">{guestQuotaStatus === 'ready' && guestQuota
        ? consumerQuotaLabel(guestQuota) : guestQuotaStatus === 'loading' ? '正在获取今日额度…' : '今日额度暂不可用'}</p>
      {started || changing
        ? <button className="conversation-settings-link" type="button" disabled>历史记录（登录后查看）</button>
        : <a className="conversation-settings-link" href="/history">历史记录（登录后查看）</a>}
    </>}
    {sessionMode === 'consumer' && <button className="conversation-settings-link" type="button" disabled={started} onClick={() => window.location.assign('/history')}>历史记录</button>}
    {started && sessionMode !== 'eval' && <p className="conversation-settings-note">结束本场对话后可查看历史记录</p>}
  </div>
  return <ShowcaseFrame mode="solo" scene="conversation" fontSize={fontSize} status={started ? 'recording' : session.status === 'connecting' ? 'connecting' : 'idle'} paused={paused} muted={muted} busy={started || changing} restoreHeader={false}
    settings={drawer} onSettingsClose={() => setLanguageOpen(null)} toolbar={<p className="conversation-idle-languages">{CONVERSATION_LANGUAGE_OPTIONS.find(option => option.value === sides.top.language)?.label} ⇄ {CONVERSATION_LANGUAGE_OPTIONS.find(option => option.value === sides.bottom.language)?.label}</p>}
    homeModes={<HomeModeSwitch value="conversation" disabled={started || changing} meetingAvailable={meetingAvailable} onChange={onHomeModeChange} />}
    notice={notice || session.error || audioDevices.error || (!ready ? health.reason || (loadFailed ? '无法读取服务配置，请刷新重试。' : '') : '')}
    infoNotice={changing ? '正在切换收音，上一句完成后继续。' : saving ? '正在保存本场对话…' : undefined}
    welcomeTitle="面对面对话" welcomeSubtitle="双方设备与播放音量可分别设置" hasContent={allRows.length > 0} controlDisabled={!ready || changing} pauseDisabled={changing}
    onModeChange={() => undefined} onControl={() => switchTurn(speaker)} onMute={() => setMuted(value => !value)} startLabel="开始对话"
    onPause={() => { void pauseOrResume() }}
    onComplete={() => { void finish().catch(() => undefined) }} onLeave={finish} leaveReady={!started || finished}>
    <ConversationTranscript languages={[sides.top.language, sides.bottom.language]} rowsByLanguage={{ [sides.top.language]: allRows, [sides.bottom.language]: allRows }} activeSide={speaker} onActiveSideChange={side => { if (side !== speaker && !changing) void switchTurn(side) }} displayModes={{ top: sides.top.displayMode, bottom: sides.bottom.displayMode }} speakingControls disabled={changing} />
  </ShowcaseFrame>
}
