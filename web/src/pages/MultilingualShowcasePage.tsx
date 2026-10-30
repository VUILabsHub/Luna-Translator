import { CommunityAudioContext } from '../components/CommunityAudioInput'
import { TRANSCRIPT_DISPLAY_OPTIONS, readQuickTranscriptDisplay, saveQuickTranscriptDisplay, type TranscriptDisplayMode } from '../lib/transcriptDisplay'
import { SpeakInvitationBar } from '../components/SpeakInvitationBar'
import { AppSettingsDrawer } from '../components/AppSettingsDrawer'
import { QuickAudioSettings } from '../components/QuickAudioSettings'
import { quickNoiseThreshold, readQuickAudio, saveQuickAudio } from '../lib/quickAudio'
import { CanaryGuestContext, canaryGuestFetch } from '../lib/canaryGuest'
import { canaryDesignEnabled } from '../lib/canaryDesign'
import { translationTargets } from '@simultrans/core/translationLanguages'
import { HistorySessionSummary } from '../components/HistorySessionSummary'
import { useHistoryTitle } from '../hooks/useHistoryTitle'
import { ShowcaseBackButton } from '../components/ShowcaseBackButton'
import { HomeModeSwitch } from '../components/HomeModeSwitch'
import { HomeProfileButton } from '../components/HomeProfileButton'
import { ConversationLanguageControls, ConversationTranscript } from '../components/HomeConversation'
import { HOME_MODE_OPTIONS, SCENE_COPY, canonicalProductHomeURL, isHiddenHomeScene, isVisibleHomeMode, productHomeScene, readScenePreferences, writeScenePreferences, type WebHomeMode, type WebSceneMode } from '../lib/homeModes'
import { soloTargetLanguageLimit, useSettingsCatalog } from '../lib/settingsCatalog'
import { createMeetingAPI } from '@simultrans/core/meeting'
import { canStartDuoShowcase } from '../lib/showcaseHostPolicy'
import { ShowcaseMotionArticle } from '../components/ShowcaseMotionArticle'
import { createTranscriptMotion } from '../lib/transcriptMotion'
import { asrDisplayText } from '../lib/showcaseTranscript'
import { defaultAudioDeviceLabel, displayAudioDeviceLabel, isHeadsetEarpieceLabel } from '../lib/audioDeviceLabel'
import { moveLeadingTranslationPunctuation } from '../lib/showcasePunctuation'
import { sessionTimeLimitNotice } from '../lib/sessionRecovery'
import { earliestSessionEndsAt, useSessionEndingCountdown } from '../hooks/useSessionEndingCountdown'
import { slicePlaybackWav } from '../lib/playbackWav'
import { useModelInputArchive } from '../hooks/useModelInputArchive'
import { beginProductAttempt, trackProduct } from '@simultrans/ui-shared/src/lib/productAnalytics'
import { useProductSessionAnalytics, type ProductAttempt } from '../hooks/useProductSessionAnalytics'
import { useTranscriptPlaybackGesture } from '../hooks/useTranscriptPlaybackGesture'
import { LiveShareConfirmation } from '../components/LiveShareConfirmation'
import { SessionShareDialog } from '../components/SessionShareDialog'
import { ConsumerRecordShare } from '../components/ConsumerRecordShare'
import { useLiveSharing, existingLiveShare, type ShareSnapshot, type LivePublishStatus } from '../hooks/useLiveSharing'
import { limitShowcaseTargets, normalizeShowcaseSourceLanguage, readShowcasePreferences, showcaseSourceLanguages, writeShowcasePreferences } from '../lib/showcasePreferences'
import { SessionAudioDownloads } from '../components/SessionAudioDownloads'
import { SentencePlaybackIcon } from '../components/SentencePlaybackIcon'
import { Children, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ShowcaseCombobox, { type ShowcaseComboboxOption } from '../components/ShowcaseCombobox'
import ShowcaseAudioProcessingSettings from '../components/ShowcaseAudioProcessingSettings'
import { ShowcaseLanguageSettings, defaultShowcaseSystemPrompt } from '../components/ShowcaseLanguageSettings'
import { readShowcaseHotwords, type HotwordMode } from '../lib/showcaseHotwords'
import { showcaseDemoOutputs } from '../lib/showcaseDemoOutputs'
import { ShowcaseSettingsInfoButton, ShowcaseSettingsInfoDialog } from '../components/ShowcaseSettingsInfoDialog'
import { ShowcaseConfirmDialog } from '../components/ShowcaseConfirmDialog'
import type { ShowcaseSettingsInfoTopic } from '../lib/showcaseSettingsInfo'
import { ShowcaseTypewriterText } from '../components/ShowcaseTypewriterText'
import { retainReadingHighlight } from '../lib/showcaseReadingHighlight'
import { SentenceFeedback, useSentenceFeedback, type SentenceFeedbackHandle } from '../components/SentenceFeedback'
import { useHistorySync } from '@simultrans/ui-shared/src/hooks/useHistorySync'

import { useMultilingualSemanticLayouts } from '../hooks/useMultilingualSemanticLayouts'
import { useSegmentedShowcaseTypewriter } from '../hooks/useSegmentedShowcaseTypewriter'
import {
  consumerQuotaLabel,
  fetchConsumerQuota,
  useMultilingualRealtimeSession,
  type ConsumerQuota,
  type MultilingualSessionMode,
} from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import type { Status } from '@simultrans/ui-shared/src/hooks/useSessionRuntime'
import { consumerFetch, isLoggedIn, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'
import { buildSessionSettings } from '../lib/sessionSettings'
import {
  buildConsumerHistoryInput,
  checkpointConsumerHistory,
  clearConsumerHistoryCheckpoint,
  copySnapshotLink,
  createConsumerShareLink,
  appendConsumerHistoryLanguage,
  loadConsumerHistoryAudio,
  lookupConsumerHistoryId,
  retryConsumerHistoryCheckpoints,
  saveConsumerHistory,
  type ConsumerHistoryInput,
} from '../lib/consumerHistory'
import {
  omniTargetLanguages,
} from '@simultrans/ui-shared/src/languageCapabilities'
import { usePublicConfig, type PublicProvider } from '@simultrans/ui-shared/src/lib/config'
import {
  frameRMSLoudnessOptions,
  p90LoudnessOptions,
  storedFrameRMSThreshold,
  storedP90Threshold,
  storedVADLoudnessMode,
  type FrameRMSLoudnessThresholdDbfs,
  type P90LoudnessThresholdDbfs,
  type VADLoudnessMode,
  type VADLoudnessThresholdDbfs,
} from '@simultrans/ui-shared/src/lib/audioProcessing'
import { SESSION_MODE_LABELS, SETTINGS_PANEL_COPY, WELCOME_COPY } from '@simultrans/core/sessionLabels'
import {
  buildMultilingualShowcaseRows,
  buildPrimaryDrivenMultilingualRows,
  combineDuoStatus,
  featuredShowcaseRowId,
  selectDuoLanguageLayouts,
  mergeDuoSpeakerRows,
  showcaseAudioEndMs,
  validateDuoMicrophones,
  validateDuoOutputDevices,
  validateDuoStereoMicrophone,
  type DuoShowcaseBubble,
  type MultilingualShowcaseRow,
} from '../lib/multilingualShowcase'
import { combinePlaybackStatuses, type ShowcasePlaybackStatus } from '@simultrans/ui-shared/src/lib/showcaseRows'
import { remapPlaybackFragments } from '@simultrans/ui-shared/src/lib/playbackText'
import { voiceOptions } from '@simultrans/ui-shared/src/lib/providers'
import { baseProviderID, routesForService, serviceForProvider } from '@simultrans/ui-shared/src/lib/realtimeRouteSelection'
import { useS2STHealth } from '@simultrans/ui-shared/src/lib/s2stHealth'
import { showcaseHomePath } from '../lib/showcaseNavigation'
import { filterSilentHistoryAudio, hasHistoryAudioSamples, loadHistoryAudio, type HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { BACKFILL_BUSY_MESSAGE } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import { isMobileBrowser } from '../lib/mobileBrowser'
import { environmentNoticeAcknowledged, readEnvironmentNoticeState, shouldShowEnvironmentNotice, writeEnvironmentNoticeState } from '../lib/environmentNotice'
import type { RecorderFactory } from '@simultrans/ui-shared/src/audio'
import { BACKFILL_DEFAULT_PACE_FACTOR, createPCMReplayRecorderFactory, wavToPCM16Mono16k } from '../lib/backfillAudio'
import type { HistoryEntry } from '@simultrans/ui-shared/src/types/history'
import { preferredDJIInputDevice, preferredExternalInputDevice, useAudioDevices, type AudioDeviceOption } from '@simultrans/ui-shared/src/useAudioDevices'
import { hasExplicitMonitorOutputId, monitorOutputConflict } from '@simultrans/ui-shared/src/lib/audioMonitorDevices'
import { useAutomaticAudioMonitor } from '@simultrans/ui-shared/src/hooks/useAutomaticAudioMonitor'
import { createSharedStereoRecorderFactories } from '../stereoRecorder'
import { ConversationShowcase } from '../components/ConversationShowcase'
import { HomeMeetingScanner } from '../components/HomeMeetingScanner'
import { readShowcaseTextSize } from '../lib/showcaseAppearance'
import { canaryAIPrivacyGate } from '../lib/aiConsent'
import { ShowcaseLanguagePicker } from '../components/ShowcaseLanguagePicker'

type ShowcaseMode = 'solo' | 'duo'
type DuoMicrophoneMode = 'separate' | 'stereo'
type DuoOutputMode = 'separate' | 'stereo'

type ShowcaseReturnView = {
  mode: 'solo'
  scene?: WebSceneMode
  sessionId: string
  provider: string
  sourceLanguage: string
  targetLanguages: string[]
  primaryLanguage: string
  rows: MultilingualShowcaseRow[]
  rowsByPrimaryLanguage?: Record<string, MultilingualShowcaseRow[]>
  // 结束页「分享」依赖已保存的历史记录 id；去历史页再返回时随视图一起恢复，
  // 否则按钮会一直停在禁用态。
  historyId?: string
} | {
  mode: 'duo'
  leftSessionId: string
  rightSessionId: string
  provider: string
  leftSourceLanguage: string
  rightSourceLanguage: string
  leftTargetLanguages: string[]
  rightTargetLanguages: string[]
  leftPrimaryLanguage: string
  rightPrimaryLanguage: string
  bubbles: DuoShowcaseBubble[]
  historyId?: string
}

const showcaseReturnViewKey = 'simultrans.showcaseReturnView'
function readShowcaseReturnView(): ShowcaseReturnView | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(showcaseReturnViewKey) || 'null') as ShowcaseReturnView | null
    return value?.mode === 'solo' || value?.mode === 'duo' ? value : null
  } catch {
    return null
  }
}

function writeShowcaseReturnView(value: ShowcaseReturnView) {
  try { sessionStorage.setItem(showcaseReturnViewKey, JSON.stringify(value)) } catch { /* Browser history still works without restoration. */ }
}

function clearShowcaseReturnView() {
  try { sessionStorage.removeItem(showcaseReturnViewKey) } catch { /* Ignore unavailable sessionStorage. */ }
}

type ShowcaseTranslationModel = 'flash-v2' | 'flash' | 'pro'
type ShowcaseTTSModel = 'qwen' | 'qwen17b' | 'omnivoice' | 'omnivoice-xc' | 'qwentts-sc'
type ShowcaseService = 'websocket' | 'volc-rtc'
export type ShowcaseFontSize = 'small' | 'standard' | 'large'
type ShowcaseNoisePreset = 'headphones' | 'echo-cancellation' | 'demo' | 'demo-presentation' | 'phone-call' | 'custom'

const showcaseMenuSettingsKey = 'simultrans.showcaseMenuSettings'

type ShowcaseMenuSettings = {
  hotwordMode?: HotwordMode
  asrContext?: string
  qwen3SimulSystemPrompt?: string
  service?: ShowcaseService
  provider?: string
  webRTCEchoCancellation?: boolean
  deepFilterNet?: boolean
  highlightReadingTextOnly?: boolean
  vadLoudnessMode?: VADLoudnessMode
  frameRMSLoudnessThresholdDbfs?: FrameRMSLoudnessThresholdDbfs
  p90LoudnessThresholdDbfs?: P90LoudnessThresholdDbfs
  soloInputDeviceId?: string
  soloOutputDeviceId?: string
  /** 手机通话模式：采集走浏览器/系统 AEC·NS·AGC（docs/web-phone-call-mode-plan.md）。 */
  systemInputProcessing?: boolean
  /** 手机浏览器上用户手动选过降噪模式：之后不再按「耳机 / 自带麦」自动切换。 */
  mobileNoisePresetManual?: boolean
  duoMicrophoneMode?: DuoMicrophoneMode
  leftDeviceId?: string
  rightDeviceId?: string
  stereoDeviceId?: string
  swapStereoChannels?: boolean
  leftOutputDeviceId?: string
  rightOutputDeviceId?: string
  duoOutputMode?: DuoOutputMode
  stereoOutputDeviceId?: string
}

function readShowcaseMenuSettings(): ShowcaseMenuSettings {
  try {
    const value = JSON.parse(localStorage.getItem(showcaseMenuSettingsKey) || '{}')
    return value && typeof value === 'object' ? value as ShowcaseMenuSettings : {}
  } catch {
    return {}
  }
}

function writeShowcaseMenuSettings(value: ShowcaseMenuSettings) {
  try {
    localStorage.setItem(showcaseMenuSettingsKey, JSON.stringify({ ...readShowcaseMenuSettings(), ...value }))
  } catch { /* Keep the in-memory settings when storage is unavailable. */ }
}

export function readShowcaseFontSize(): ShowcaseFontSize {
  return readShowcaseTextSize()
}

const showcaseProviderBases = new Set([
  'vuilabs-qwen3-omni-qwentts-sc',
  'vuilabs-qwen3simul-qwentts-sc',
  'vuilabs-qwen25-omni-qwen',
  'vuilabs-qwen25-omni-qwen17b',
  'vuilabs-qwen25-omni-omnivoice',
  'vuilabs-qwen25-omni-omnivoice-xc',
  'vuilabs-qwen3-omni-qwen',
  'vuilabs-qwen3-omni-qwen17b',
  'vuilabs-qwen3-omni-omnivoice',
  'vuilabs-qwen3-omni-omnivoice-xc',
  'vuilabs-qwen3simul-qwen',
  'vuilabs-qwen3simul-qwen17b',
  'vuilabs-qwen3simul-omnivoice',
  'vuilabs-qwen3simul-omnivoice-xc',
])
const showcaseTTSModels: Array<{ value: ShowcaseTTSModel; label: string }> = [
  // qwen 保留兼容路由 ID；本机原服务入口已加载 qwentts_v5 权重。
  { value: 'qwen', label: '正式宣讲' },
  { value: 'qwentts-sc', label: '日常对话' },
  // Multilingual（OmniVoice）不再单独作为选项：后端会把仅 OmniVoice 支持的目标语言自动路由到
  // 同族的 -omnivoice 路由（server.go multilingualTargetProviderID），Pro / Realtime 都能输出 18 种。
]
const showcaseNoisePresetOptions: ShowcaseComboboxOption[] = [
  { value: 'headphones', label: '耳机收声' },
  { value: 'echo-cancellation', label: '系统降噪' },
]
// 手机浏览器、单人模式下「系统降噪」就是手机通话链路（phone-call：采集请求浏览器 AEC/NS/AGC，
// iOS WebKit 走 VoiceProcessingIO，Android Chrome 进 MODE_IN_COMMUNICATION，docs/web-phone-call-mode-plan.md）。
// 桌面那套 volc-rtc + 系统 AEC 的 echo-cancellation 依赖 Chrome 启动参数，手机上不再提供。
const showcaseMobileNoisePresetOptions: ShowcaseComboboxOption[] = [
  { value: 'headphones', label: '耳机收声' },
  { value: 'phone-call', label: '系统降噪' },
]
// 桌面上残留的 phone-call（例如 iPad 请求桌面站点后切回）仍能在下拉里显示当前值。
const showcasePhoneCallPresetOption: ShowcaseComboboxOption = { value: 'phone-call', label: '手机通话模式' }
export const showcaseNoisePresetSettings = {
  headphones: { service: 'websocket', echoCancellation: false, deepFilterNet: false, mode: 'frame_rms', threshold: -40, systemProcessing: false },
  'echo-cancellation': { service: 'volc-rtc', echoCancellation: true, deepFilterNet: false, mode: 'frame_rms', threshold: -40, systemProcessing: false },
  demo: { service: 'websocket', echoCancellation: false, deepFilterNet: true, mode: 'p90_400ms', threshold: -20, systemProcessing: false },
  'phone-call': { service: 'websocket', echoCancellation: false, deepFilterNet: false, mode: 'frame_rms', threshold: -40, systemProcessing: true },
} as const

export const showcaseDuoNoisePresetSettings = {
  ...showcaseNoisePresetSettings,
  demo: { ...showcaseNoisePresetSettings.demo, deepFilterNet: false, threshold: -30 },
  'demo-presentation': showcaseNoisePresetSettings.demo,
} as const

export function showcaseNoisePreset(
  service: ShowcaseService,
  echoCancellation: boolean,
  deepFilterNet: boolean,
  mode: VADLoudnessMode,
  systemProcessing = false,
  demoDeepFilterNet = true,
): ShowcaseNoisePreset {
  if (service === 'websocket' && systemProcessing && !deepFilterNet && mode === 'frame_rms') return 'phone-call'
  if (systemProcessing) return 'custom'
  if (service === 'websocket' && !deepFilterNet && mode === 'frame_rms') return 'headphones'
  if (service === 'volc-rtc' && echoCancellation && !deepFilterNet && mode === 'frame_rms') return 'echo-cancellation'
  if (service === 'websocket' && deepFilterNet === demoDeepFilterNet && mode === 'p90_400ms') return 'demo'
  return 'custom'
}

// 常用面板只显示原有的中文档位；高级阈值仍可保存任意合法 dBFS 值。
export function noiseReductionOptions(mode: VADLoudnessMode): ShowcaseComboboxOption[] {
  const options = mode === 'p90_400ms' ? p90LoudnessOptions : frameRMSLoudnessOptions
  return options.filter(({ label }) => label.includes('（')).map(({ value, label }) => ({
    value,
    label: label.slice(label.indexOf('（') + 1, -1),
  }))
}

export const noisePresetOptions = (preset: ShowcaseNoisePreset, mobile = false, duo = false): ShowcaseComboboxOption[] => {
  const base = duo ? [
    { value: 'headphones', label: '双麦-外接单麦' },
    { value: 'echo-cancellation', label: '双麦-系统降噪' },
    { value: 'demo', label: '双麦-大疆专用-耳机' },
    { value: 'demo-presentation', label: '双麦-大疆专用-演示' },
  ] : mobile
    ? showcaseMobileNoisePresetOptions
    : preset === 'phone-call'
      ? [...showcaseNoisePresetOptions, showcasePhoneCallPresetOption]
      : showcaseNoisePresetOptions
  return preset === 'custom' ? [...base, { value: 'custom', label: '自定义配置', disabled: true }] : base
}

function EchoCancellationSetupDialog({
  open,
  onConfirm,
  onUseHeadphones,
}: {
  open: boolean
  onConfirm: () => void
  onUseHeadphones: () => void
}) {
  // 手机使用浏览器通话采集链路，无需桌面 Chrome 的 AEC 配置引导。
  if (isMobileBrowser()) return null
  const origin = typeof window === 'undefined' ? 'http://127.0.0.1:15174' : window.location.origin
  const chromeCommand = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
    + ' --user-data-dir="$HOME/Library/Application Support/Simultrans Canary System AEC"'
    + ' --no-first-run --no-default-browser-check'
    + ' --enable-features=EnforceSystemEchoCancellation'
    + ' --disable-features=SystemLoopbackAsAecReference'
    + ' "' + origin + '/"'

  return (
    <ShowcaseConfirmDialog
      open={open}
      title="配置回声消除"
      titleId="showcase-echo-cancellation-title"
      className="showcase-echo-cancellation-dialog"
      actions={[
        { label: '已经完成配置', primary: true, onClick: onConfirm },
        { label: '使用耳机测试', onClick: onUseHeadphones },
      ]}
    >
      <p className="showcase-confirm-dialog__lead">
        使用回声消除功能，请确保打开设备AEC并关闭浏览器AEC，使用chrome浏览器
      </p>
      <p>macOS 请在终端使用以下命令启动独立的 Chrome 测试窗口：</p>
      <pre><code>{chromeCommand}</code></pre>
      <p className="showcase-confirm-dialog__note">
        这里的“关闭浏览器AEC”是指关闭 Chrome 的回环参考处理；页面仍会请求开启 AEC，以便使用设备或系统的回声消除能力。
      </p>
    </ShowcaseConfirmDialog>
  )
}

const maxShowcaseTargetLanguages = 4
const showcaseTargetLanguages = omniTargetLanguages.map(({ code }) => code)
const languageLabels: Record<string, string> = {
  auto: '自动', zh: '中', en: '英', ja: '日', ko: '韩', de: '德', fr: '法', ru: '俄', pt: '葡',
  es: '西', it: '意', ar: '阿', id: '印', vi: '越', th: '泰', ms: '马', ur: '乌', tr: '土', sw: '斯',
}
export const languageNames: Record<string, string> = {
  auto: '自动识别',
  ...Object.fromEntries(omniTargetLanguages.map(({ code, name }) => [code, name.replace(/\([^)]*\)$/, '')])),
}
/** 结束页概要用的 mm:ss（超过一小时显示 h:mm:ss）。 */
export function formatShowcaseDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

// 中文语言名，用于结束页「生成韩语译文」这类中文文案；未列出的取名称里的中文括注，再退到原名。
export const chineseLanguageNames: Record<string, string> = {
  ...Object.fromEntries(omniTargetLanguages.map(({ code, name }) => [code, /\(([^)]*)\)$/.exec(name)?.[1] || name])),
  zh: '中文', en: '英语', ja: '日语', ko: '韩语', de: '德语', fr: '法语', ru: '俄语', pt: '葡萄牙语', es: '西班牙语',
  it: '意大利语', ar: '阿拉伯语', id: '印尼语', vi: '越南语', th: '泰语', ms: '马来语', ur: '乌尔都语', tr: '土耳其语', sw: '斯瓦希里语',
}
/** Canary 的语言名一律用中文（阿拉伯语、泰语）；其他环境保持母语名。 */
export const displayLanguageName = (language: string, chinese: boolean) => (
  (chinese ? chineseLanguageNames[language] : '') || languageNames[language] || language
)
// 从右往左书写的输出语言：Canary 上译文 strong 设 dir="rtl"、按钮加 is-rtl，prod 不变；样式见 showcase-multilingual.css。
const rtlLanguages = new Set(['ar', 'ur'])
export const isRTLLanguage = (language: string) => rtlLanguages.has(language)
const directionLanguageLabel = (language: string) => language === 'auto'
  ? '自动'
  : languageLabels[language] || language

const busyStatus = (status: Status) => (
  status === 'connecting' || status === 'recording' || status === 'processing'
)

const showcaseTranslationModel = (provider: string): ShowcaseTranslationModel => (
  baseProviderID({ id: provider }).includes('qwen3simul') ? 'flash-v2' : baseProviderID({ id: provider }).includes('qwen25') ? 'flash' : 'pro'
)
const showcaseTTSModel = (provider: string): ShowcaseTTSModel => (
  baseProviderID({ id: provider }).endsWith('-qwentts-sc')
    ? 'qwentts-sc'
    : baseProviderID({ id: provider }).endsWith('-omnivoice-xc')
    ? 'omnivoice-xc'
    : baseProviderID({ id: provider }).includes('omnivoice')
    ? 'omnivoice'
    : baseProviderID({ id: provider }).endsWith('-qwen17b') ? 'qwen17b' : 'qwen'
)
const preferredShowcaseProvider = (providers: PublicProvider[]) => (
  providers.find((item) => item.ready && showcaseTranslationModel(item.id) === 'flash-v2' && showcaseTTSModel(item.id) === 'qwen')
  || providers.find((item) => item.ready && showcaseTranslationModel(item.id) === 'flash-v2')
  || providers.find((item) => item.ready)
  || providers[0]
)
export const providerForShowcaseSelection = (
  providers: PublicProvider[],
  model: ShowcaseTranslationModel,
  tts: ShowcaseTTSModel,
) => (
  providers.find((item) => item.ready && showcaseTranslationModel(item.id) === model && showcaseTTSModel(item.id) === tts)
  || providers.find((item) => item.ready && showcaseTranslationModel(item.id) === model)
  || providers.find((item) => showcaseTranslationModel(item.id) === model && showcaseTTSModel(item.id) === tts)
)
/* 已停用的官方 TTS / Multilingual 选项迁移到同一翻译模型下的正式宣讲。 */
export const resolveShowcaseProvider = (providers: PublicProvider[], chosen: string, fallback: string) => {
  const candidate = providers.some((item) => item.id === chosen) ? chosen
    : providerForShowcaseSelection(providers, 'flash-v2', showcaseTTSModel(chosen || fallback))?.id || fallback
  if (!['omnivoice', 'omnivoice-xc', 'qwen17b'].includes(showcaseTTSModel(candidate))) return candidate
  return providerForShowcaseSelection(providers, showcaseTranslationModel(candidate), 'qwen')?.id || fallback
}
export const showcaseTTSOptions = (providers: PublicProvider[], model: ShowcaseTranslationModel): ShowcaseComboboxOption[] => showcaseTTSModels.map((option) => ({
  ...option,
  disabled: !providers.some((provider) => (
    provider.ready && showcaseTranslationModel(provider.id) === model && showcaseTTSModel(provider.id) === option.value
  )),
}))

const terminalStatus = (status: Status) => status === 'finished' || status === 'error'

function useConsumerHistoryCheckpoint(input: ConsumerHistoryInput | null, active: boolean) {
  const latestRef = useRef<ConsumerHistoryInput | null>(null)
  latestRef.current = active ? input : null
  useEffect(() => {
    if (active && input) checkpointConsumerHistory(input)
  }, [active, input])
  useEffect(() => {
    const checkpoint = () => {
      if (latestRef.current) checkpointConsumerHistory(latestRef.current)
    }
    window.addEventListener('pagehide', checkpoint)
    return () => window.removeEventListener('pagehide', checkpoint)
  }, [])
}

async function openRecoveredSessionHistory(sessionId: string) {
  const id = await lookupConsumerHistoryId(sessionId).catch(() => '')
  window.location.assign(id ? `/history/${encodeURIComponent(id)}` : '/history')
}

function selectedAudioDeviceLabel(
  devices: AudioDeviceOption[],
  deviceId: string,
  defaultDeviceLabel: string,
  fallback: string,
) {
  if (deviceId === 'default') return defaultDeviceLabel.trim() || fallback
  return devices.find((device) => device.deviceId === deviceId)?.label || fallback
}

export type ShowcaseRowVariant = 'featured' | 'history' | 'live'

export function CompletedLanguageSwitch({
  groups,
}: {
  groups: Array<{
    side?: '甲' | '乙'
    sourceLanguage?: string
    languages: string[]
    value: string
    onChange: (language: string) => void
  }>
}) {
  const chineseNames = canaryDesignEnabled()
  if (groups.length > 0 && groups.every((group) => group.side)) {
    return (
      <div className="showcase-completed-duo-switch" role="group" aria-label="切换结束页译文语言">
        {groups.map((group) => (
          <div className="showcase-completed-duo-group" key={group.side}>
            <span className="showcase-completed-duo-side">{group.side}</span>
            <div className="showcase-completed-duo-direction">
              <span className="showcase-completed-duo-source" title={`${group.side}的来源语言：${displayLanguageName(group.sourceLanguage || 'auto', chineseNames)}`}>
                {directionLanguageLabel(group.sourceLanguage || 'auto')}
              </span>
              <img className="showcase-completed-duo-arrow" src="/showcase/language-direction.svg" alt="" aria-hidden="true" />
              <ShowcaseCombobox
                className="showcase-completed-duo-target"
                ariaLabel={`选择${group.side}的查看语言`}
                options={group.languages.map((language) => ({ value: language, label: displayLanguageName(language, chineseNames) }))}
                value={group.value}
                onChange={group.onChange}
                renderTrigger={(option, open) => <>
                  <span>{option ? directionLanguageLabel(option.value) : '—'}</span>
                  <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
                </>}
                renderOption={(option, selected) => <>
                  <span className="showcase-completed-duo-option-label"><span>{directionLanguageLabel(option.value)}</span><small>{option.label}</small></span>
                  {selected && <img src="/showcase/check-12.svg" alt="" aria-hidden="true" />}
                </>}
              />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (groups.every(({ languages }) => languages.length <= 1)) return null
  return (
    <div className="showcase-completed-language-switch" role="group" aria-label="切换结束页译文语言">
      {groups.map((group, index) => (
        <div className="showcase-completed-language-group" data-language-count={group.languages.length} key={group.side || index}>
          {group.side && <span className="showcase-completed-language-side">{group.side}</span>}
          {group.languages.map((language) => (
            <button
              type="button"
              key={language}
              className={language === group.value ? 'is-active' : ''}
              aria-label={`显示${group.side ? `${group.side}的` : ''}${displayLanguageName(language, chineseNames)}译文`}
              aria-pressed={language === group.value}
              onClick={() => group.onChange(language)}
          >
              {/* 938:5210 / 727:4741：页签只显示「英」这类短标；全称保留在 DOM 里供读屏与测试，视觉上隐藏。 */}
              <span>{languageLabels[language] || language.slice(0, 2).toUpperCase()}</span>
              {language === group.value && <em className="showcase-completed-language-name"> {displayLanguageName(language, chineseNames)}</em>}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

export function ShowcaseTranslationList({
  translations,
  chips = true,
  translationPlaybackFragments,
  targetLanguages,
  primaryLanguage,
  featured,
  terminal,
  solo,
  primaryOnly,
  primaryPlaybackStatus,
  onPrimaryLanguage,
  playableLanguages,
  fullTrackLanguages,
  playingLanguages,
  livePlayback,
  highlightReadingTextOnly = false,
  playedLanguages,
  pendingLanguages,
  onPlayTranslation,
  typewriterEnabled,
  onTextProgress,
}: {
  translations: Record<string, string>
  /* 录音态语言 chips 由外层固定停靠，卡片内可关闭以避免重复。 */
  chips?: boolean
  translationPlaybackFragments?: MultilingualShowcaseRow['translationPlaybackFragments']
  /** 结束页里还没有译文、等用户点「生成 X 语译文」的语言：不渲染「…」占位行。 */
  pendingLanguages?: ReadonlySet<string>
  targetLanguages: string[]
  primaryLanguage: string
  featured: boolean
  terminal: boolean
  solo: boolean
  primaryOnly?: boolean
  /** 主语言整行的播放状态；片段级状态优先，这是没有片段时的兜底。 */
  primaryPlaybackStatus?: ShowcasePlaybackStatus
  onPrimaryLanguage: (language: string) => void
  playableLanguages?: ReadonlySet<string>
  fullTrackLanguages?: ReadonlySet<string>
  playingLanguages?: ReadonlySet<string>
  livePlayback?: { enabled: boolean; segmentId: string | null }
  highlightReadingTextOnly?: boolean
  /** 结束页里点击回放过的语言（放完转灰）。 */
  playedLanguages?: ReadonlySet<string>
  onPlayTranslation?: (language: string) => void
  typewriterEnabled: boolean
  onTextProgress: () => void
}) {
  const chineseNames = canaryDesignEnabled()
  // 按文字调整方向与字体（RTL、系统字体）只在 Canary 主机生效，不分宽度，分享页与结束页同样生效；prod 保持现有渲染。
  const scriptAware = canaryDesignEnabled()
  const primaryPlaying = Boolean(playingLanguages?.has(primaryLanguage)
    || translationPlaybackFragments?.[primaryLanguage]?.some(fragment => fragment.playing)
    || (!translationPlaybackFragments?.[primaryLanguage]?.length && primaryPlaybackStatus === 'playing'))
  const [heldLanguage, setHeldLanguage] = useState('')
  const heldReadingFragments = useRef<MultilingualShowcaseRow['translationPlaybackFragments']>(undefined)
  const holdEnabled = !terminal && Boolean(livePlayback?.enabled) && featured
  const anotherRowPlaying = Boolean(livePlayback?.segmentId) && !primaryPlaying
  useLayoutEffect(() => {
    if (!holdEnabled || anotherRowPlaying) heldReadingFragments.current = undefined
    else if (primaryPlaying) {
      const fragments = translationPlaybackFragments?.[primaryLanguage]
      heldReadingFragments.current = fragments
        ? { [primaryLanguage]: fragments.map(fragment => ({ ...fragment })) } : undefined
    }
  }, [holdEnabled, anotherRowPlaying, primaryPlaying, primaryLanguage, translationPlaybackFragments])
  useEffect(() => {
    if (!holdEnabled || anotherRowPlaying || (!primaryPlaying && heldLanguage !== primaryLanguage)) {
      setHeldLanguage('')
      return
    }
    if (primaryPlaying) {
      setHeldLanguage(primaryLanguage)
      return
    }
    // Bridge a brief TTS handoff in this row, without changing actual playback
    // fragments. Pause, language changes, and another row starting bypass grace.
    const timer = window.setTimeout(() => setHeldLanguage(''), highlightReadingTextOnly ? 200 : 400)
    return () => window.clearTimeout(timer)
  }, [primaryPlaying, primaryLanguage, heldLanguage, holdEnabled, anotherRowPlaying, highlightReadingTextOnly])
  const primaryHighlighted = primaryPlaying
    || (holdEnabled && !anotherRowPlaying && heldLanguage === primaryLanguage)
  const orderedLanguages = primaryOnly
    ? [primaryLanguage].filter(Boolean)
    : [primaryLanguage, ...targetLanguages.filter((language) => language !== primaryLanguage)]
  // 「主语言单独成行」只决定布局；颜色一律由播放态决定（未念黑、在念绿、念完灰），
  // 流式预览还没拿到 TTS 段落信息时同样是黑色（Figma 565:6727 / 576:7847 规则）。
  const primaryPreview = Boolean(
    solo
    && featured
    && !terminal
    && orderedLanguages.every((language) => (
      language === primaryLanguage || !(translations[language] || '').trim()
    )),
  )
  // Figma 727:4475「多段」录音态：最新一句只展示主语言译文，其余目标语言以 chips（中/日/韩）
  // 列在下方，点击即切换主语言——与原来点次语言行切换主语言的行为一致。
  const featuredChips = solo && featured && !terminal && !primaryOnly
  const languages = featuredChips
    ? [primaryLanguage].filter(Boolean)
    : featured && !terminal
      ? orderedLanguages
      : orderedLanguages.filter((language) => (
        !(terminal && pendingLanguages?.has(language))
        && (language === primaryLanguage || terminal || Boolean((translations[language] || '').trim()))
      ))
  return (
    <div className={`showcase-translation-list${solo ? ' is-solo' : ''}${featured ? ' is-featured' : ''}${terminal ? ' is-terminal' : ''}${primaryPreview ? ' is-primary-preview' : ''}${!terminal && !highlightReadingTextOnly ? ' is-paragraph-highlight' : ''}`}>
      {featuredChips && chips && targetLanguages.length > 1 && (
        <div className="showcase-row-languages" role="group" aria-label="切换主要译文语言">
          {targetLanguages.map((language) => (
            <button
              type="button"
              key={language}
              className={language === primaryLanguage ? 'is-active' : ''}
              aria-label={`主要译文切换为${displayLanguageName(language, chineseNames)}`}
              aria-pressed={language === primaryLanguage}
              onClick={() => onPrimaryLanguage(language)}
            >{languageLabels[language] || language.slice(0, 2).toUpperCase()}</button>
          ))}
        </div>
      )}
      {languages.map((language) => {
        const primary = language === primaryLanguage
        const playable = Boolean(playableLanguages?.has(language))
        const playing = Boolean(
          playingLanguages?.has(language)
          || translationPlaybackFragments?.[language]?.some((fragment) => fragment.playing)
          || (primary && primaryPlaying),
        )
        // Figma 565:6727：进行中按 TTS 播放状态着色——未读黑、阅读中绿、已读或跳过灰。
        // 结束页默认墨色（Figma 569:7261），只有点击回放过的行按在放绿 / 放完灰着色。
        const translation = translations[language] || ''
        const fragments = remapPlaybackFragments(translation, translationPlaybackFragments?.[language])
          // Preserve the known row's playback cue until precise audio ranges arrive.
          ?? (!terminal && playing && !translationPlaybackFragments?.[language]?.length
            ? [{ text: translation, playing: true, status: 'playing' as const }] : undefined)
        const displayedFragments = primary && highlightReadingTextOnly && !playing && primaryHighlighted
          ? retainReadingHighlight(fragments, heldReadingFragments.current?.[language]) : fragments
        const playbackStatus = terminal
          ? (playing ? 'playing' : playedLanguages?.has(language) ? 'played' : undefined)
          : (fragments && combinePlaybackStatuses(fragments.map((fragment) => fragment.status)))
            ?? (primary ? primaryPlaybackStatus : undefined)
        const readState = playbackStatus === 'pending'
          ? ' is-unread'
          : playbackStatus === 'played' || playbackStatus === 'skipped'
            ? ' is-read'
            : ''
        const highlighted = playing || (primary && primaryHighlighted)
        const expanded = primary && !solo && (featured || terminal) && !highlighted
        const rtl = scriptAware && isRTLLanguage(language)
        return (
          <button
            type="button"
            key={language}
            className={`showcase-translation-line${primary ? ' is-primary' : ''}${playable ? ' is-playable' : ''}${highlighted ? ' is-playing' : ''}${readState}${!translation ? ' is-pending-translation' : ''}${scriptAware ? ' canary-script' : ''}${rtl ? ' is-rtl' : ''}`}
            aria-label={playable
              ? `播放${displayLanguageName(language, chineseNames)}${fullTrackLanguages?.has(language) ? '完整' : ''}译文音频`
              : `切换为主要${displayLanguageName(language, chineseNames)}译文`}
            title={playable ? (playing ? '正在播放，点击停止' : '点击播放') : undefined}
            aria-pressed={primary}
            onClick={() => {
              onPrimaryLanguage(language)
              if (playable) onPlayTranslation?.(language)
            }}
          >
            {expanded ? (
              <span className="showcase-primary-language"><b>{languageLabels[language]}</b><em>/ {displayLanguageName(language, chineseNames)}</em></span>
            ) : (
              <span className={`showcase-translation-badge${primary && !solo && !highlighted ? ' is-output' : ''}`}>{languageLabels[language]}</span>
            )}
            {/* Canary 的 RTL 只设在译文 strong 上：行是 grid / 列向 flex，strong 作为子项已块级化，语言标签和播放列不翻转。 */}
            <strong lang={language} dir={rtl ? 'rtl' : undefined}>
              <ShowcaseTypewriterText
                text={translation || (primary && !terminal ? '' : '…')}
                playbackFragments={displayedFragments}
                enabled={typewriterEnabled && !primary}
                onProgress={onTextProgress}
              />
              {playable && <SentencePlaybackIcon playing={playing} fullTrack={fullTrackLanguages?.has(language)} />}
            </strong>
          </button>
        )
      })}
    </div>
  )
}

export function SoloTranscriptRow({
  row,
  variant,
  targetLanguages,
  primaryLanguage,
  terminal,
  feedback,
  onPrimaryLanguage,
  sourcePlayable,
  sourcePlaying,
  playableLanguages,
  fullTrackLanguages,
  playingLanguages,
  livePlayback,
  highlightReadingTextOnly = false,
  playedLanguages,
  pendingLanguages,
  showFeedback = true,
  onPlaySource,
  onPlayTranslation,
  typewriterEnabled,
  onTextProgress,
  animate = true,
  displayMode = 'bilingual',
}: {
  row: MultilingualShowcaseRow
  variant: ShowcaseRowVariant
  targetLanguages: string[]
  primaryLanguage: string
  terminal: boolean
  feedback: SentenceFeedbackHandle
  onPrimaryLanguage: (language: string) => void
  sourcePlayable?: boolean
  sourcePlaying?: boolean
  playableLanguages?: ReadonlySet<string>
  fullTrackLanguages?: ReadonlySet<string>
  playingLanguages?: ReadonlySet<string>
  livePlayback?: { enabled: boolean; segmentId: string | null }
  highlightReadingTextOnly?: boolean
  playedLanguages?: ReadonlySet<string>
  pendingLanguages?: ReadonlySet<string>
  /** 只读分享页不显示点赞点踩。 */
  showFeedback?: boolean
  onPlaySource?: () => void
  onPlayTranslation?: (language: string) => void
  typewriterEnabled: boolean
  onTextProgress: () => void
  /** 进行中新到的句子播入场展开；分享页中途加入时已有的句子传 false。 */
  displayMode?: TranscriptDisplayMode
  animate?: boolean
}) {
  const source = asrDisplayText(row.source)
  return (
    <ShowcaseMotionArticle terminal={terminal} animate={animate}
      className={`showcase-multilingual-row showcase-multilingual-row--${variant}`}
      data-showcase-row-id={row.id}
    >
      {displayMode !== 'translation' && (sourcePlayable ? (
        <button
          type="button"
          className={`realtime-showcase-source showcase-source-playback${sourcePlaying ? ' is-playing' : ''}`}
          title={sourcePlaying ? '正在播放，点击停止' : '播放实际传入模型的音频（按本次降噪/VAD设置处理）'}
          aria-pressed={sourcePlaying}
          aria-label={`播放模型输入音频：${source}`}
          onClick={onPlaySource}
        >
          <ShowcaseTypewriterText text={source} enabled={false} onProgress={onTextProgress} />
          <SentencePlaybackIcon playing={sourcePlaying} />
        </button>
      ) : (
        <p className="realtime-showcase-source" title={terminal ? '模型输入音频尚未保存或旧记录未记录；原始录音仍可在会话音频中收听' : undefined}>
          <ShowcaseTypewriterText text={source} enabled={false} onProgress={onTextProgress} />
        </p>
      ))}
      {displayMode !== 'source' && <ShowcaseTranslationList
        translations={row.translations}
        translationPlaybackFragments={row.translationPlaybackFragments}
        targetLanguages={targetLanguages}
        primaryLanguage={primaryLanguage}
        featured={variant === 'featured'}
        terminal={terminal}
        solo
        chips={false}
        primaryOnly={terminal || variant === 'history'}
        primaryPlaybackStatus={row.playbackStatus}
        onPrimaryLanguage={onPrimaryLanguage}
        playableLanguages={playableLanguages}
        fullTrackLanguages={fullTrackLanguages}
        playingLanguages={playingLanguages}
        livePlayback={livePlayback}
        highlightReadingTextOnly={highlightReadingTextOnly}
        playedLanguages={playedLanguages}
        pendingLanguages={pendingLanguages}
        onPlayTranslation={onPlayTranslation}
        typewriterEnabled={typewriterEnabled}
        onTextProgress={onTextProgress}
      />}
      {/* 译文行本身是 <button>，反馈按钮必须留在行外的 article 层，避免嵌套 button。 */}
      {terminal && (
        <footer className="showcase-row-footer">
          {showFeedback ? <SentenceFeedback unitId={row.id} feedback={feedback} context={{ sourceText: row.source, translationText: row.translations[primaryLanguage], targetLanguage: primaryLanguage, startMs: Math.round(row.startMs) }} /> : <span />}
        </footer>
      )}
    </ShowcaseMotionArticle>
  )
}

export function LanguageDirectionSelect({ side, sourceLanguage, sourceOptions, selected, maxTargets = maxShowcaseTargetLanguages, allowedTargets, disabled, open, onOpenChange, onSourceChange, onToggle }: {
  side?: '甲' | '乙'; sourceLanguage: string; sourceOptions: string[]; selected: string[]; maxTargets?: number; allowedTargets: Set<string>; disabled: boolean; open: 'source' | 'target' | null; onOpenChange: (open: 'source' | 'target' | null) => void; onSourceChange: (language: string) => void; onToggle: (language: string) => void
}) {
  const canary = canaryDesignEnabled() && !side
  return <div className={`showcase-duo-language-select${side ? '' : ' showcase-duo-language-select--solo'}${open !== null ? ' is-open' : ''}`}>
    {side && <span className="showcase-duo-language-side">{side}</span>}
    <ShowcaseLanguagePicker ariaLabel={side ? `${side}的输入语言` : '输入语言'} value={[sourceLanguage]} variant="source" canary={canary}
      options={sourceOptions.map(code => ({ code, label: languageLabels[code] || code, name: displayLanguageName(code, canary), disabled }))}
      disabled={disabled} open={open === 'source'} onOpenChange={value => onOpenChange(value ? 'source' : null)} onSelect={onSourceChange} />
    <span className="showcase-language-direction" aria-hidden="true">{canary ? <img src="/showcase/canary-figma/language-direction.svg" alt="" /> : '→'}</span>
    <ShowcaseLanguagePicker ariaLabel={side ? `${side}的输出语言` : '输出语言'} value={selected} variant="target" canary={canary} multiple={maxTargets > 1}
      options={showcaseTargetLanguages.map(code => ({ code, label: languageLabels[code] || code.slice(0, 2).toUpperCase(), name: displayLanguageName(code, canary), ariaLabel: displayLanguageName(code, canary), disabled: disabled || code === sourceLanguage || !allowedTargets.has(code) || (maxTargets > 1 && !selected.includes(code) && selected.length >= maxTargets) }))}
      hint={maxTargets > 1 ? <p className="realtime-showcase-settings-note">最多选择 {maxTargets} 种输出语言</p> : undefined}
      disabled={disabled} open={open === 'target'} onOpenChange={value => onOpenChange(value ? 'target' : null)} onSelect={onToggle} />
  </div>
}

function useConsumerLogin() {
  const [loggedIn, setLoggedIn] = useState(() => isLoggedIn())
  useEffect(() => {
    const unsubscribe = subscribeConsumerSession(() => setLoggedIn(isLoggedIn())) as unknown
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])
  return loggedIn
}

// 「今日剩余 X 分钟」额度：空闲/会话结束时拉取（GET /api/consumer/quota）；
// 录音期间由 useMultilingualRealtimeSession 的每分钟计量回调（onQuota）刷新。
function useConsumerQuotaRefresh(
  loggedIn: boolean,
  sessionStatus: Status,
  setQuota: (quota: ConsumerQuota | null) => void,
  fetcher = consumerFetch,
) {
  useEffect(() => {
    if (!loggedIn) {
      setQuota(null)
      return undefined
    }
    if (sessionStatus !== 'idle' && !terminalStatus(sessionStatus)) return undefined
    let cancelled = false
    void fetchConsumerQuota(fetcher).then((next) => { if (!cancelled && next) setQuota(next) })
    return () => { cancelled = true }
  }, [loggedIn, sessionStatus, setQuota, fetcher])
}

// Figma 727:4909 设置面板字段行：标签 86 宽 + 控件占满，行高 36。
function PanelRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="realtime-showcase-setting-select showcase-panel-row"><span>{label}</span>{children}</div>
}

// 固定选项只读展示，不显示下拉箭头。
function PanelStaticValue({ value, placeholder }: { value: string; placeholder: string }) {
  return (
    <div className={`showcase-panel-static${value ? '' : ' is-placeholder'}`} aria-disabled="true">
      <span>{value || placeholder}</span>
    </div>
  )
}

// Figma 727:4964 开关行：标题 Songti Bold 14 + 说明 12/55% + 40×20 开关（CSS 绘制）。
function PanelToggleRow({ title, description, ariaLabel, checked, disabled, onToggle }: {
  title: string
  description: string
  ariaLabel: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <div className="realtime-showcase-setting-row showcase-panel-toggle">
      <span><strong>{title}</strong><small>{description}</small></span>
      <button
        type="button"
        role="switch"
        className={`realtime-showcase-switch${checked ? ' is-on' : ''}`}
        aria-label={ariaLabel}
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
      ><span aria-hidden="true" /></button>
    </div>
  )
}

// 「今日剩余 77 分钟」：数字按稿用 Songti Black 品牌绿，文本内容保持不变。
function consumerQuotaNode(quota: ConsumerQuota): ReactNode {
  if (quota.unlimited) return consumerQuotaLabel(quota)
  return <>今日剩余 <b>{Math.max(0, Math.floor(quota.remainingMinutes))}</b> 分钟</>
}

// 主页菜单保留额度、历史和设置入口；协议与退出登录归独立设置页。
// Figma 727:4921 页脚：额度 + 查看历史记录同行，分割线，通栏「设置」胶囊。
export function ConsumerAccountSettings({ loggedIn, guest = false, quota, historyVisible, onBeforeHistory }: { loggedIn: boolean; guest?: boolean; quota: ConsumerQuota | null; historyVisible: boolean; onBeforeHistory: () => void }) {
  if ((!loggedIn && !guest) || (!guest && !quota && !historyVisible)) return null
  const settingsEntry = historyVisible && window.location.pathname === '/' && !canaryDesignEnabled()
  return (
    <div className="showcase-panel-footer">
      <div className="showcase-account-row">
        {quota ? <p className="realtime-showcase-settings-note showcase-quota-note">{consumerQuotaNode(quota)}</p>
          : guest ? <p className="realtime-showcase-settings-note showcase-quota-note">剩余时间暂不可用</p> : <span />}
        {historyVisible && (
          <a
            className="showcase-history-link"
            href="/history"
            onClick={() => {
              // Guest history opens the existing sign-in gate. Never persist
              // guest transcripts as an account's return view/checkpoint.
              if (!guest) onBeforeHistory()
              try { sessionStorage.setItem('simultrans.consumerHistoryReturn', `${window.location.pathname}${window.location.search}`) } catch { /* Navigation still works without sessionStorage. */ }
            }}
          >{guest ? '历史记录（登录后查看）' : '查看历史记录'}</a>
        )}
      </div>
      {settingsEntry && <>
        <hr className="showcase-panel-divider" />
        <a className="showcase-settings-entry" href="/settings" onClick={onBeforeHistory}>设置</a>
      </>}
    </div>
  )
}

// 「分享」需要已保存的历史记录 id。historyId 可能暂时为空：保存还在进行、
// 保存被跳去历史页打断（靠 checkpoint 重放补存）、或返回时 returnView 没带 id。
// 这些情况下按钮仍可点：先重放 checkpoint，再按 sessionId 反查；仍拿不到就提示稍等。
const consumerShareSavingNotice = '保存中，请稍等几秒钟'

export function ConsumerSessionShare(props: { historyId: string; sessionId: string; saving: boolean; onResolved: (id: string) => void }) {
  return <ConsumerRecordShare {...props} />
}

function LegacyConsumerSessionShare({ historyId, sessionId, saving, onResolved }: { historyId: string; sessionId: string; saving: boolean; onResolved: (id: string) => void }) {
  const [sharing, setSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setShareUrl('')
    setNotice('')
  }, [historyId])
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])

  const showTransientNotice = (text: string) => {
    setNotice(text)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(''), 3000)
  }

  const resolveHistoryId = useCallback(async () => {
    if (!sessionId) return ''
    // 保存请求被页面卸载打断时，localStorage 里还留着 checkpoint；先补存再反查。
    await retryConsumerHistoryCheckpoints().catch(() => undefined)
    return lookupConsumerHistoryId(sessionId)
  }, [sessionId])

  // 挂载或 historyId 丢失时后台补齐一次，多数情况下用户点之前就已经拿到。
  useEffect(() => {
    if (historyId || saving || !sessionId) return undefined
    let active = true
    void resolveHistoryId().then((id) => {
      if (active && id) onResolved(id)
    }).catch(() => undefined)
    return () => { active = false }
  }, [historyId, onResolved, resolveHistoryId, saving, sessionId])

  const share = async () => {
    if (sharing) return
    setSharing(true)
    setNotice('')
    try {
      let id = historyId
      if (!id) {
        if (saving) {
          showTransientNotice(consumerShareSavingNotice)
          return
        }
        id = await resolveHistoryId()
        if (!id) {
          showTransientNotice(consumerShareSavingNotice)
          return
        }
        onResolved(id)
      }
      let url = shareUrl || existingLiveShare(sessionId)?.url
      if (!url) {
        const result = await createConsumerShareLink(id, window.location.origin)
        url = result.url
        setShareUrl(url)
      }
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
      <SessionShareDialog link={dialogOpen && shareUrl ? { token: shareUrl.split('/').pop() || '', url: shareUrl } : undefined} onClose={() => setDialogOpen(false)} />
      <button type="button" aria-label="点击分享" aria-busy={sharing} disabled={sharing} onClick={() => { void share() }}>
        {!saving && !sharing && <img src="/showcase/share.svg" alt="" aria-hidden="true" />}
        {saving ? '保存中…' : sharing ? '生成中…' : '分享'}
      </button>
      {notice && <span className="showcase-session-share-toast" role="status">{notice}</span>}
    </div>
  )
}

const availableShowcaseProviders = (providers: PublicProvider[]) => providers.filter(provider => ['demo', 'luna', 'aliyun'].includes(provider.id))

export function DeviceCombobox({
  ariaLabel,
  options,
  value,
  disabled,
  onChange,
  latin = false,
  fallbackLabel,
  onOpen,
}: {
  ariaLabel: string
  options: ShowcaseComboboxOption[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
  /** 值为拉丁文（模型名）时用无衬线字体，对应稿上 HarmonyOS Sans 的模型行。 */
  latin?: boolean
  fallbackLabel?: string
  onOpen?: () => void
}) {
  return (
    <ShowcaseCombobox
      ariaLabel={ariaLabel}
      className={`realtime-showcase-device-combobox${latin ? ' realtime-showcase-device-combobox--latin' : ''}`}
      disabled={disabled}
      options={options}
      value={value}
      onChange={onChange}
      onOpen={onOpen}
      renderTrigger={(option, open) => (
        <>
          <span className="realtime-showcase-device-label" title={option?.label && displayAudioDeviceLabel(option.label)}>{option?.label ? displayAudioDeviceLabel(option.label) : fallbackLabel ?? '选择设备'}</span>
          <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
        </>
      )}
      renderOption={(option, selected) => (
        <>
          <span title={displayAudioDeviceLabel(option.label)}>{displayAudioDeviceLabel(option.label)}</span>
          {selected && <img src="/showcase/check-16.svg" alt="" aria-hidden="true" />}
        </>
      )}
    />
  )
}

export function LocalAudioMonitorSettings({ options, choice, deviceId, volume, disabled, notice, onDeviceChange, onVolumeChange }: {
  options: ShowcaseComboboxOption[]
  choice?: string
  deviceId: string | null
  volume: number
  disabled: boolean
  notice: string
  onDeviceChange: (deviceId: string) => void
  onVolumeChange: (volume: number) => void
}) {
  return <>
    <PanelRow label="本地监听"><DeviceCombobox ariaLabel="选择本地监听耳机" options={options} value={choice ?? deviceId ?? ''} disabled={disabled} onChange={onDeviceChange} /></PanelRow>
    <p className="showcase-output-device-hint">识别到会议共享音频后自动选择耳机，也可手动选择或关闭。</p>
    {deviceId && <PanelRow label="监听音量"><label className="showcase-monitor-volume">
      <input aria-label="监听音量" type="range" min="0" max="100" step="1" value={Math.round(volume * 100)} disabled={disabled} onChange={event => onVolumeChange(Number(event.target.value) / 100)} />
      <span>{Math.round(volume * 100)}%</span>
    </label></PanelRow>}
    {notice && <p className="showcase-output-device-hint" role="status">{notice}</p>}
  </>
}

function useMutedMotion() {
  const motionRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = motionRef.current
    if (!video) return undefined
    const ensurePlayback = () => {
      video.defaultMuted = true
      video.muted = true
      video.volume = 0
      void video.play().catch(() => undefined)
    }
    ensurePlayback()
    video.addEventListener('canplay', ensurePlayback)
    return () => video.removeEventListener('canplay', ensurePlayback)
  }, [])
  return motionRef
}

export function useTranscriptFollow(revision: unknown, enabled = true) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const motion = useRef<ReturnType<typeof createTranscriptMotion> | null>(null)
  const attached = useRef<HTMLElement | null>(null)
  const playbackGesture = useTranscriptPlaybackGesture()
  useLayoutEffect(() => {
    const element = transcriptRef.current
    if (element !== attached.current) {
      motion.current?.destroy()
      attached.current = element
      motion.current = element ? createTranscriptMotion(element) : null
      motion.current?.setEnabled(enabled)
      if (enabled) motion.current?.jump()
    }
    motion.current?.setEnabled(enabled)
    motion.current?.update()
  }, [revision, enabled])
  useLayoutEffect(() => () => {
    motion.current?.destroy()
    motion.current = null
    attached.current = null
  }, [])
  return { transcriptRef, playbackGesture, onTextProgress: () => motion.current?.update(),
    onScroll: undefined, onPointerDown: undefined, onPointerUp: undefined }
}

type ArchivedAudioPlayback = {
  sessionId: string
  language?: string
  startMs: number
  endMs?: number
  outputDeviceId: string
  key: string
}

export function useArchivedAudioPlayback() {
  const mountedRef = useRef(true)
  const archivesRef = useRef(new Map<string, HistoryAudioArchive>())
  const pendingArchivesRef = useRef(new Map<string, HistoryAudioArchive>())
  const objectURLsRef = useRef(new Map<string, string>())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const outputContextRef = useRef<AudioContext | null>(null)
  const playingKeyRef = useRef('')
  const playbackRequestRef = useRef(0)
  const [archiveRevision, setArchiveRevision] = useState(0)
  const [playingKey, setPlayingKey] = useState('')
  // 结束页点击回放过的行：默认墨色（Figma 569:7261），放完按「已读」规则转灰。
  const [playedKeys, setPlayedKeys] = useState<ReadonlySet<string>>(() => new Set())

  const stop = useCallback(() => {
    playbackRequestRef.current += 1
    const audio = audioRef.current
    if (audio) {
      audio.ontimeupdate = null
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
    }
    audioRef.current = null
    const outputContext = outputContextRef.current
    outputContextRef.current = null
    if (outputContext) void outputContext.close().catch(() => undefined)
    const endedKey = playingKeyRef.current
    playingKeyRef.current = ''
    setPlayingKey('')
    if (endedKey) setPlayedKeys((current) => (current.has(endedKey) ? current : new Set([...current, endedKey])))
  }, [])

  const clear = useCallback(() => {
    stop()
    setPlayedKeys(new Set())
    objectURLsRef.current.forEach((url) => URL.revokeObjectURL(url))
    objectURLsRef.current.clear()
    pendingArchivesRef.current.clear()
    archivesRef.current.clear()
    setArchiveRevision((value) => value + 1)
  }, [stop])

  const capture = useCallback(async (entry: Pick<HistoryEntry, 'id'>, archive: HistoryAudioArchive) => {
    if (!mountedRef.current) return
    // Do not expose a local silent Blob while its inspection is pending. Merge
    // model-input/translation arrivals with the newest pending capture, and
    // fence earlier results after replacement, clear or unmount.
    const pending = { ...(pendingArchivesRef.current.get(entry.id) || archivesRef.current.get(entry.id)), ...archive }
    pendingArchivesRef.current.set(entry.id, pending)
    const filtered = await filterSilentHistoryAudio(pending)
    if (pendingArchivesRef.current.get(entry.id) !== pending) return
    archivesRef.current.set(entry.id, filtered)
    for (const [key, url] of objectURLsRef.current) {
      if (key.startsWith(`${entry.id}:`)) { URL.revokeObjectURL(url); objectURLsRef.current.delete(key) }
    }
    setArchiveRevision((value) => value + 1)
  }, [])

  const hasTrack = useCallback((sessionId: string, language?: string) => {
    const archive = archivesRef.current.get(sessionId)
    return hasHistoryAudioSamples(language ? archive?.outputs?.[language] : archive?.modelInput)
  }, [archiveRevision])

  const play = useCallback(async ({ sessionId, language, startMs, endMs, outputDeviceId, key }: ArchivedAudioPlayback) => {
    const archive = archivesRef.current.get(sessionId)
    const blob = language ? archive?.outputs?.[language] : archive?.modelInput
    if (!hasHistoryAudioSamples(blob)) return
    if (playingKeyRef.current === key) {
      stop()
      return
    }
    stop()
    const request = playbackRequestRef.current
    const sourceKey = `${sessionId}:${language || 'input-model'}:${startMs}:${endMs ?? 'end'}`
    let source = objectURLsRef.current.get(sourceKey)
    if (!source) {
      let clip: Blob
      try { clip = await slicePlaybackWav(blob, startMs, endMs) } catch { return }
      if (request !== playbackRequestRef.current) return
      const currentArchive = archivesRef.current.get(sessionId)
      if ((language ? currentArchive?.outputs?.[language] : currentArchive?.modelInput) !== blob) return
      source = URL.createObjectURL(clip)
      objectURLsRef.current.set(sourceKey, source)
    }
    const audio = new Audio(source)
    audio.preload = 'metadata'
    audio.currentTime = 0
    audioRef.current = audio
    audio.onended = stop
    audio.onerror = stop
    playingKeyRef.current = key
    setPlayingKey(key)
    try {
      if (outputDeviceId !== 'default' && typeof audio.setSinkId !== 'function') {
        const outputContext = new AudioContext()
        outputContextRef.current = outputContext
        outputContext.createMediaElementSource(audio).connect(outputContext.destination)
        await (outputContext as AudioContext & { setSinkId: (deviceId: string) => Promise<void> }).setSinkId(outputDeviceId)
        if (audioRef.current !== audio) return
        await outputContext.resume()
      } else if (typeof audio.setSinkId === 'function') {
        await audio.setSinkId(outputDeviceId === 'default' ? '' : outputDeviceId)
      }
      if (audioRef.current !== audio) return
      await audio.play()
      trackProduct('history_playback', { sessionId, targetLanguage: language, result: 'success' })
    } catch {
      if (audioRef.current === audio) stop()
    }
  }, [stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingArchivesRef.current.clear()
      playbackRequestRef.current += 1
      const audio = audioRef.current
      if (audio) {
        audio.ontimeupdate = null
        audio.onended = null
        audio.onerror = null
        audio.pause()
      }
      const outputContext = outputContextRef.current
      outputContextRef.current = null
      if (outputContext) void outputContext.close().catch(() => undefined)
      objectURLsRef.current.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  const archives = useMemo(() => Object.fromEntries(archivesRef.current), [archiveRevision])
  return { capture, clear, hasTrack, play, stop, playingKey, playedKeys, archives }
}

export function ShowcaseFrame({
  mode,
  status,
  fontSize,
  paused,
  muted,
  busy,
  restoreHeader,
  liveSnapshot,
  liveStatus = 'live',
  guest = false,
  guestListening = false,
  settings,
  onSettingsClose,
  toolbar,
  notice,
  infoNotice,
  infoNoticeDismissible = false,
  endingNotice,
  onNoticeAction,
  noticeActionOpensDevices = true,
  deviceGuideSignal = 0,
  welcomeTitle,
  welcomeSubtitle,
  hasContent,
  controlDisabled,
  pauseDisabled,
  onModeChange,
  onControl,
  onMute,
  onPause,
  onComplete,
  onLeave,
  leaveReady = false,
  footerAction,
  finished = false,
  backHref,
  backHidden = false,
  homeModes,
  startLabel = '开始同传',
  scene,
  children,
}: {
  mode: ShowcaseMode
  status: Status
  fontSize: ShowcaseFontSize
  paused: boolean
  muted: boolean
  busy: boolean
  liveSnapshot?: ShareSnapshot
  liveStatus?: LivePublishStatus
  guest?: boolean
  guestListening?: boolean
  restoreHeader: boolean
  settings: ReactNode
  onSettingsClose?: () => void
  toolbar: ReactNode
  notice: string
  infoNotice?: string
  /** Only nonessential voice-clone status copy is dismissible; consent and session warnings stay separate. */
  infoNoticeDismissible?: boolean
  /** 会话结束前最后 10 秒的提醒；逐秒变化，压在其他提示之上。 */
  endingNotice?: string
  /** 提示条可点击时的动作（如读取音频设备）；完成后自动打开设置面板并展开麦克风列表。 */
  onNoticeAction?: () => Promise<unknown> | void
  noticeActionOpensDevices?: boolean
  /** 每次递增都会打开设置面板并展开麦克风列表（开始录音时读不到设备也走这条引导）。 */
  deviceGuideSignal?: number
  welcomeTitle: string
  welcomeSubtitle: string
  hasContent: boolean
  controlDisabled: boolean
  pauseDisabled: boolean
  onModeChange: (mode: ShowcaseMode) => void
  onControl: () => void | Promise<void>
  onMute: () => void
  onPause: () => void
  onComplete: () => void
  onLeave?: () => Promise<void>
  leaveReady?: boolean
  footerAction?: ReactNode
  /** 结束页（消费者模式会话结束后）：左上返回主页，不显示品牌标、模式切换与录音键。 */
  finished?: boolean
  /** 结束页返回链接的目标；缺省回同传主页（历史详情传 /history）。 */
  backHref?: string
  /** 只读分享页：不显示返回链接。 */
  backHidden?: boolean
  homeModes?: ReactNode
  startLabel?: string
  scene?: WebSceneMode
  children: ReactNode
}) {
  const canaryUi = canaryDesignEnabled()
  const canaryDrawer = canaryUi && mode === 'solo' && (!scene || scene === 'conversation')
  const settingsId = scene === 'conversation' ? 'conversation-mode-settings' : 'quick-mode-settings'
  const canaryDesign = canaryUi && mode === 'solo' && !guest
  // Keep language rows in the dock's flow so wrapped chips grow its background.
  // Processing/terminal states retain their separate session-control layout.
  const isDockedLanguages = (child: ReactNode) => isValidElement<{ className?: string }>(child)
    && child.props.className?.split(' ').includes('showcase-row-languages--docked')
  const dockLanguages = canaryDesign && !finished && status === 'recording' && scene !== 'conversation'
    ? Children.toArray(children).filter(isDockedLanguages) : []
  const [dismissedNotice, setDismissedNotice] = useState('')
  const [dismissedInfoNotice, setDismissedInfoNotice] = useState('')
  const visibleInfoNotice = infoNotice && (!infoNoticeDismissible || infoNotice !== dismissedInfoNotice) ? infoNotice : undefined
  useEffect(() => { if (!infoNotice) setDismissedInfoNotice('') }, [infoNotice])
  useEffect(() => {
    if (!infoNoticeDismissible || !visibleInfoNotice || notice) return
    const timer = window.setTimeout(() => setDismissedInfoNotice(visibleInfoNotice), 5000)
    return () => window.clearTimeout(timer)
  }, [infoNoticeDismissible, visibleInfoNotice, notice])
  const [sessionElapsed, setSessionElapsed] = useState(0)
  const sessionStartedAt = useRef(0)
  useEffect(() => {
    if (!canaryDesign || status !== 'recording') return
    if (!sessionStartedAt.current) sessionStartedAt.current = Date.now()
    const tick = () => setSessionElapsed(Math.floor((Date.now() - sessionStartedAt.current) / 1000))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [canaryDesign, status])
  useEffect(() => { if (status === 'idle') { sessionStartedAt.current = 0; setSessionElapsed(0) } }, [status])
  const workspaceRef = useRef<HTMLDivElement>(null)
  // Reserve the real controls once. A single-screen notice sits above the
  // language chips/dock, never beneath the dock background or over captions.
  useLayoutEffect(() => {
    const root = workspaceRef.current
    if (!canaryDesign || !root) return
    const singleScreen = Boolean(root.querySelector(':scope > .canary-caption-viewport'))
    if (!singleScreen && status !== 'recording') return
    const chips = root.querySelector<HTMLElement>('.showcase-row-languages--docked')
    const controls = root.querySelector<HTMLElement>('.canary-session-dock, :scope > .realtime-showcase-session-control')
    const notices = Array.from(root.querySelectorAll<HTMLElement>(':scope > .realtime-showcase-notices'))
    const visible = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.getClientRects().length)
    const update = () => {
      const rootBottom = root.getBoundingClientRect().bottom
      if (singleScreen && chips && visible(chips) && controls && visible(controls) && !controls.classList.contains('canary-session-dock')) {
        chips.style.setProperty('--caption-chips-bottom', `${Math.ceil(rootBottom - controls.getBoundingClientRect().top + 8)}px`)
      }
      const controlTop = Math.min(...[chips, controls].filter(visible).map(element => element.getBoundingClientRect().top))
      if (singleScreen && Number.isFinite(controlTop)) {
        let bottom = rootBottom - controlTop + 8
        // The ending countdown is first in the DOM, so stack it above other notices.
        for (const element of [...notices].reverse().filter(visible)) {
          element.style.setProperty('--caption-notice-bottom', `${Math.ceil(bottom)}px`)
          bottom += element.getBoundingClientRect().height + 8
        }
      }
      const top = Math.min(...[chips, controls, ...notices].filter(visible).map(element => element.getBoundingClientRect().top))
      if (Number.isFinite(top)) root.style.setProperty('--caption-bottom', `${Math.ceil(rootBottom - top + (singleScreen ? 0 : 16))}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    for (const element of [root, chips, controls, ...notices]) if (element) observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--caption-bottom')
      chips?.style.removeProperty('--caption-chips-bottom')
      for (const element of notices) element.style.removeProperty('--caption-notice-bottom')
    }
  }, [canaryDesign, status, finished, notice, dismissedNotice, visibleInfoNotice, endingNotice, scene])
  const [captionRotation, setCaptionRotation] = useState(0)
  const captionRef = useRef<HTMLDivElement>(null)
  const [captionSize, setCaptionSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (!canaryDesign || !captionRef.current) return
    const observer = new ResizeObserver(([entry]) => setCaptionSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(captionRef.current)
    return () => observer.disconnect()
  }, [canaryDesign, status])
  const duoEntryAllowed = canStartDuoShowcase()
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  const [leaveError, setLeaveError] = useState('')
  const leaveHome = () => {
    clearShowcaseReturnView()
    window.location.assign(backHref || showcaseHomePath(window.location.pathname))
  }
  useEffect(() => {
    if (leaving && leaveReady) leaveHome()
  }, [leaving, leaveReady, backHref])
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => {
      setLeaveError('仍未确认会话结束。可以继续等待，或直接返回；尚未上传的内容可能无法恢复。')
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [leaving])
  const confirmLeave = async () => {
    if (leavingRef.current || !onLeave) return
    leavingRef.current = true
    setLeaving(true)
    setLeaveError('')
    try { await onLeave() } catch {
      leavingRef.current = false
      setLeaving(false)
      setLeaveError('无法确认会话结束。可以重试或直接返回；尚未上传的内容可能无法恢复。')
    }
  }
  const sharing = useLiveSharing(liveSnapshot, liveStatus)
  const [shareView, setShareView] = useState<'qr' | 'link' | undefined>()
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 用户点掉的提示文案；文案变化后新提示照常显示。
  // 提示消失后清掉「已关闭」记录，同一条提示下次再出现时仍会显示。
  useEffect(() => { if (!notice) setDismissedNotice('') }, [notice])
  const settingsRef = useRef<HTMLDivElement>(null)
  const settingsContentRef = useRef<HTMLDivElement>(null)
  const closeModeSettings = () => { setSettingsOpen(false); onSettingsClose?.() }
  const motionRef = useMutedMotion()
  // 手机框尺寸由全站 rem（styles/root-scale.css）决定：桌面 5.21×9.26rem 的 9:16 框，
  // 竖屏手机撑满视口；不再用 transform 缩放或浏览器缩放画布。
  const welcome = status === 'idle' && !hasContent
  const invitationVisible = canaryUi && scene === 'speak' && !finished && !guest && Boolean(liveSnapshot) && (status === 'recording' || status === 'processing')
  const invitationRef = useRef<HTMLDivElement>(null)
  const [invitationHeight, setInvitationHeight] = useState(0)
  useLayoutEffect(() => {
    if (!invitationVisible || !invitationRef.current) return
    const measure = () => setInvitationHeight(invitationRef.current?.getBoundingClientRect().height || 0)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(invitationRef.current)
    return () => observer.disconnect()
  }, [invitationVisible, Boolean(sharing.link)])
  const [shareConfirmationOpen, setShareConfirmationOpen] = useState(false)
  useEffect(() => { setShareConfirmationOpen(false) }, [liveSnapshot?.sessionId])
  const openInvitation = async (method?: 'qr' | 'link', confirmed = false) => {
    setShareView(method)
    if (!sharing.link && canaryUi && !confirmed) { setShareConfirmationOpen(true); return }
    const link = sharing.link || await sharing.create()
    if (link) setShareDialogOpen(true)
  }
  const consumerHome = welcome && window.location.pathname === '/'
  // 正式站点的展示入口也只提供单麦；与首页共用精简欢迎布局。
  const soloWelcome = welcome && mode === 'solo' && (consumerHome || !duoEntryAllowed)
  const inProgress = busy || status === 'recording' || status === 'connecting' || status === 'processing'
  const directLeaveAvailable = (inProgress && status !== 'recording') || Boolean(leaveError)
  const shortcutStartingRef = useRef(false)

  // Keep keyboard actions in sync with the rendered buttons before the next key press.
  useLayoutEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey || guest || backHidden
        || settingsOpen || shareDialogOpen || document.hidden || shortcutStartingRef.current
        || status === 'connecting' || status === 'processing' || (restoreHeader && busy)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]')) return
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return
      const key = event.key.toLowerCase()
      // Enter/Space on a focused control retain their native activation behavior.
      if ((key === 'enter' || key === ' ') && target?.closest('button, a, summary, [role="button"]')) return
      if (key === 's' && duoEntryAllowed && !homeModes && !busy && !finished) {
        event.preventDefault()
        onModeChange(mode === 'solo' ? 'duo' : 'solo')
      } else if (key === 'enter' && welcome && !finished && !controlDisabled && !busy) {
        event.preventDefault()
        shortcutStartingRef.current = true
        try { await onControl() } finally { shortcutStartingRef.current = false }
      } else if (key === ' ' && status === 'recording' && !finished && !pauseDisabled) {
        event.preventDefault()
        onPause()
      } else if (key === 'e' && status === 'recording' && !finished) {
        event.preventDefault()
        onComplete()
      } else if (key === 'q' && !busy && (finished || terminalStatus(status))) {
        event.preventDefault()
        clearShowcaseReturnView()
        window.location.assign(backHref || showcaseHomePath(window.location.pathname))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [guest, backHidden, settingsOpen, shareDialogOpen, status, paused, restoreHeader, busy, welcome, finished, controlDisabled, pauseDisabled, onControl, onPause, onComplete, backHref, mode, onModeChange, duoEntryAllowed, homeModes])

  // 打开设置面板并把麦克风下拉展开，引导用户选择设备。
  const guideToDevices = useCallback(() => {
    setSettingsOpen(true)
    window.setTimeout(() => {
      const trigger = (canaryDrawer ? settingsContentRef : settingsRef).current?.querySelector<HTMLButtonElement>('[aria-label="选择输入设备"], [aria-label="甲的输入设备"]')
      if (!trigger) return
      trigger.scrollIntoView({ block: 'center' })
      if (!trigger.disabled) trigger.click()
    }, 80)
  }, [canaryDrawer])

  useEffect(() => {
    if (deviceGuideSignal > 0) guideToDevices()
  }, [deviceGuideSignal, guideToDevices])

  useEffect(() => {
    if (!settingsOpen || canaryDrawer) return undefined
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      // 信息弹窗挂在 body 上：在弹窗内点击（含关闭按钮、遮罩）只关弹窗，不收起设置面板。
      if ((target as Element).closest?.('.showcase-setting-info-overlay, .showcase-language-picker-menu')) return
      if (!settingsRef.current?.contains(target)) setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [settingsOpen, canaryDrawer])

  return (
    <section
      className="realtime-showcase-page showcase-multilingual-page"
      aria-labelledby="multilingual-showcase-title"
    >
      <h1 id="multilingual-showcase-title" className="realtime-showcase-sr-only">{homeModes ? `同声传译 · ${HOME_MODE_OPTIONS.map(option => option.label).join('、')}` : '多语与双人竖屏同传'}</h1>
      <div ref={workspaceRef} className={`realtime-showcase-device realtime-showcase-device--${welcome ? 'welcome' : status} showcase-multilingual-device showcase-multilingual-device--${mode} showcase-font-size--${fontSize}${homeModes ? ' showcase-has-home-modes' : ''}${scene ? ` showcase-scene--${scene}` : ''}${canaryDesign ? ' canary-workspace' : ''}${invitationVisible ? ' canary-speak-invitation' : ''}`}
        style={invitationVisible ? { '--invitation-height': `${invitationHeight || 52}px` } as CSSProperties : undefined}>
        <div className="realtime-showcase-landscape" aria-hidden="true" />
        <div className="realtime-showcase-motion-stage" aria-hidden="true">
          <div className="realtime-showcase-motion-window">
            <div className="realtime-showcase-motion" aria-hidden="true" />
          </div>
        </div>

        <header className={`realtime-showcase-header${settingsOpen ? ' is-settings-open' : ''}${finished ? ' is-finished' : ''}${finished && backHidden ? ' is-readonly' : ''}`}>
          {canaryDesign && welcome && !backHidden && window.location.pathname === '/' ? <HomeProfileButton /> : inProgress && onLeave && !backHidden ? (
            <ShowcaseBackButton ariaLabel="返回主页" onClick={() => setLeaveDialogOpen(true)} />
          ) : guest && !backHidden ? (
            <ShowcaseBackButton href={backHref || showcaseHomePath(window.location.pathname)} ariaLabel="返回主页" onClick={clearShowcaseReturnView} />
          ) : finished ? (backHidden ? null : (
            <ShowcaseBackButton
              href={backHref || showcaseHomePath(window.location.pathname)}
              ariaLabel={backHref ? '返回' : '返回主页'}
              onClick={clearShowcaseReturnView}
            />
          )) : (
            <a
              className="realtime-showcase-brand"
              href={showcaseHomePath(window.location.pathname)}
              aria-label="返回当前同传首页"
              onClick={clearShowcaseReturnView}
            >
              <img src="/vuilabs-logo.svg" alt="" aria-hidden="true" />
            </a>
          )}
          {finished && footerAction}
          {canaryDesign && welcome && !backHidden && <HomeMeetingScanner disabled={busy} />}
          {!finished && <div className="realtime-showcase-controls showcase-multilingual-controls">
            {/* Figma 273:1056 模式切换：#f3f3f3 胶囊，激活段 #365337 反白，图标 20（话筒 / 团队）。 */}
            {(!homeModes && !soloWelcome && !guest && (!busy || restoreHeader)) && (
              <div className="showcase-mode-switch" aria-label="同传模式">
                <button type="button" disabled={busy} className={mode === 'solo' ? 'is-active' : ''} onClick={() => onModeChange('solo')}>
                  <span className="showcase-mode-icon showcase-mode-icon--solo" aria-hidden="true" />
                  <span>单麦同传</span>
                </button>
                {duoEntryAllowed && <button type="button" disabled={busy} className={mode === 'duo' ? 'is-active' : ''} onClick={() => onModeChange('duo')}>
                  <span className="showcase-mode-icon showcase-mode-icon--duo" aria-hidden="true" />
                  <span>{SESSION_MODE_LABELS.duo}</span>
                </button>}
              </div>
            )}
            <div className="realtime-showcase-settings-wrap" ref={settingsRef}>
              <button
                type="button"
                className={`realtime-showcase-menu${settingsOpen ? ' is-open' : ''}`}
                aria-label="更多设置"
                aria-expanded={settingsOpen}
                aria-haspopup={canaryDrawer ? 'dialog' : undefined}
                aria-controls={canaryDrawer ? settingsId : undefined}
                onClick={() => { if (settingsOpen) closeModeSettings(); else setSettingsOpen(true) }}
              >
                <img src="/showcase/menu.svg" alt="" aria-hidden="true" />
              </button>
              {canaryDrawer ? <AppSettingsDrawer id={settingsId} title={scene === 'conversation' ? '对话模式设置' : '快速开始模式设置'} open={settingsOpen} onClose={closeModeSettings} contentRef={settingsContentRef}>
                {settings}
                {liveSnapshot && <><button type="button" className="live-share-menu" disabled={sharing.busy} onClick={() => { closeModeSettings(); void openInvitation() }}>{sharing.busy ? '正在生成…' : sharing.stopped ? '查看分享记录' : '分享实时同传'}</button>{sharing.error && <p className="live-share-menu-error" role="status">{sharing.error}</p>}</>}
              </AppSettingsDrawer> : settingsOpen && <aside className="realtime-showcase-settings showcase-multilingual-settings">{settings}{liveSnapshot && <><button type="button" className="live-share-menu" disabled={sharing.busy} onClick={() => { void openInvitation() }}>{sharing.busy ? '正在生成…' : sharing.stopped ? '查看分享记录' : '分享实时同传'}</button>{sharing.error && <p className="live-share-menu-error" role="status">{sharing.error}</p>}</>}</aside>}
            </div>
          </div>}
        </header>

        {welcome && !canaryDesign && homeModes && <div className="showcase-home-modes">{homeModes}</div>}

        {canaryUi && shareConfirmationOpen && <LiveShareConfirmation onResult={accepted => { setShareConfirmationOpen(false); if (accepted) void openInvitation(shareView, true) }} />}
        <SessionShareDialog canary={canaryUi} initialView={canaryUi && scene === 'speak' ? shareView : undefined} link={shareDialogOpen ? sharing.link : undefined} live={!sharing.stopped && liveStatus !== 'ended'} onClose={() => setShareDialogOpen(false)} onFinish={() => { void sharing.finish() }} />
        {invitationVisible && <div className="speak-invitation-heading">声音分享</div>}
        {invitationVisible && <div ref={invitationRef} className="speak-invitation-slot"><SpeakInvitationBar shared={Boolean(sharing.link)} stopped={sharing.stopped || liveStatus === 'ended'} busy={sharing.busy} error={sharing.error} onSelect={method => { void openInvitation(method) }} /></div>}
        {!invitationVisible && scene === 'speak' && liveSnapshot && status === 'recording' && <div className="showcase-scene-share"><button type="button" disabled={sharing.busy} onClick={() => { void openInvitation() }}>邀请听众</button>{sharing.error && <span role="status">{sharing.error}</span>}</div>}
        {!soloWelcome && (!canaryDesign || finished) && toolbar}

        {canaryDesign && welcome ? <>
          <div className="canary-home-languages">{toolbar}</div>
          <div className="canary-home-empty"><div className="canary-translation-symbol"><img src="/showcase/canary-figma/translate.svg" alt="" /></div><p>点击按钮开始同传</p></div>
        </> : welcome ? (
          <div className="realtime-showcase-welcome-copy showcase-multilingual-welcome">
            <p>欢迎体验<em>同声传译</em></p>
            <strong>{welcomeTitle}</strong>
            <span>{welcomeSubtitle}</span>
            {soloWelcome && <div className="showcase-home-language">{toolbar}</div>}
            {scene && <small className="showcase-scene-hint">{scene === 'speak' ? '开始后可邀请听众，分别收听各自语言的译文。' : scene === 'conversation' ? '共用一支麦克风，上下两侧分别查看自己的语言。' : '持续收声，显示你选择的语言。'}<br />默认只显示字幕，开始后可开启一路译音。</small>}
          </div>
        ) : canaryDesign && !finished && scene !== 'conversation' ? Children.map(children, child => dockLanguages.length && isDockedLanguages(child) ? null : isValidElement<{ className?: string }>(child) && child.props.className?.includes('realtime-showcase-transcript') ? <div ref={captionRef} className="canary-caption-viewport"><div className="canary-caption-rotated" style={{ width: captionRotation % 180 ? captionSize.height : '100%', height: captionRotation % 180 ? captionSize.width : '100%', left: captionRotation % 180 ? (captionSize.width - captionSize.height) / 2 : 0, top: captionRotation % 180 ? (captionSize.height - captionSize.width) / 2 : 0, transform: `rotate(${captionRotation}deg)` }}>{child}</div></div> : child) : children}

        {endingNotice && (
          <div
            className={`realtime-showcase-notices showcase-multilingual-notices showcase-multilingual-notices--${mode} showcase-multilingual-notices--ending`}
            role="status"
            aria-live="assertive"
          >
            <p className="realtime-showcase-notice realtime-showcase-notice-text">{endingNotice}</p>
          </div>
        )}
        {visibleInfoNotice && !notice && (
          <div className={`realtime-showcase-notices showcase-multilingual-notices showcase-multilingual-notices--${mode}`} role="status">
            {infoNoticeDismissible ? <div className="realtime-showcase-notice realtime-showcase-notice--info">
              <p className="realtime-showcase-notice-text">{visibleInfoNotice}</p>
              <button type="button" className="realtime-showcase-notice-close" aria-label="关闭音色克隆提示" onClick={() => setDismissedInfoNotice(infoNotice || '')} />
            </div> : <p className="realtime-showcase-notice realtime-showcase-notice-text">{visibleInfoNotice}</p>}
          </div>
        )}
        {notice && notice !== dismissedNotice && (
          <div className={`realtime-showcase-notices showcase-multilingual-notices showcase-multilingual-notices--${mode}`} aria-live="polite">
            {/* Figma 971:7464 录音态提示卡：注意图标 + 文案 + 关闭；欢迎态沿用纯文字样式（图标与关闭由 CSS 隐藏）。 */}
            <div className={`realtime-showcase-notice realtime-showcase-notice--service${onNoticeAction ? ' realtime-showcase-notice--audio' : ''}`}>
              <img className="realtime-showcase-notice-icon" src="/showcase/warning.svg" alt="" aria-hidden="true" />
              {onNoticeAction ? (
                <button
                  type="button"
                  className="realtime-showcase-notice-text realtime-showcase-notice-action"
                  onClick={() => {
                    // 点击提示会重新读取音频设备，随后打开右上设置并展开麦克风列表引导选择。
                    void (async () => {
                      try { await onNoticeAction() } catch { /* 读取失败时仍打开设置面板让用户手动处理。 */ }
                      if (noticeActionOpensDevices) guideToDevices()
                    })()
                  }}
                >{notice}</button>
              ) : (
                <p className="realtime-showcase-notice-text">{notice}</p>
              )}
              <button type="button" className="realtime-showcase-notice-close" aria-label="关闭提示" onClick={() => setDismissedNotice(notice)} />
            </div>
          </div>
        )}

        {!finished && footerAction}

        {canaryDesign && welcome ? <div className="canary-home-dock">{homeModes}<button className="canary-quick-start" type="button" disabled={controlDisabled} aria-label={scene ? startLabel : '快速开始'} onClick={onControl}><img src="/showcase/canary-figma/mic.svg" alt="" /><span>{scene ? ({ listen: '听译', speak: '分享', conversation: '对话' })[scene] : '快速开始'}</span></button><span className="canary-dock-spacer" /></div> : canaryDesign && status === 'recording' ? (
          <div className={`canary-session-dock${dockLanguages.length ? ' canary-session-dock--with-languages' : ''}`} role="group" aria-label="同传控制">
            {dockLanguages}
            <div className="canary-audio-controls">
              <button type="button" className={`canary-speaker-control ${muted ? 'is-off' : 'is-on'}`} aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} onClick={onMute}>
                {muted ? <img src="/showcase/canary-figma/speaker-off.svg" alt="" /> : <svg width="26" height="20" viewBox="0 0 26 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h4l5-4v14l-5-4H3Z" />{muted ? <path d="m17 7 6 6m0-6-6 6" /> : <><path d="M16 6q5 4 0 8" /><path d="M20 3q7 7 0 14" /></>}</svg>}
              </button>
              <span aria-hidden="true" />
              {scene !== 'conversation' && <button type="button" aria-label="字幕旋转90度" onClick={() => setCaptionRotation(value => (value + 90) % 360)}><img src="/showcase/canary-figma/session-rotate.svg" alt="" /></button>}
            </div>
            <button type="button" className="canary-pause-control" disabled={pauseDisabled} aria-label={paused ? '继续' : '暂停'} aria-pressed={paused} onClick={onPause}>
              <img className="canary-pause-icon" src={paused ? '/showcase/play.svg' : '/showcase/canary-figma/pause.svg'} alt="" />
              <time>{[Math.floor(sessionElapsed / 3600), Math.floor(sessionElapsed / 60) % 60, sessionElapsed % 60].map(value => String(value).padStart(2, '0')).join(':')}</time>
            </button>
            <button type="button" className="canary-finish-control" aria-label="完成" onClick={onComplete}><img src="/showcase/canary-figma/finish.svg" alt="" /></button>
          </div>
        ) : finished ? null : status === 'recording' ? (
          <div className="showcase-session-actions" role="group" aria-label="同传控制">
            <button
              type="button"
              className={`showcase-session-action${muted ? ' is-active' : ''}`}
              aria-label={guest && !guestListening ? '开始收听译音' : muted ? '取消静音' : '静音'}
              aria-pressed={muted}
              onClick={onMute}
            >
              <span className="showcase-session-action-icon showcase-session-action-icon--volume" aria-hidden="true">
                <img src={muted ? '/showcase/volume-active.svg' : '/showcase/volume.svg'} alt="" />
              </span>
              <span>{guest && !guestListening ? '收听' : muted ? '已静音' : '静音'}</span>
            </button>
            <button
              type="button"
              hidden={guest}
              className="showcase-session-action showcase-session-action--primary"
              aria-label={paused ? '继续' : '暂停'}
              aria-pressed={paused}
              disabled={pauseDisabled}
              onClick={onPause}
            >
              <span className={`showcase-session-action-icon showcase-session-action-icon--${paused ? 'play' : 'pause'}`} aria-hidden="true" />
              <span>{paused ? '继续' : '暂停'}</span>
            </button>
            {guest && <><span className="showcase-session-action showcase-session-action--guest-placeholder" aria-hidden="true" /><span className="showcase-session-action showcase-session-action--guest-placeholder" aria-hidden="true" /></>}
            <button hidden={guest} type="button" className="showcase-session-action showcase-session-action--complete" aria-label="完成" onClick={onComplete}>
              <span className="showcase-session-action-icon" aria-hidden="true"><img src="/showcase/check-white.svg" alt="" /></span>
              <span>完成</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="realtime-showcase-session-control"
            onClick={onControl}
            disabled={controlDisabled}
            aria-label={startLabel}
          >
            {status === 'connecting' || status === 'processing' ? (
            <span className="realtime-showcase-spinner" aria-hidden="true" />
          ) : (
            <img src={welcome ? '/showcase/record-mic.svg' : '/showcase/microphone-dark.svg'} alt="" aria-hidden="true" />
          )}
          </button>
        )}
      </div>
      <ShowcaseConfirmDialog
        open={leaveDialogOpen}
        title="结束同传并返回主页？"
        titleId="showcase-leave-title"
        onDismiss={() => { if (!leavingRef.current) setLeaveDialogOpen(false) }}
        actions={[
          ...(!leaving ? [
            { label: '取消', primary: true, onClick: () => setLeaveDialogOpen(false) },
            ...(status !== 'connecting' ? [{ label: '结束并返回', onClick: () => { void confirmLeave() } }] : []),
          ] : []),
          ...(directLeaveAvailable ? [{ label: '直接返回', onClick: leaveHome }] : []),
        ]}
      >
        <p className="showcase-confirm-dialog__lead">{leaving ? '正在结束同传…' : '返回主页将结束当前会话并停止麦克风采集。'}</p>
        {directLeaveAvailable && !leaveError && <p>直接返回会离开当前会话；尚未上传的内容可能无法恢复。</p>}
        {leaveError && <p role="alert">{leaveError}</p>}
      </ShowcaseConfirmDialog>
    </section>
  )
}

// sessionMode：'/' 生产入口经 ConsumerGate 登录后走 'consumer'（预检 + 计量 +
// 账号区）；'/ui-showcase/multilingual' 免登录内部演示传 'eval'，行为与历史版本
// 完全一致（裸连 /ws/translate，无额度、无账号区）。
export async function loadHomeMeetingAvailability(sessionMode: MultilingualSessionMode): Promise<boolean> {
  if (sessionMode === 'eval') return false
  const meetingFetch = sessionMode === 'guest' ? canaryGuestFetch : consumerFetch
  try { return (await createMeetingAPI(meetingFetch).capabilities()).enabled === true }
  catch { return false }
}

export default function MultilingualShowcasePage({ sessionMode: requestedMode = 'consumer' }: { sessionMode?: MultilingualSessionMode } = {}) {
  const canaryGuest = useContext(CanaryGuestContext)
  const sessionMode = canaryGuest ? 'guest' : requestedMode
  const [scene, setScene] = useState<WebSceneMode | undefined>(() => {
    if (sessionMode === 'eval') return undefined
    const restored = readShowcaseReturnView()
    return productHomeScene(new URLSearchParams(window.location.search).get('mode'), restored?.mode === 'solo' ? restored.scene : undefined)
  })
  useEffect(() => {
    if (sessionMode === 'eval') return
    const url = canonicalProductHomeURL(window.location.href)
    if (url.href !== window.location.href) window.history.replaceState(null, '', url)
  }, [sessionMode])
  const [meetingAvailable, setMeetingAvailable] = useState(false)
  useEffect(() => {
    setMeetingAvailable(false)
    if (sessionMode === 'eval') return
    let alive = true
    void loadHomeMeetingAvailability(sessionMode).then(value => { if (alive) setMeetingAvailable(value) })
    return () => { alive = false }
  }, [sessionMode])
  // 手机浏览器上双麦多语仍在内测：不恢复上次保存的模式，始终从单麦进入；点「双麦多语」只弹内测提示。
  const mobileBrowser = useMemo(() => isMobileBrowser(), [])
  const duoEntryAllowed = canStartDuoShowcase()
  const [mode, setMode] = useState<ShowcaseMode>(() => {
    if (sessionMode !== 'eval') return 'solo'
    return !duoEntryAllowed || mobileBrowser ? 'solo' : readShowcasePreferences().mode || 'solo'
  })
  const [betaNoticeOpen, setBetaNoticeOpen] = useState(false)
  useEffect(() => { writeShowcasePreferences({ mode }) }, [mode])
  const [revision, setRevision] = useState(0)
  const restoreModePickerFocus = useRef(false)
  useLayoutEffect(() => {
    if (!restoreModePickerFocus.current) return
    restoreModePickerFocus.current = false
    // A mode switch intentionally remounts SoloShowcase; focus its new opener
    // after the commit instead of leaving focus on the removed menu/button.
    document.querySelector<HTMLButtonElement>('.canary-home-mode-picker > button, .home-mode-switch [role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
  }, [revision])
  const [fontSize] = useState<ShowcaseFontSize>(readShowcaseFontSize)
  const audioDevices = useAudioDevices()
  const initialPermissionRequestedRef = useRef(false)

  useEffect(() => {
    if (initialPermissionRequestedRef.current) return
    initialPermissionRequestedRef.current = true
    if (canaryDesignEnabled() && sessionMode !== 'eval') { void audioDevices.refresh(); return }
    void audioDevices.requestPermissionAndRefresh()
  }, [audioDevices.requestPermissionAndRefresh, audioDevices.refresh, sessionMode])

  const switchMode = (next: ShowcaseMode) => {
    if (sessionMode !== 'eval' && next === 'duo') return
    if (next === mode || (next === 'duo' && !duoEntryAllowed)) return
    if (next === 'duo' && mobileBrowser) {
      setBetaNoticeOpen(true)
      return
    }
    clearShowcaseReturnView()
    setMode(next)
    setRevision((value) => value + 1)
  }
  const switchHomeMode = (next: WebHomeMode) => {
    if (!isVisibleHomeMode(next)) return
    if (next === 'meeting') { if (meetingAvailable) window.location.assign(sessionMode === 'guest' ? '/meeting?guest=1' : '/meeting'); return }
    const nextScene = next === 'solo' ? undefined : next
    if (nextScene === scene && mode === 'solo') return
    restoreModePickerFocus.current = Boolean(document.activeElement?.closest('.canary-home-mode-picker, .home-mode-switch'))
    clearShowcaseReturnView()
    const url = new URL(window.location.href)
    if (nextScene) url.searchParams.set('mode', nextScene)
    else url.searchParams.delete('mode')
    window.history.replaceState(null, '', url)
    setScene(nextScene); setMode('solo'); setRevision(value => value + 1)
  }
  return (
    <>
      {mode === 'solo'
        ? scene === 'conversation' && sessionMode !== 'eval'
          ? <ConversationShowcase key={`conversation-${revision}`} sessionMode={sessionMode} audioDevices={audioDevices} fontSize={fontSize} meetingAvailable={meetingAvailable} onHomeModeChange={switchHomeMode} />
          : <SoloShowcase key={`solo-${revision}`} mode={mode} sessionMode={sessionMode} audioDevices={audioDevices} fontSize={fontSize} onModeChange={switchMode} scene={scene} meetingAvailable={meetingAvailable} onHomeModeChange={sessionMode !== 'eval' ? switchHomeMode : undefined} />
        : <DuoShowcase key={`duo-${revision}`} mode={mode} sessionMode={sessionMode} audioDevices={audioDevices} fontSize={fontSize} onModeChange={switchMode} />}
      <ShowcaseConfirmDialog
        open={betaNoticeOpen}
        title="内测提示"
        titleId="showcase-beta-notice-title"
        actions={[{ label: '确认', primary: true, onClick: () => setBetaNoticeOpen(false) }]}
        onDismiss={() => setBetaNoticeOpen(false)}
      >
        <p className="showcase-confirm-dialog__lead">功能内测，稍后开放</p>
      </ShowcaseConfirmDialog>
    </>
  )
}

type AudioDevices = ReturnType<typeof useAudioDevices>

type ShowcaseSessionOutput = ReturnType<typeof useMultilingualRealtimeSession>['outputs'][string]
const showcaseOutputHasContent = (output: ShowcaseSessionOutput | undefined) => Boolean(
  output && (output.vadTranscriptPairs.length > 0 || output.segments.length > 0 || output.translation.trim() || output.modelOutputTranslation.trim()),
)
type ShowcaseBackfillState = {
  language: string
  historyId: string
  phase: 'preparing' | 'ready' | 'running' | 'saving' | 'failed'
  progress: number
  error?: string
}

function SoloShowcase({ mode, sessionMode, audioDevices, fontSize, onModeChange, scene, meetingAvailable = false, onHomeModeChange }: { mode: ShowcaseMode; sessionMode: MultilingualSessionMode; audioDevices: AudioDevices; fontSize: ShowcaseFontSize; onModeChange: (mode: ShowcaseMode) => void; scene?: WebSceneMode; meetingAvailable?: boolean; onHomeModeChange?: (mode: WebHomeMode) => void }) {
  const canaryUi = canaryDesignEnabled()
  const sceneCopy = scene ? SCENE_COPY[scene] : undefined
  const [scenePreferences] = useState(() => scene ? readScenePreferences(scene) : undefined)
  const settingsCatalog = useSettingsCatalog()
  const [conversationSide, setConversationSide] = useState<'top' | 'bottom'>('bottom')
  const analyticsAttemptRef = useRef<ProductAttempt | null>(null)
  const { config, loadFailed } = usePublicConfig()
  const [storedMenuSettings] = useState(readShowcaseMenuSettings)
  const [hotwords, setHotwords] = useState(() => readShowcaseHotwords(storedMenuSettings))
  const { asrContext, prompt: qwen3SimulSystemPrompt, mode: hotwordMode } = hotwords
  const [storedPreferences] = useState(readShowcasePreferences)
  const menuSettingsTouchedRef = useRef(false)
  const initialDeviceSelectionDoneRef = useRef(false)
  const [returnView, setReturnView] = useState<Extract<ShowcaseReturnView, { mode: 'solo' }> | null>(() => {
    const value = sessionMode === 'consumer' ? readShowcaseReturnView() : null
    return !isHiddenHomeScene(new URLSearchParams(window.location.search).get('mode'))
      && value?.mode === 'solo' && !isHiddenHomeScene(value.scene) && value.scene === scene ? value : null
  })
  const routes = useMemo(() => availableShowcaseProviders(config?.providers || []), [config?.providers])
  const [service, setService] = useState<ShowcaseService>(() => (
    returnView
      ? (returnView.provider.endsWith('-volc-rtc') ? 'volc-rtc' : 'websocket')
      : storedMenuSettings.service === 'volc-rtc' ? 'volc-rtc' : 'websocket'
  ))
  const [webRTCEchoCancellation, setWebRTCEchoCancellation] = useState(storedMenuSettings.webRTCEchoCancellation ?? true)
  const [deepFilterNet, setDeepFilterNet] = useState(storedMenuSettings.deepFilterNet ?? false)
  const [highlightReadingTextOnly, setHighlightReadingTextOnly] = useState(storedMenuSettings.highlightReadingTextOnly ?? false)
  const phoneCallPresetAvailable = useMemo(() => isMobileBrowser(), [])
  // 手机浏览器默认走「手机通话模式」（系统通话链路）；桌面默认耳机保真。用户改过后以存储为准。
  const [systemInputProcessing, setSystemInputProcessing] = useState(storedMenuSettings.systemInputProcessing ?? phoneCallPresetAvailable)
  const [vadLoudnessMode, setVADLoudnessMode] = useState<VADLoudnessMode>(() => storedVADLoudnessMode(storedMenuSettings.vadLoudnessMode))
  const [frameRMSLoudnessThresholdDbfs, setFrameRMSLoudnessThresholdDbfs] = useState<FrameRMSLoudnessThresholdDbfs>(() => storedFrameRMSThreshold(storedMenuSettings.frameRMSLoudnessThresholdDbfs))
  const [p90LoudnessThresholdDbfs, setP90LoudnessThresholdDbfs] = useState<P90LoudnessThresholdDbfs>(() => storedP90Threshold(storedMenuSettings.p90LoudnessThresholdDbfs))
  const providers = useMemo(() => routesForService(routes, service), [routes, service])
  const defaultProvider = preferredShowcaseProvider(providers)?.id || ''
  const [chosenProvider, setChosenProvider] = useState(returnView?.provider || storedMenuSettings.provider || '')
  const provider = resolveShowcaseProvider(providers, chosenProvider, defaultProvider)
  const selectedProvider = providers.find((item) => item.id === provider)
  const baseProvider = selectedProvider ? baseProviderID(selectedProvider) : provider
  const translationModel: ShowcaseTranslationModel = 'flash-v2'
  const ttsModel = showcaseTTSModel(provider)
  const [sourceLanguage, setSourceLanguage] = useState(returnView?.sourceLanguage || (scene ? scenePreferences!.sourceLanguage : (canaryUi && !storedPreferences.solo?.sourceLanguage ? 'auto' : normalizeShowcaseSourceLanguage(storedPreferences.solo?.sourceLanguage))))
  const sourceOptions = useMemo(() => config?.consumerSourceLanguages || (scene || canaryUi ? ['auto', ...showcaseSourceLanguages] : showcaseSourceLanguages), [config?.consumerSourceLanguages, scene, canaryUi])
  useEffect(() => {
    if (!returnView && config?.consumerSourceLanguages && !sourceOptions.includes(sourceLanguage)) {
      setSourceLanguage(sourceOptions.includes('auto') ? 'auto' : sourceOptions[0] || '')
    }
  }, [config?.consumerSourceLanguages, returnView, sourceOptions, sourceLanguage])
  const maxSoloTargets = scene === 'conversation' ? 2 : soloTargetLanguageLimit(settingsCatalog)
  const [selectedTargets, setTargetLanguages] = useState<string[]>(returnView?.targetLanguages || scenePreferences?.targetLanguages || storedPreferences.solo?.targetLanguages || ['en'])
  const [primaryLanguage, setPrimaryLanguage] = useState(returnView?.primaryLanguage || scenePreferences?.primaryLanguage || storedPreferences.solo?.primaryLanguage || 'en')
  const supportedTargets = useMemo(() => config?.consumerTargetLanguages
    ? showcaseTargetLanguages.filter(language => config.consumerTargetLanguages!.includes(language))
    : showcaseTargetLanguages, [config?.consumerTargetLanguages])
  const allowedTargets = useMemo(() => new Set(supportedTargets.filter(language => scene === 'conversation' || language !== sourceLanguage)), [supportedTargets, scene, sourceLanguage])
  // Finished records keep their original languages; only new sessions are narrowed.
  const targetLanguages = useMemo(() => {
    if (returnView) return selectedTargets
    const retained = selectedTargets.filter(language => allowedTargets.has(language))
    const minimum = scene === 'conversation' ? 2 : 1
    for (const language of ['en', 'zh', ...supportedTargets]) {
      if (retained.length >= minimum) break
      if (allowedTargets.has(language) && !retained.includes(language)) retained.push(language)
    }
    return limitShowcaseTargets(retained, primaryLanguage, maxSoloTargets)
  }, [selectedTargets, primaryLanguage, maxSoloTargets, returnView, allowedTargets, supportedTargets, scene])
  useEffect(() => {
    if (!returnView && targetLanguages.join(',') !== selectedTargets.join(',')) setTargetLanguages(targetLanguages)
  }, [returnView, targetLanguages, selectedTargets])
  useEffect(() => {
    if (scene) writeScenePreferences(scene, { sourceLanguage, targetLanguages, primaryLanguage })
    else writeShowcasePreferences({ solo: { sourceLanguage, targetLanguages, primaryLanguage } })
  }, [scene, sourceLanguage, targetLanguages, primaryLanguage])
  // Browser output routing cannot reliably identify separate headphones. Scene
  // sessions start with captions; the listener can explicitly enable one output.
  const [muted, setMuted] = useState(Boolean(scene))
  const [languageSelectOpen, setLanguageSelectOpen] = useState<'source' | 'target' | null>(null)
  const [inputDeviceId, setInputDeviceId] = useState(storedMenuSettings.soloInputDeviceId || 'default')
  const [outputDeviceId, setOutputDeviceId] = useState(storedMenuSettings.soloOutputDeviceId || 'default')
  const [monitorVolume, setMonitorVolume] = useState(0.7)
  const [quickAudio, setQuickAudio] = useState(readQuickAudio)
  const [quickAudioError, setQuickAudioError] = useState('')
  const quickAudioEnabled = canaryUi && !scene
  const [quickTranscriptDisplay, setQuickTranscriptDisplay] = useState(readQuickTranscriptDisplay)
  const inputSelectionManuallyChangedRef = useRef(false)
  const [snapshotError, setSnapshotError] = useState('')
  const [savedHistoryId, setSavedHistoryId] = useState(returnView?.historyId || '')
  // ---------- 结束页补译（docs/post-session-language-backfill-plan.md） ----------
  // 勾选新语言只出现「生成 X 语译文」按钮；点击后用本次录音只带新语言再跑一条
  // 同传会话（不计费），事件走同一套 reducer 与语义分段，完成后追加进历史记录。
  const [backfill, setBackfill] = useState<ShowcaseBackfillState | null>(null)
  const [backfilledOutputs, setBackfilledOutputs] = useState<Record<string, ShowcaseSessionOutput>>({})
  const backfillRecorderRef = useRef<RecorderFactory | null>(null)
  const backfillPageLeaseRef = useRef<(() => boolean) | null>(null)
  const backfillRecorderFactory = useCallback<RecorderFactory>((onPCM) => {
    const factory = backfillRecorderRef.current
    return factory ? factory(onPCM) : Promise.reject(new Error('没有可回放的录音'))
  }, [])
  const backfillAudioRef = useRef<HistoryAudioArchive | null>(null)
  const [backfillToast, setBackfillToast] = useState('')
  useEffect(() => {
    if (!backfillToast) return undefined
    const timer = window.setTimeout(() => setBackfillToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [backfillToast])
  const inputAudioRef = useRef<Blob | null>(null)
  const archiveRef = useRef<HistoryAudioArchive | null>(null)
  const [historySaving, setHistorySaving] = useState(false)
  const [completionRequested, setCompletionRequested] = useState(false)
  const [echoCancellationSetupOpen, setEchoCancellationSetupOpen] = useState(false)
  // 手机浏览器的两个提示弹窗：环境提示（每天一次，可勾选以后不再提示；确认后才开始）与连接麦克风。
  const [environmentNoticeOpen, setEnvironmentNoticeOpen] = useState(false)
  const [environmentNoticeSuppress, setEnvironmentNoticeSuppress] = useState(false)
  const [microphoneNoticeOpen, setMicrophoneNoticeOpen] = useState(false)
  const pendingStartFieldsRef = useRef<ProductAttempt['fields'] | null>(null)
  const pendingStartPageLeaseRef = useRef<(() => boolean) | null>(null)
  // 手机上手动选过降噪模式（本地设置里记着）：不再按耳机 / 自带麦自动切换。
  const mobileNoisePresetManualRef = useRef(Boolean(storedMenuSettings.mobileNoisePresetManual))
  const snapshotSavingRef = useRef(false)
  const startedAtRef = useRef(0)
  const historySync = useHistorySync({ config, initialScope: 'local', sessionMode: 'multilingual', transientErrorMs: 5000 })
  const playback = useArchivedAudioPlayback()
  const health = useS2STHealth(Boolean(baseProvider))
  // 支持克隆的路由默认开启，不提供界面开关。
  const effectiveVoiceClone = Boolean(selectedProvider?.voiceClone)
  const vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs = vadLoudnessMode === 'p90_400ms'
    ? p90LoudnessThresholdDbfs
    : frameRMSLoudnessThresholdDbfs
  const sessionVadMode = quickAudioEnabled ? 'frame_rms' : vadLoudnessMode
  const sessionVadThreshold = quickAudioEnabled ? quickNoiseThreshold(quickAudio.noiseReduction) : vadLoudnessThresholdDbfs
  const selectedVoice = voiceOptions[provider]?.[0]?.id || voiceOptions[baseProvider]?.[0]?.id || ''

  useEffect(() => {
    if (!config || providers.length > 0) return
    if (routesForService(routes, 'websocket').length > 0) setService('websocket')
    else if (routesForService(routes, 'volc-rtc').length > 0) setService('volc-rtc')
  }, [config, providers.length, routes])

  useEffect(() => {
    if (!targetLanguages.includes(primaryLanguage)) setPrimaryLanguage(targetLanguages[0] || '')
  }, [primaryLanguage, targetLanguages])

  useEffect(() => {
    if (!config || !provider || !menuSettingsTouchedRef.current) return
    writeShowcaseMenuSettings({
      service,
      provider,
      webRTCEchoCancellation,
      deepFilterNet,
      vadLoudnessMode,
      frameRMSLoudnessThresholdDbfs,
      p90LoudnessThresholdDbfs,
      highlightReadingTextOnly,
      soloInputDeviceId: inputDeviceId,
      soloOutputDeviceId: outputDeviceId,
      systemInputProcessing,
      hotwordMode,
      asrContext,
      qwen3SimulSystemPrompt,
    })
  }, [config, deepFilterNet, frameRMSLoudnessThresholdDbfs, inputDeviceId, outputDeviceId, p90LoudnessThresholdDbfs, provider, service, systemInputProcessing, vadLoudnessMode, webRTCEchoCancellation, asrContext, qwen3SimulSystemPrompt, hotwordMode, highlightReadingTextOnly])

  const ready = Boolean(selectedProvider?.ready && health.available === true && targetLanguages.length > 0
    && (!config?.consumerVoiceCloneRequired || effectiveVoiceClone))
  const mutedLanguages = useMemo(() => new Set(
    muted ? targetLanguages : targetLanguages.filter((language) => language !== primaryLanguage),
  ), [muted, primaryLanguage, targetLanguages])
  const loggedIn = useConsumerLogin() && sessionMode === 'consumer'
  const [consumerQuota, setConsumerQuota] = useState<ConsumerQuota | null>(null)
  // 结束页概要（参考 App 结束页）：本次同传时长 · 模式 / 输出语言 · 今日剩余。
  const [finishedDurationMs, setFinishedDurationMs] = useState<number | null>(null)
  const recordSession = (entry: HistoryEntry, audio: HistoryAudioArchive) => {
    setFinishedDurationMs(
      typeof entry.sessionDurationMs === 'number'
        ? entry.sessionDurationMs
        : startedAtRef.current > 0 ? Math.max(0, Date.now() - startedAtRef.current) : null,
    )
    inputAudioRef.current = audio.input || null
    archiveRef.current = audio
    playback.capture(entry, audio)
    historySync.recordSession(entry, audio)
  }
  const communityAudio = useContext(CommunityAudioContext)
  const communityRecorder = useMemo(() => communityAudio.pcm ? createPCMReplayRecorderFactory({pcm:communityAudio.pcm,paceFactor:1,onDone:()=>window.dispatchEvent(new Event('community:audio-ended'))}) : undefined,[communityAudio.pcm])
  const session = useMultilingualRealtimeSession({
    endOnPageExit: true,
    recorderFactory: communityRecorder,
    privacyGate: sessionMode !== 'eval' ? canaryAIPrivacyGate : undefined,
    guestFetcher: sessionMode === 'guest' ? canaryGuestFetch : undefined,
    asrContext,
    asrContextOverride: true,
    qwen3SimulSystemPrompt: qwen3SimulSystemPrompt.trim() || defaultShowcaseSystemPrompt,
    mode: sessionMode,
    sessionLayout: 'solo',
    onQuota: setConsumerQuota,
    provider,
    baseProviderId: baseProvider,
    service,
    transport: sessionMode === 'guest' || service === 'websocket' ? 'websocket' as const : 'webrtc' as const,
    model: selectedProvider?.model || '—',
    sourceLanguage,
    targetLanguages: limitShowcaseTargets(targetLanguages, primaryLanguage, maxSoloTargets),
    priorityLanguage: primaryLanguage,
    effectiveVoiceClone,
    selectedVoice,
    deepFilterNet,
    qwen3ModelIntervalMs: 2000,
    vadLoudnessMode: sessionVadMode,
    vadLoudnessThresholdDbfs: sessionVadThreshold,
    ready,
    notReadyReason: loadFailed
      ? '无法读取服务配置，请稍后刷新。'
      : health.available === false
        ? health.reason || 'S2ST 服务暂时不可用。'
        : selectedProvider?.reason || '所选模型服务尚未配置。',
    inputDeviceId,
    inputProcessing: systemInputProcessing ? 'system' : 'raw',
    webRTCEchoCancellation,
    outputDeviceId,
    monitorVolume,
    playbackVolume: quickAudioEnabled ? quickAudio.volume / 100 : undefined,
    mutedLanguages,
    refreshAudioDevices: () => { void audioDevices.refresh().catch(() => undefined) },
    onSessionRecorded: recordSession,
  })
  useEffect(()=>{const stop=()=>{setCompletionRequested(true);void session.stopAndDrain()};window.addEventListener('community:audio-ended',stop);return ()=>window.removeEventListener('community:audio-ended',stop)},[session.stopAndDrain])
  useEffect(()=>{communityAudio.setBusy(['connecting','recording','processing'].includes(session.status));return ()=>communityAudio.setBusy(false)},[session.status,communityAudio.setBusy])
  useConsumerQuotaRefresh(loggedIn || sessionMode === 'guest', session.status, setConsumerQuota, sessionMode === 'guest' ? canaryGuestFetch : consumerFetch)
  const backfillMuted = useMemo(() => new Set(backfill ? [backfill.language] : []), [backfill?.language])
  const backfillSession = useMultilingualRealtimeSession({
    endOnPageExit: true,
    privacyGate: sessionMode !== 'eval' ? canaryAIPrivacyGate : undefined,
    asrContext,
    asrContextOverride: true,
    qwen3SimulSystemPrompt: qwen3SimulSystemPrompt.trim() || defaultShowcaseSystemPrompt,
    mode: sessionMode,
    provider,
    baseProviderId: baseProvider,
    service: 'websocket',
    transport: 'websocket',
    model: selectedProvider?.model || '—',
    sourceLanguage,
    targetLanguages: backfill ? [backfill.language] : [],
    effectiveVoiceClone,
    selectedVoice,
    deepFilterNet,
    qwen3ModelIntervalMs: 2000,
    vadLoudnessMode: sessionVadMode,
    vadLoudnessThresholdDbfs: sessionVadThreshold,
    ready: true,
    notReadyReason: '',
    inputDeviceId: 'default',
    recorderFactory: backfillRecorderFactory,
    outputDeviceId,
    mutedLanguages: backfillMuted,
    refreshAudioDevices: () => undefined,
    onSessionRecorded: (_entry, audio) => { backfillAudioRef.current = audio },
    backfill: backfill ? { purpose: 'backfill', replayOf: backfill.historyId } : undefined,
  })
  const backfillSessionRef = useRef(backfillSession)
  backfillSessionRef.current = backfillSession
  // 结束页显示用的输出：现场会话 + 已补译 + 补译进行中的那一种（逐行出现）。
  const mergedOutputs = useMemo(() => ({
    ...session.outputs,
    ...backfilledOutputs,
    ...(backfill && backfillSession.outputs[backfill.language] ? { [backfill.language]: backfillSession.outputs[backfill.language] } : {}),
  }), [backfill, backfillSession.outputs, backfilledOutputs, session.outputs])
  const displayLanguageOrder = useMemo(() => [
    primaryLanguage,
    ...targetLanguages.filter((language) => language !== primaryLanguage),
  ], [primaryLanguage, targetLanguages])
  const noisePreset = showcaseNoisePreset(
    service,
    webRTCEchoCancellation,
    deepFilterNet,
    vadLoudnessMode,
    systemInputProcessing,
  )
  // 会话设置快照：随历史记录上报，历史详情按同一批中文标签回显。
  // buildSha 取 /api/config 的构建标识（webui 与后端同批发布）。
  const sessionSettings = useMemo(() => buildSessionSettings({
    platform: 'web',
    buildSha: config?.buildSha,
    mode: 'solo',
    scene,
    sourceLanguage,
    targetLanguages: displayLanguageOrder,
    translationModel,
    ttsModel,
    provider,
    noisePreset,
    service,
    echoCancellation: webRTCEchoCancellation,
    deepFilterNet,
    vadLoudnessMode: sessionVadMode,
    vadLoudnessThresholdDbfs: sessionVadThreshold,
    voiceClone: effectiveVoiceClone,
    voiceMode: session.voiceMode,
    fontSize,
    audio: session.audioProcessingDiagnostics || undefined,
  }), [scene, config?.buildSha, deepFilterNet, displayLanguageOrder, effectiveVoiceClone, fontSize, noisePreset, provider, service, session.voiceMode, session.audioProcessingDiagnostics, sourceLanguage, translationModel, ttsModel, sessionVadMode, sessionVadThreshold, webRTCEchoCancellation])
  // External ASR and TTS boundaries are independent. Community v0.1 pairs
  // the whole utterance, preserving every word without inventing sentence alignment.
  const rowsByPrimaryLanguage = useMemo(() => {
    const translations = Object.fromEntries(targetLanguages.map(language => [language, mergedOutputs[language]?.translation || '']))
    const hasText = Boolean(session.sourceText.trim() || Object.values(translations).some(text => text.trim()))
    const whole: MultilingualShowcaseRow[] = hasText ? [{id:'community-utterance',source:session.sourceText,startMs:0,committed:terminalStatus(session.status),translations,outputAudioStarts:{},outputAudioEnds:{}}] : []
    return Object.fromEntries(targetLanguages.map(language => [language,whole]))
  }, [mergedOutputs, session.sourceText, session.status, targetLanguages])
  const rows = rowsByPrimaryLanguage[primaryLanguage] || []
  const visibleRowsByPrimaryLanguage = Object.values(rowsByPrimaryLanguage).some((layoutRows) => layoutRows.length > 0)
    ? rowsByPrimaryLanguage
    : returnView?.rowsByPrimaryLanguage || {}
  const historyRows = useMemo(() => Object.entries(rowsByPrimaryLanguage).flatMap(([layoutLanguage, layoutRows]) => (
    layoutRows.map((row) => ({
      ...row,
      translations: { [layoutLanguage]: row.translations[layoutLanguage] || '' },
      outputAudioStarts: row.outputAudioStarts[layoutLanguage] === undefined ? {} : { [layoutLanguage]: row.outputAudioStarts[layoutLanguage] },
      outputAudioEnds: row.outputAudioEnds[layoutLanguage] === undefined ? {} : { [layoutLanguage]: row.outputAudioEnds[layoutLanguage] },
      primaryLanguage: layoutLanguage,
      layoutLanguage,
    }))
  )), [rowsByPrimaryLanguage])
  const actualInputLabel = service === 'websocket' && session.audioProcessingDiagnostics
    ? session.audioProcessingDiagnostics.inputDeviceLabel || '麦克风（名称未公开）'
    : selectedAudioDeviceLabel(audioDevices.inputDevices, inputDeviceId, audioDevices.defaultInputDeviceLabel, '系统默认麦克风（具体设备由系统决定）')
  const checkpointInput = useMemo(() => (
    sessionMode === 'consumer' && session.parentSessionID && historyRows.length > 0
      ? buildConsumerHistoryInput({
          sessionId: session.parentSessionID,
          provider,
          sourceLanguage,
          targetLanguages: displayLanguageOrder,
          durationMs: startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0,
          devices: {
            inputs: [{
              label: actualInputLabel,
            }],
            outputs: [{
              label: selectedAudioDeviceLabel(audioDevices.outputDevices, outputDeviceId, audioDevices.defaultOutputDeviceLabel, '系统默认输出（具体设备由系统决定）'),
            }],
          },
          rows: historyRows,
          settings: sessionSettings,
          traceId: session.traceId,
        })
      : null
  ), [actualInputLabel, audioDevices.defaultOutputDeviceLabel, audioDevices.outputDevices, displayLanguageOrder, historyRows, outputDeviceId, provider, session.parentSessionID, session.traceId, sessionMode, sessionSettings, sourceLanguage])
  useConsumerHistoryCheckpoint(checkpointInput, busyStatus(session.status))
  useEffect(() => {
    if (loggedIn) void retryConsumerHistoryCheckpoints()
  }, [loggedIn])
  const visibleRows = rows.length > 0
    ? rows
    : visibleRowsByPrimaryLanguage[primaryLanguage] || returnView?.rows || []
  useProductSessionAnalytics(analyticsAttemptRef, [session], visibleRows.some(row => Object.values(row.translations).some(text => text.trim())))
  const visibleSessionId = session.parentSessionID || returnView?.sessionId || ''
  const captureArchivedAudio = playback.capture
  useEffect(() => {
    if (!returnView?.sessionId) return undefined
    let active = true
    void loadHistoryAudio(returnView.sessionId).then((archive) => {
      if (!active) return
      archiveRef.current = archive
      inputAudioRef.current = archive.input || null
      captureArchivedAudio({ id: returnView.sessionId }, archive)
    }).catch(() => undefined)
    return () => { active = false }
  }, [captureArchivedAudio, returnView?.sessionId])

  const startBackfill = async (language: string) => {
    const pageLease = backfillSession.capturePageLease()
    if (!pageLease()) return
    if (!visibleSessionId) return
    if (backfill && backfill.phase !== 'failed') {
      // 同账号同时只跑一条补译，不排队：本地已有任务直接提示。
      setBackfillToast(BACKFILL_BUSY_MESSAGE)
      return
    }
    backfillPageLeaseRef.current = pageLease
    const fail = (message: string, historyId = savedHistoryId) => setBackfill({ language, historyId, phase: 'failed', progress: 0, error: message })
    setBackfill({ language, historyId: savedHistoryId, phase: 'preparing', progress: 0 })
    try {
      let historyId = savedHistoryId
      if (!historyId) {
        historyId = await lookupConsumerHistoryId(visibleSessionId)
        if (historyId) setSavedHistoryId(historyId)
      }
      if (!historyId) {
        fail('记录还在保存中，请稍等几秒钟再试')
        return
      }
      let input = inputAudioRef.current
      if (!input) input = (await loadHistoryAudio(visibleSessionId).catch(() => ({} as HistoryAudioArchive))).input || null
      if (!input) input = (await loadConsumerHistoryAudio(historyId, visibleSessionId, 'input').catch(() => undefined)) || null
      if (!input) {
        fail('本次会话没有留下原文录音，无法生成', historyId)
        return
      }
      inputAudioRef.current = input
      const pcm = wavToPCM16Mono16k(new Uint8Array(await input.arrayBuffer()))
      if (pcm.length === 0) {
        fail('原文录音为空，无法生成', historyId)
        return
      }
      backfillAudioRef.current = null
      backfillRecorderRef.current = createPCMReplayRecorderFactory({
        pcm,
        paceFactor: BACKFILL_DEFAULT_PACE_FACTOR,
        onProgress: (fraction) => setBackfill((current) => (
          current && current.language === language && (current.phase === 'running' || current.phase === 'ready')
            ? { ...current, phase: 'running', progress: fraction }
            : current
        )),
        // 录音发完：让服务端收尾（stop → processing → finished）。
        onDone: () => { void backfillSessionRef.current.stop() },
      })
      setBackfill({ language, historyId, phase: 'ready', progress: 0 })
    } catch (error) {
      fail(error instanceof Error ? error.message : '生成失败，请重试')
    }
  }
  const cancelBackfill = () => {
    backfillPageLeaseRef.current = null
    backfillRecorderRef.current = null
    void backfillSessionRef.current.stop()
    setBackfill(null)
  }
  // ready → 在带上新语言与 purpose 的这次渲染里启动（start 读的是本次渲染的 options）。
  useEffect(() => {
    if (backfill?.phase !== 'ready') return
    const pageLease = backfillPageLeaseRef.current
    if (!pageLease?.()) { setBackfill(null); return }
    setBackfill((current) => (current && current.phase === 'ready' ? { ...current, phase: 'running' } : current))
    void backfillSession.start({}, pageLease)
  }, [backfill?.phase]) // eslint-disable-line react-hooks/exhaustive-deps
  // 会话收尾：译文并入结束页，音频并入原会话的回放归档，然后进入保存。
  const backfillStatus = backfillSession.status
  useEffect(() => {
    if (!backfill || (backfill.phase !== 'running' && backfill.phase !== 'ready')) return
    if (!terminalStatus(backfillStatus)) return
    const { language } = backfill
    const output = backfillSession.outputs[language]
    if (backfillSession.error === BACKFILL_BUSY_MESSAGE) {
      // 别的标签页/设备正在补译：toast 提示，按钮恢复可点，不排队。
      setBackfillToast(BACKFILL_BUSY_MESSAGE)
      setBackfill(null)
      return
    }
    if (backfillStatus === 'error' || !output) {
      setBackfill({ ...backfill, phase: 'failed', error: backfillSession.error || '没有收到译文，请重试' })
      return
    }
    setBackfilledOutputs((current) => ({ ...current, [language]: output }))
    const outputBlob = backfillAudioRef.current?.outputs?.[language]
    if (outputBlob && visibleSessionId) {
      const existing = archiveRef.current || {}
      const merged: HistoryAudioArchive = { ...existing, outputs: { ...(existing.outputs || {}), [language]: outputBlob } }
      archiveRef.current = merged
      playback.capture({ id: visibleSessionId }, merged)
    }
    setBackfill({ ...backfill, phase: 'saving', progress: 1 })
  }, [backfillStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (backfill?.phase !== 'saving') return undefined
    const { language, historyId } = backfill
    const units = buildConsumerHistoryInput({
      sessionId: visibleSessionId,
      provider,
      sourceLanguage,
      targetLanguages: [language],
      durationMs: 0,
      rows: historyRows.filter((row) => row.layoutLanguage === language),
    }).units
    let active = true
    void appendConsumerHistoryLanguage(historyId, language, units).then((result) => {
      if (!active) return
      if (result.ok) setBackfill(null)
      else setBackfill((current) => (current ? { ...current, phase: 'failed', error: result.error } : current))
    })
    return () => { active = false }
  }, [backfill?.phase]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (session.completionReason === 'session_time_limit') setCompletionRequested(true)
  }, [session.completionReason])
  useEffect(() => {
    if (!completionRequested) return
    if (session.status === 'idle') {
      setCompletionRequested(false)
      return
    }
    if (!terminalStatus(session.status)) return
    setCompletionRequested(false)
    if (sessionMode !== 'consumer' || historyRows.length === 0 || snapshotSavingRef.current) return
    snapshotSavingRef.current = true
    setHistorySaving(true)
    const localSessionId = session.parentSessionID
    const sessionFailed = Object.values(session.outputs).some(output => Boolean(output.error))
    const input = { ...buildConsumerHistoryInput({
      sessionId: localSessionId,
      provider,
      sourceLanguage,
      targetLanguages: displayLanguageOrder,
      durationMs: startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0,
      devices: {
        inputs: [{
          label: actualInputLabel,
        }],
        outputs: [{
          label: selectedAudioDeviceLabel(
            audioDevices.outputDevices,
            outputDeviceId,
            audioDevices.defaultOutputDeviceLabel,
            '系统默认输出（具体设备由系统决定）',
          ),
        }],
      },
      rows: historyRows,
      settings: sessionSettings,
      traceId: session.traceId,
    }), abnormalExit: sessionFailed, completionReason: sessionFailed ? 'client_error' : session.completionReason || 'client_stopped' }
    void saveConsumerHistory(input).then((saved) => {
      snapshotSavingRef.current = false
      setHistorySaving(false)
      setSavedHistoryId(saved.id)
      clearConsumerHistoryCheckpoint(localSessionId)
      void historySync.waitForAudioSave(localSessionId).catch(() => undefined)
    }).catch((caught) => {
      snapshotSavingRef.current = false
      setHistorySaving(false)
      setSnapshotError(caught instanceof Error ? caught.message : '无法保存同传历史记录。')
    })
  }, [audioDevices.defaultInputDeviceLabel, audioDevices.defaultOutputDeviceLabel, audioDevices.inputDevices, audioDevices.outputDevices, completionRequested, displayLanguageOrder, historyRows, inputDeviceId, outputDeviceId, provider, session.parentSessionID, session.status, session.outputs, session.traceId, sessionMode, sessionSettings, sourceLanguage])
  const feedback = useSentenceFeedback(visibleSessionId)
  const terminal = completionRequested || terminalStatus(session.status) || Boolean(returnView && session.status === 'idle')
  useModelInputArchive([visibleSessionId], terminal && sessionMode === 'consumer', playback.capture)
  const follow = useTranscriptFollow(visibleRows.map((row) => [row.source, row.translations]), !terminal)
  // 需要补译：当前页签语言的会话输出没有内容（勾选新语言时 hook 只建了空占位），
  // 且实际显示的行里也没有它的译文（从历史页返回时输出为空、行来自 returnView）。
  const backfillPendingLanguages = useMemo(() => new Set(
    !showcaseOutputHasContent(mergedOutputs[primaryLanguage])
    && !visibleRows.some((row) => (row.translations[primaryLanguage] || '').trim())
      ? [primaryLanguage]
      : [],
  ), [mergedOutputs, primaryLanguage, visibleRows])
  const displayedRows = useSegmentedShowcaseTypewriter(
    visibleRows,
    primaryLanguage,
    session.status === 'recording' && !completionRequested,
    follow.onTextProgress,
  )
  const punctuatedRows = useMemo(() => moveLeadingTranslationPunctuation(displayedRows), [displayedRows])
  const busy = busyStatus(session.status)
  // 结束前最后 10 秒的提醒（单人）。
  const sessionEnding = useSessionEndingCountdown(
    session.sessionEndsAtMs,
    session.status === 'recording' || session.status === 'processing',
  )
  // 结束页（消费者模式）：与 App 结束页一致——左上返回主页，不再显示品牌标、模式切换、语言设置与录音键。
  // 补译只针对本次会话已勾选但没有译文的语言。内部演示（eval）保持原样。
  const finishedView = terminal && sessionMode === 'consumer'
  const historyTitle = useHistoryTitle(savedHistoryId, undefined, finishedView)
  const displayStatus = completionRequested || (returnView && session.status === 'idle') ? 'finished' : session.status
  const featuredRowId = featuredShowcaseRowId(displayedRows)
  const inputOptions = useMemo(() => [
    { value: 'default', label: session.status === 'recording' && inputDeviceId === 'default'
      ? defaultAudioDeviceLabel(actualInputLabel, '默认设备（名称未公开）')
      : defaultAudioDeviceLabel(audioDevices.defaultInputDeviceLabel, '系统默认麦克风（设备名称未公开，请授权后刷新）') },
    ...audioDevices.inputDevices.map((device) => ({ value: device.deviceId, label: session.status === 'recording' && device.deviceId === inputDeviceId
      ? actualInputLabel
      : device.label })),
  ], [audioDevices.inputDevices, audioDevices.defaultInputDeviceLabel, actualInputLabel, inputDeviceId, session.status])
  const outputOptions = useMemo(() => [
    { value: 'default', label: defaultAudioDeviceLabel(audioDevices.defaultOutputDeviceLabel, '系统默认播放设备（设备名称未公开）') },
    ...audioDevices.outputDevices.map((device) => ({ value: device.deviceId, label: device.label })),
  ], [audioDevices.outputDevices, audioDevices.defaultOutputDeviceLabel])
  const monitorAvailable = service === 'websocket' && audioDevices.outputSelectionSupported
  const localMonitor = useAutomaticAudioMonitor({
    mainDeviceId: outputDeviceId,
    inputDeviceId,
    rawDevices: audioDevices.rawDevices,
    available: monitorAvailable,
    initialized: audioDevices.initialized,
    configure: session.changeMonitorOutput,
    error: session.monitorError,
  })
  const monitorOutputDeviceId = localMonitor.deviceId
  const monitorOptions = useMemo(() => [
    { value: 'auto', label: localMonitor.choice === 'auto' && monitorOutputDeviceId
      ? `自动（${audioDevices.outputDevices.find(device => device.deviceId === monitorOutputDeviceId)?.label || '耳机'}）`
      : '自动（耳机）' },
    { value: '', label: '关闭' },
    ...audioDevices.outputDevices.filter(hasExplicitMonitorOutputId).map(device => ({
      value: device.deviceId,
      label: device.label,
      disabled: Boolean(monitorOutputConflict({ monitorDeviceId: device.deviceId, mainDeviceId: outputDeviceId, rawDevices: audioDevices.rawDevices })),
    })),
  ], [audioDevices.outputDevices, audioDevices.rawDevices, outputDeviceId, localMonitor.choice, monitorOutputDeviceId])
  useEffect(() => {
    if (localMonitor.notice) setBackfillToast(localMonitor.notice)
  }, [localMonitor.notice])
  const selectedInputLabel = inputDeviceId === 'default'
    ? audioDevices.defaultInputDeviceLabel
    : audioDevices.inputDevices.find((device) => device.deviceId === inputDeviceId)?.label || ''
  const selectedOutputLabel = outputDeviceId === 'default'
    ? audioDevices.defaultOutputDeviceLabel
    : audioDevices.outputDevices.find((device) => device.deviceId === outputDeviceId)?.label || ''
  // 使用本地模型名称；可用性仍由 /api/config 的路由就绪状态决定。
  const ttsOptions = showcaseTTSOptions(providers, translationModel)
  const recording = session.status === 'recording'
  const deviceSwitching = session.inputDeviceSwitching || session.outputDeviceSwitching

  useEffect(() => {
    if (busy || !audioDevices.initialized || !audioDevices.permissionGranted) return
    let changed = false
    if (inputDeviceId !== 'default' && !audioDevices.inputDevices.some((device) => device.deviceId === inputDeviceId)) {
      inputSelectionManuallyChangedRef.current = false
      setInputDeviceId('default')
      changed = true
    }
    if (outputDeviceId !== 'default' && !audioDevices.outputDevices.some((device) => device.deviceId === outputDeviceId)) {
      setOutputDeviceId('default')
      changed = true
    }
    if (changed && !preferredDJIInputDevice(audioDevices.inputDevices)) menuSettingsTouchedRef.current = true
  }, [audioDevices.initialized, audioDevices.inputDevices, audioDevices.outputDevices, audioDevices.permissionGranted, busy, inputDeviceId, outputDeviceId])

  const chooseProvider = (model: ShowcaseTranslationModel, tts: ShowcaseTTSModel) => {
    const next = providerForShowcaseSelection(providers, model, tts)
    if (next) {
      menuSettingsTouchedRef.current = true
      setChosenProvider(next.id)
    }
  }
  const chooseService = (nextService: ShowcaseService) => {
    const nextProviders = routesForService(routes, nextService)
    const next = providerForShowcaseSelection(nextProviders, translationModel, ttsModel)
      || preferredShowcaseProvider(nextProviders)
    menuSettingsTouchedRef.current = true
    setService(nextService)
    if (next) setChosenProvider(next.id)
  }
  const [settingsInfoTopic, setSettingsInfoTopic] = useState<ShowcaseSettingsInfoTopic | null>(null)
  const [deviceGuideSignal, setDeviceGuideSignal] = useState(0)
  const closeSettingsInfo = useCallback(() => setSettingsInfoTopic(null), [])
  const applyNoisePreset = (value: Exclude<ShowcaseNoisePreset, 'custom'>) => {
    if (value === 'demo-presentation') return
    const preset = showcaseNoisePresetSettings[value]
    chooseService(preset.service)
    setWebRTCEchoCancellation(preset.echoCancellation)
    setSystemInputProcessing(preset.systemProcessing)
    setDeepFilterNet(preset.deepFilterNet)
    setVADLoudnessMode(preset.mode)
    if (preset.mode === 'p90_400ms') setP90LoudnessThresholdDbfs(preset.threshold)
    else setFrameRMSLoudnessThresholdDbfs(preset.threshold)
  }
  const chooseNoisePreset = (value: string) => {
    if (value === 'custom') return
    if (phoneCallPresetAvailable) {
      // 手机：「系统降噪」即手机通话链路；手动选过之后不再按硬件自动切换。
      mobileNoisePresetManualRef.current = true
      writeShowcaseMenuSettings({ mobileNoisePresetManual: true })
      applyNoisePreset(value === 'echo-cancellation' ? 'phone-call' : value as Exclude<ShowcaseNoisePreset, 'custom'>)
      return
    }
    if (value === 'echo-cancellation') {
      setEchoCancellationSetupOpen(true)
      return
    }
    applyNoisePreset(value as Exclude<ShowcaseNoisePreset, 'custom'>)
  }

  // 迁移旧的单麦预设：手机桌面版的系统降噪走通话链路，已取消的大疆专用回到现有模式。
  useEffect(() => {
    if (phoneCallPresetAvailable && noisePreset === 'echo-cancellation') applyNoisePreset('phone-call')
    if (noisePreset === 'demo') applyNoisePreset(phoneCallPresetAvailable && !preferredExternalInputDevice(audioDevices.rawDevices.filter((device) => device.kind === 'audioinput')) ? 'phone-call' : 'headphones')
    // applyNoisePreset 每次渲染都是新函数；只在预设或可用输入设备变化时重新判断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noisePreset, phoneCallPresetAvailable, audioDevices.rawDevices])

  useEffect(() => {
    if (initialDeviceSelectionDoneRef.current || !config || audioDevices.loading || !audioDevices.initialized || !audioDevices.permissionGranted) return
    initialDeviceSelectionDoneRef.current = true
    if (busy || menuSettingsTouchedRef.current || inputSelectionManuallyChangedRef.current) return
    const preferred = preferredDJIInputDevice(audioDevices.inputDevices)
    if (!preferred) return
    // Refresh-only input selection: the retired solo DJI preset is no longer applied.
    setInputDeviceId(preferred.deviceId)
  }, [audioDevices.initialized, audioDevices.permissionGranted, audioDevices.loading, audioDevices.inputDevices, busy, config])

  // 手机浏览器按硬件选默认降噪模式：接耳机 / 外接麦克风走「耳机收声」（耳机保真），
  // 否则「系统降噪」（手机通话链路）。用户手动选过或本次
  // 改过设置后不再跟随。自动推荐只改内存状态，不写进已保存的偏好。
  useEffect(() => {
    if (!phoneCallPresetAvailable || busy || !audioDevices.initialized || !audioDevices.permissionGranted) return
    if (mobileNoisePresetManualRef.current || menuSettingsTouchedRef.current) return
    // 用原始列表（含 'default' 伪设备的名字，如 Android 的「Default - Wired headset」）判断是否接了耳机。
    const preset = preferredExternalInputDevice(audioDevices.rawDevices.filter((device) => device.kind === 'audioinput'))
      ? showcaseNoisePresetSettings.headphones
      : showcaseNoisePresetSettings['phone-call']
    setService(preset.service)
    setWebRTCEchoCancellation(preset.echoCancellation)
    setSystemInputProcessing(preset.systemProcessing)
    setDeepFilterNet(preset.deepFilterNet)
    setVADLoudnessMode(preset.mode)
    setFrameRMSLoudnessThresholdDbfs(preset.threshold)
  }, [audioDevices.initialized, audioDevices.inputDevices, audioDevices.rawDevices, audioDevices.permissionGranted, busy, phoneCallPresetAvailable])

  const toggleTarget = (language: string) => {
    if (busy || !allowedTargets.has(language)) return
    if (maxSoloTargets === 1) { setTargetLanguages([language]); setPrimaryLanguage(language); return }
    if (targetLanguages.includes(language)) {
      if (targetLanguages.length === 1) return
      const next = targetLanguages.filter(value => value !== language)
      setTargetLanguages(next)
      if (primaryLanguage === language) setPrimaryLanguage(next[0])
    } else if (targetLanguages.length < maxSoloTargets) setTargetLanguages([...targetLanguages, language])
  }

  const beginSoloSession = async (fields: ProductAttempt['fields'], pageLease = session.capturePageLease()) => {
    if (!pageLease()) return
    setSnapshotError('')
    setSavedHistoryId('')
    setHistorySaving(false)
    setCompletionRequested(false)
    clearShowcaseReturnView()
    setReturnView(null)
    playback.clear()
    startedAtRef.current = Date.now()
    await session.start(fields, pageLease)
  }

  const startSolo = async () => {
    const pageLease = session.capturePageLease()
    if (!pageLease()) return
    const consentLease = sessionMode !== 'eval' ? canaryAIPrivacyGate.captureAuthorization() : () => true
    if (sessionMode !== 'eval' && !await canaryAIPrivacyGate.ensureAuthorized()) return
    if (!consentLease() || !pageLease()) return
    const fields = beginProductAttempt({ mode: 'solo', sourceLanguage, targetLanguage: primaryLanguage, targetCount: targetLanguages.length, audioEnabled: targetLanguages.some(language => !mutedLanguages.has(language)) })
    analyticsAttemptRef.current = { fields, startedAt: performance.now() }
    if (communityAudio.pcm) { await beginSoloSession(fields,pageLease); return }
    if (!audioDevices.permissionGranted) {
      const granted = await audioDevices.requestPermissionAndRefresh()
      if (!granted) setSnapshotError('未取得麦克风权限；可允许浏览器访问，或使用上方 WAV 文件输入。')
      if (!consentLease() || !pageLease()) return
      trackProduct('microphone_result', { ...fields, result: granted ? 'success' : 'failure', reason: granted ? 'granted' : 'denied_or_unavailable' })
      // Device defaults apply on the next render after permission; never start
      // using the pre-permission microphone captured by this callback.
      if (phoneCallPresetAvailable) {
        // 手机：拿不到麦克风弹「连接麦克风」并留在单麦页；桌面照旧打开设置面板引导选设备。
        if (!granted) setMicrophoneNoticeOpen(true)
        return
      }
      // 读不到设备：与点击底部提示一致，打开设置面板并展开麦克风列表引导选择。
      setDeviceGuideSignal((value) => value + 1)
      return
    }
    if (phoneCallPresetAvailable) {
      // 用原始列表判断：inputDevices 已剔除 'default' 伪设备，只有它一条时也算有麦克风。
      if (!audioDevices.rawDevices.some((device) => device.kind === 'audioinput')) {
        setMicrophoneNoticeOpen(true)
        return
      }
      if (shouldShowEnvironmentNotice(readEnvironmentNoticeState(), new Date())) {
        // 确认后再开始：真正的 start 在弹窗的点击里发生，拿到的是最新一轮渲染的状态。
        pendingStartFieldsRef.current = fields
        pendingStartPageLeaseRef.current = pageLease
        setEnvironmentNoticeSuppress(false)
        setEnvironmentNoticeOpen(true)
        return
      }
    }
    await beginSoloSession(fields, pageLease)
  }

  const changeInputDevice = async (nextDeviceId: string) => {
    if (nextDeviceId === inputDeviceId) return
    menuSettingsTouchedRef.current = true
    inputSelectionManuallyChangedRef.current = true
    if (session.paused) {
      setInputDeviceId(nextDeviceId)
      return
    }
    if (!recording) {
      if (!busy) setInputDeviceId(nextDeviceId)
      return
    }
    if (await session.changeInputDevice(nextDeviceId)) setInputDeviceId(nextDeviceId)
  }

  const changeOutputDevice = async (nextDeviceId: string) => {
    if (nextDeviceId === outputDeviceId) return
    if (monitorOutputDeviceId && monitorOutputConflict({ monitorDeviceId: monitorOutputDeviceId, mainDeviceId: nextDeviceId, rawDevices: audioDevices.rawDevices })) {
      localMonitor.suspend()
    }
    menuSettingsTouchedRef.current = true
    if (!recording) {
      if (!busy) setOutputDeviceId(nextDeviceId)
      return
    }
    if (await session.changeOutputDevice(nextDeviceId)) setOutputDeviceId(nextDeviceId)
    else localMonitor.reconcile()
  }

  const settings = (
    <>
      {/* 快速开始：输入 → 输出 → 原译显示 → 降噪 → 音量；页脚为额度与历史。 */}
      <div className="realtime-showcase-settings-title"><strong>{quickAudioEnabled ? '模式设置' : busy ? SETTINGS_PANEL_COPY.busy.title : 'Luna-LT-Flash 同传设置'}</strong>{!quickAudioEnabled && <span>{recording ? SETTINGS_PANEL_COPY.busy.subtitle : SETTINGS_PANEL_COPY.solo.subtitle}</span>}</div>
      <ShowcaseSettingsInfoDialog topic={settingsInfoTopic} onClose={closeSettingsInfo} />
      <div className="showcase-panel-fields">
        {(quickAudioEnabled || !busy || recording) && <PanelRow label="输入设备"><DeviceCombobox ariaLabel="选择输入设备" options={inputOptions} value={inputDeviceId} disabled={deviceSwitching || (busy && !recording)} onOpen={() => { void audioDevices.refresh() }} onChange={(value) => { void changeInputDevice(value) }} /></PanelRow>}
        {recording && session.inputDeviceSwitching && <p className="showcase-output-device-hint">正在切换麦克风，当前设备：{actualInputLabel}</p>}
        {(!busy || recording) && isHeadsetEarpieceLabel(selectedInputLabel) && <p className="showcase-output-device-hint">浏览器将 Headset earpiece 列为输入设备；名称不能确认实际收音麦克风。</p>}
        {(quickAudioEnabled || !busy || (recording && audioDevices.streamOutputSelectionSupported)) && <>
          <PanelRow label="输出设备"><DeviceCombobox ariaLabel="选择输出设备" options={outputOptions} value={outputDeviceId} disabled={deviceSwitching || (busy && !recording) || !audioDevices.streamOutputSelectionSupported} onOpen={() => { void audioDevices.refresh() }} onChange={(value) => { void changeOutputDevice(value) }} /></PanelRow>
          {isHeadsetEarpieceLabel(selectedOutputLabel) && <p className="showcase-output-device-hint">当前选择 Headset earpiece，声音可能从贴耳听筒播放；需要外放请在列表中选择系统提供的扬声器设备。</p>}
          {!audioDevices.streamOutputSelectionSupported && <p className="showcase-output-device-hint">当前浏览器不支持网页切换播放设备；蓝牙耳机由手机系统选择。</p>}
          {audioDevices.streamOutputSelectionSupported && audioDevices.permissionGranted && audioDevices.outputDevices.length === 0 && <p className="showcase-output-device-hint">浏览器未提供可选播放设备，当前使用系统默认输出。</p>}
          {!quickAudioEnabled && monitorAvailable && <LocalAudioMonitorSettings
            options={monitorOptions}
            choice={localMonitor.choice}
            deviceId={monitorOutputDeviceId}
            volume={monitorVolume}
            disabled={deviceSwitching || session.monitorDeviceSwitching}
            notice={localMonitor.notice}
            onDeviceChange={value => { void localMonitor.choose(value) }}
            onVolumeChange={setMonitorVolume}
          />}
        </>}
        {quickAudioEnabled && <>
          <PanelRow label="原译显示"><DeviceCombobox ariaLabel="选择原译显示" options={TRANSCRIPT_DISPLAY_OPTIONS} value={quickTranscriptDisplay} disabled={false} onChange={value => {
            const next = value as TranscriptDisplayMode
            setQuickTranscriptDisplay(next)
            try { saveQuickTranscriptDisplay(next); setQuickAudioError('') }
            catch { setQuickAudioError('设置已应用，但未能保存。请重试。') }
          }} /></PanelRow>
          <QuickAudioSettings value={quickAudio} busy={busy} onChange={value => {
            setQuickAudio(value)
            try { saveQuickAudio(value); setQuickAudioError('') }
            catch { setQuickAudioError('设置已应用，但未能保存。请重试。') }
          }} />
          {quickAudioError && <p role="alert">{quickAudioError}</p>}
        </>}
        {!busy && !quickAudioEnabled && <>
            <PanelRow label={<>设备模式<ShowcaseSettingsInfoButton topic="noise" onOpen={setSettingsInfoTopic} /></>}><DeviceCombobox ariaLabel="选择设备模式" options={noisePresetOptions(noisePreset, phoneCallPresetAvailable)} value={noisePreset} disabled={false} onChange={chooseNoisePreset} /></PanelRow>
            {!quickAudioEnabled && <PanelRow label="降噪模式"><DeviceCombobox ariaLabel="选择降噪模式" options={noiseReductionOptions(vadLoudnessMode)} value={String(vadLoudnessThresholdDbfs)} fallbackLabel="自定义" disabled={false} onChange={(value) => {
              menuSettingsTouchedRef.current = true
              if (vadLoudnessMode === 'p90_400ms') setP90LoudnessThresholdDbfs(Number(value) as P90LoudnessThresholdDbfs)
              else setFrameRMSLoudnessThresholdDbfs(Number(value) as FrameRMSLoudnessThresholdDbfs)
            }} /></PanelRow>}
            <PanelRow label={<>使用场景<ShowcaseSettingsInfoButton topic="tts" onOpen={setSettingsInfoTopic} /></>}><DeviceCombobox ariaLabel="选择使用场景" options={ttsOptions} value={ttsModel} disabled={false} onChange={(value) => chooseProvider(translationModel, value as ShowcaseTTSModel)} /></PanelRow>
        </>}
      </div>
      {!busy && !quickAudioEnabled && <>
        <details hidden className="realtime-showcase-advanced-audio showcase-panel-advanced">
          <summary>高级设置</summary>
          <div className="realtime-showcase-advanced-audio__content">
            <ShowcaseLanguageSettings value={hotwords} onChange={(value) => {
              menuSettingsTouchedRef.current = true
              setHotwords(value)
            }} />
            <PanelToggleRow title="DeepFilterNet3 降噪" description="所有语言共享降噪后的输入" ariaLabel="DeepFilterNet3 降噪" checked={deepFilterNet} disabled={false} onToggle={() => {
              menuSettingsTouchedRef.current = true
              setDeepFilterNet(!deepFilterNet)
            }} />
            <PanelToggleRow title="高亮仅显示阅读文本" description="关闭后高亮正在播放的整段译文" ariaLabel="高亮仅显示阅读文本" checked={highlightReadingTextOnly} disabled={false} onToggle={() => {
              menuSettingsTouchedRef.current = true
              setHighlightReadingTextOnly(!highlightReadingTextOnly)
            }} />
            <ShowcaseAudioProcessingSettings
              plain
              hideDeepFilterNet
              service={service}
              webRTCEchoCancellation={webRTCEchoCancellation}
              deepFilterNet={deepFilterNet}
              vadLoudnessMode={vadLoudnessMode}
              vadLoudnessThresholdDbfs={vadLoudnessThresholdDbfs}
              disabled={false}
              onServiceChange={chooseService}
              onWebRTCEchoCancellationChange={(enabled) => {
                menuSettingsTouchedRef.current = true
                setWebRTCEchoCancellation(enabled)
              }}
              onDeepFilterNetChange={(enabled) => {
                menuSettingsTouchedRef.current = true
                setDeepFilterNet(enabled)
              }}
              onVADLoudnessModeChange={(nextMode) => {
                menuSettingsTouchedRef.current = true
                setVADLoudnessMode(nextMode)
              }}
              onVADLoudnessThresholdChange={(threshold) => {
                menuSettingsTouchedRef.current = true
                if (vadLoudnessMode === 'p90_400ms') setP90LoudnessThresholdDbfs(threshold as P90LoudnessThresholdDbfs)
                else setFrameRMSLoudnessThresholdDbfs(threshold as FrameRMSLoudnessThresholdDbfs)
              }}
            />
          </div>
        </details>
      </>}
      {busy && !recording && <p className="realtime-showcase-settings-note">会话正在连接或结束处理中，暂时没有可调整的选项。</p>}
      <ConsumerAccountSettings
        loggedIn={loggedIn}
        guest={canaryUi && sessionMode === 'guest'}
        quota={consumerQuota}
        historyVisible={!busyStatus(session.status)}
        // 只有结束页（有内容）才记返回视图；从欢迎页进历史再回来应仍是欢迎页，否则会变成空的结束页。
        onBeforeHistory={() => (terminal && visibleRows.length > 0 ? writeShowcaseReturnView({
          mode: 'solo',
          scene,
          sessionId: visibleSessionId,
          provider,
          sourceLanguage,
          targetLanguages,
          primaryLanguage,
          rows: visibleRows,
          rowsByPrimaryLanguage: visibleRowsByPrimaryLanguage,
          historyId: savedHistoryId,
        }) : clearShowcaseReturnView())}
      />
    </>
  )

  return (
    <>
    <ShowcaseFrame
      mode={mode}
      scene={scene}
      homeModes={onHomeModeChange ? <HomeModeSwitch value={scene || 'solo'} disabled={busy} meetingAvailable={meetingAvailable} onChange={onHomeModeChange} /> : undefined}
      startLabel={sceneCopy?.startLabel}
      status={displayStatus}
      fontSize={fontSize}
      paused={session.paused}
      muted={muted}
      busy={busy}
      restoreHeader={completionRequested}
      infoNotice={session.completionReason === 'session_time_limit' ? sessionTimeLimitNotice
        : config?.consumerVoiceCloneRequired ? '已开启音色克隆，译音使用本次说话的音色。' : undefined}
      infoNoticeDismissible={Boolean(canaryUi && config?.consumerVoiceCloneRequired && session.completionReason !== 'session_time_limit')}
      endingNotice={sessionEnding.notice}
      liveSnapshot={sessionMode === 'consumer' && session.parentSessionID ? { ...(checkpointInput || { sessionId: session.parentSessionID, sourceLanguage, targetLanguage: targetLanguages[0], durationMs: 0, sourceText: '', translationText: '', units: [] }), units: Object.entries(rowsByPrimaryLanguage).flatMap(([layoutLanguage, layoutRows]) => layoutRows.map(row => ({ id: row.id, source: row.source, text: row.translations[layoutLanguage] || '', translations: row.translations, startMs: row.startMs, outputAudioStarts: row.outputAudioStarts, outputAudioEnds: row.outputAudioEnds, layoutLanguage }))), targetLanguages } : undefined}
      liveStatus={terminalStatus(session.status) ? 'ended' : session.paused ? 'paused' : 'live'}
      settings={settings}
      toolbar={busy && !completionRequested ? null : (
        <div className={`showcase-language-rail${terminal ? ' showcase-language-rail--completed' : ''}${finishedView ? ' showcase-language-rail--finished' : ''}`} aria-label="输出语言">
          {!finishedView && (scene === 'conversation' ? <ConversationLanguageControls languages={[targetLanguages[0], targetLanguages[1]]} disabled={busy || Boolean(returnView)} onChange={languages => { setTargetLanguages(languages); setPrimaryLanguage(languages[0]) }} /> : <LanguageDirectionSelect
            sourceLanguage={sourceLanguage}
            sourceOptions={sourceOptions}
            selected={targetLanguages}
            maxTargets={maxSoloTargets}
            allowedTargets={allowedTargets}
            disabled={busy}
            open={languageSelectOpen}
            onOpenChange={setLanguageSelectOpen}
            onSourceChange={setSourceLanguage}
            onToggle={toggleTarget}
          />)}
          {finishedView && (
            <HistorySessionSummary context={{ mode: 'solo', scene, ...historyTitle }} duration={finishedDurationMs !== null ? formatShowcaseDuration(finishedDurationMs) : undefined}>
                输出语言 {targetLanguages.map((language) => chineseLanguageNames[language] || languageNames[language] || language).join(' / ')}
                {consumerQuota ? ` · ${consumerQuotaLabel(consumerQuota)}` : ''}
            </HistorySessionSummary>
          )}
          {terminal && <CompletedLanguageSwitch groups={[{
            languages: targetLanguages,
            value: primaryLanguage,
            onChange: (language: string) => { trackProduct('language_changed', { mode: 'solo', targetLanguage: language }); setPrimaryLanguage(language) },
          }]} />}
        </div>
      )}
      notice={(session.error && terminal && sessionMode === 'consumer' ? `${session.error} 点击尝试读取后台保存的转录记录。` : session.error) || snapshotError || audioDevices.error || historySync.sharedHistoryError || (!ready && health.available === false ? health.reason || 'S2ST 服务暂时不可用。' : '')}
      noticeActionOpensDevices={!(session.error && terminal && sessionMode === 'consumer')}
      onNoticeAction={session.error && terminal && sessionMode === 'consumer' ? () => { void openRecoveredSessionHistory(session.parentSessionID) } : !session.error && !snapshotError && audioDevices.error ? async () => { const gated = canaryDesignEnabled() && sessionMode !== 'eval'; const lease = gated ? canaryAIPrivacyGate.captureAuthorization() : () => true; if ((!gated || await canaryAIPrivacyGate.ensureAuthorized()) && lease()) await audioDevices.requestPermissionAndRefresh() } : undefined}
      deviceGuideSignal={deviceGuideSignal}
      welcomeTitle={sceneCopy?.title || WELCOME_COPY.solo.title}
      welcomeSubtitle={sceneCopy?.subtitle || WELCOME_COPY.solo.subtitle}
      hasContent={visibleRows.length > 0}
      controlDisabled={completionRequested || session.status === 'connecting' || session.status === 'processing' || (!ready && session.status !== 'recording')}
      pauseDisabled={deviceSwitching}
      onModeChange={onModeChange}
      onControl={startSolo}
      onMute={() => setMuted((value) => !value)}
      onPause={() => { void (session.paused ? session.resume() : session.pause()) }}
      leaveReady={(terminalStatus(session.status) || session.status === 'idle') && !completionRequested && !historySaving}
      onLeave={async () => {
        if (!session.paused && !await session.pause()) throw new Error('microphone release failed')
        setCompletionRequested(true)
        await session.stop()
      }}
      onComplete={() => {
        setCompletionRequested(true)
        void session.stop()
      }}
      footerAction={terminal && sessionMode === 'consumer' && visibleRows.length > 0
        ? <ConsumerSessionShare historyId={savedHistoryId} sessionId={visibleSessionId} saving={historySaving || completionRequested} onResolved={setSavedHistoryId} />
        : undefined}
      finished={finishedView}
    >
      {scene === 'conversation' && !finishedView ? <ConversationTranscript languages={[targetLanguages[0], targetLanguages[1]]} rowsByLanguage={visibleRowsByPrimaryLanguage} activeSide={conversationSide} onActiveSideChange={setConversationSide} /> : <div className={`realtime-showcase-transcript showcase-multilingual-transcript${terminal ? ' showcase-multilingual-transcript--completed' : ''}${finishedView ? ' showcase-multilingual-transcript--finished' : ''}`} {...follow.playbackGesture} ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
        <div className="realtime-showcase-transcript-track">
          {finishedView && visibleRows.length > 0 && (backfill?.language === primaryLanguage || backfillPendingLanguages.has(primaryLanguage)) && (
            <div className="showcase-backfill" role="status" aria-live="polite">
              {backfill?.language === primaryLanguage && backfill.phase === 'failed' ? (
                <>
                  <p className="showcase-backfill-note">{backfill.error || '生成失败'}</p>
                  <button type="button" className="showcase-backfill-button" onClick={() => { void startBackfill(primaryLanguage) }}>重试</button>
                </>
              ) : backfill?.language === primaryLanguage ? (
                <>
                  <p className="showcase-backfill-note">
                    {backfill.phase === 'saving' ? '正在保存…' : backfill.phase === 'running' ? `生成中 · ${Math.round(backfill.progress * 100)}%` : '准备中…'}
                  </p>
                  {backfill.phase !== 'saving' && <button type="button" className="showcase-backfill-button" onClick={cancelBackfill}>取消</button>}
                </>
              ) : (
                <>
                  <p className="showcase-backfill-note">本次同传没有{chineseLanguageNames[primaryLanguage] || primaryLanguage}译文，可用录音生成（不计费）。</p>
                  <button type="button" className="showcase-backfill-button" disabled={!visibleSessionId} onClick={() => { void startBackfill(primaryLanguage) }}>
                    生成{chineseLanguageNames[primaryLanguage] || primaryLanguage}译文
                  </button>
                </>
              )}
            </div>
          )}
          {backfillToast && <div className="showcase-backfill-toast" role="status">{backfillToast}</div>}
          {punctuatedRows.map((row, rowIndex) => {
            const featured = !terminal && row.id === featuredRowId
            const sourceKey = `source:${row.id}`
            const playableLanguages = new Set(targetLanguages.filter((language) => (
              terminal
              && typeof row.outputAudioStarts[language] === 'number'
              && playback.hasTrack(visibleSessionId, language)
            )))
            const playingLanguages = new Set([
              ...targetLanguages.filter((language) => playback.playingKey === `translation:${row.id}:${language}`),
            ])
            const playedLanguages = new Set(targetLanguages.filter((language) => playback.playedKeys.has(`translation:${row.id}:${language}`)))
            return <SoloTranscriptRow
              key={row.id}
              row={row}
              displayMode={quickAudioEnabled ? quickTranscriptDisplay : 'bilingual'}
              variant={featured ? 'featured' : row.committed || terminal ? 'history' : 'live'}
              targetLanguages={targetLanguages}
              primaryLanguage={primaryLanguage}
              terminal={terminal}
              feedback={feedback}
              onPrimaryLanguage={(language) => { trackProduct('language_changed', { mode: 'solo', targetLanguage: language }); setPrimaryLanguage(language) }}
              sourcePlayable={terminal && playback.hasTrack(visibleSessionId)}
              sourcePlaying={playback.playingKey === sourceKey}
              playableLanguages={playableLanguages}
              playingLanguages={playingLanguages}
              highlightReadingTextOnly={highlightReadingTextOnly}
              livePlayback={{ enabled: !terminal && !session.paused, segmentId: session.outputs[primaryLanguage]?.playingTranslationSegmentId || null }}
              playedLanguages={playedLanguages}
              pendingLanguages={backfillPendingLanguages}
              typewriterEnabled={false}
              onTextProgress={follow.onTextProgress}
              onPlaySource={() => { void playback.play({
                sessionId: visibleSessionId,
                startMs: row.startMs,
                endMs: showcaseAudioEndMs(visibleRows, rowIndex),
                outputDeviceId,
                key: sourceKey,
              }) }}
              onPlayTranslation={(language) => { void playback.play({
                sessionId: visibleSessionId,
                language,
                startMs: row.outputAudioStarts[language],
                endMs: showcaseAudioEndMs(visibleRows, rowIndex, language),
                outputDeviceId,
                key: `translation:${row.id}:${language}`,
              }) }}
            />
          })}
          {visibleRows.length === 0 && <p className={terminal ? 'showcase-finished-empty-title' : 'realtime-showcase-listening'}>{terminal ? '本次没有识别到语音' : '请开始说话，翻译结果将在这里显示…'}</p>}
          {terminal && <SessionAudioDownloads archives={playback.archives} sessionIds={[visibleSessionId]} playingKey={playback.playingKey} onPlay={playback.stop} />}
        </div>
      </div>}
      {/* 727:4475：主要译文语言 chips 在录音全程固定停靠在译文区底部（底栏上方 24），不随句子出现或滚动。 */}
      {!terminal && (session.status === 'recording' || session.status === 'connecting' || session.status === 'processing') && (targetLanguages.length > 1 || canaryUi) && (
        <div className="showcase-row-languages showcase-row-languages--docked" role="group" aria-label="切换主要译文语言">
          {targetLanguages.map((language) => (
            <button
              type="button"
              key={language}
              className={language === primaryLanguage ? 'is-active' : ''}
              aria-label={`主要译文切换为${displayLanguageName(language, canaryUi)}`}
              aria-pressed={language === primaryLanguage}
              onClick={() => { trackProduct('language_changed', { mode: 'solo', targetLanguage: language }); setPrimaryLanguage(language) }}
            >{languageLabels[language] || language.slice(0, 2).toUpperCase()}</button>
          ))}
        </div>
      )}
    </ShowcaseFrame>
    <EchoCancellationSetupDialog
      open={echoCancellationSetupOpen}
      onConfirm={() => {
        setEchoCancellationSetupOpen(false)
        applyNoisePreset('echo-cancellation')
      }}
      onUseHeadphones={() => {
        setEchoCancellationSetupOpen(false)
        applyNoisePreset('headphones')
      }}
    />
    <ShowcaseConfirmDialog
      open={environmentNoticeOpen}
      title="环境提示"
      titleId="showcase-environment-notice-title"
      actions={[{
        label: '确认',
        primary: true,
        onClick: () => {
          writeEnvironmentNoticeState(environmentNoticeAcknowledged(readEnvironmentNoticeState(), new Date(), environmentNoticeSuppress))
          setEnvironmentNoticeOpen(false)
          const fields = pendingStartFieldsRef.current
          const pageLease = pendingStartPageLeaseRef.current
          pendingStartFieldsRef.current = null
          pendingStartPageLeaseRef.current = null
          if (fields && pageLease?.()) void beginSoloSession(fields, pageLease)
        },
      }]}
      onDismiss={() => {
        pendingStartFieldsRef.current = null
        pendingStartPageLeaseRef.current = null
        setEnvironmentNoticeOpen(false)
      }}
    >
      <p className="showcase-confirm-dialog__lead">需要在安静环境中使用，避免环境噪声影响，建议使用耳机翻译的声音。</p>
      <label className="showcase-confirm-dialog__option">
        <input type="checkbox" checked={environmentNoticeSuppress} onChange={(event) => setEnvironmentNoticeSuppress(event.target.checked)} />
        <i aria-hidden="true" />
        <span>以后不再提示</span>
      </label>
    </ShowcaseConfirmDialog>
    <ShowcaseConfirmDialog
      open={microphoneNoticeOpen}
      title="连接麦克风"
      titleId="showcase-microphone-notice-title"
      actions={[{ label: '确认', primary: true, onClick: () => setMicrophoneNoticeOpen(false) }]}
      onDismiss={() => setMicrophoneNoticeOpen(false)}
    >
      <p className="showcase-confirm-dialog__lead">需连接麦克风，请检查</p>
    </ShowcaseConfirmDialog>
    </>
  )
}

function DuoShowcase({ mode, sessionMode, audioDevices, fontSize, onModeChange }: { mode: ShowcaseMode; sessionMode: MultilingualSessionMode; audioDevices: AudioDevices; fontSize: ShowcaseFontSize; onModeChange: (mode: ShowcaseMode) => void }) {
  const analyticsAttemptRef = useRef<ProductAttempt | null>(null)
  const { config, loadFailed } = usePublicConfig()
  const [storedMenuSettings] = useState(readShowcaseMenuSettings)
  const [hotwords, setHotwords] = useState(() => readShowcaseHotwords(storedMenuSettings))
  const { asrContext, prompt: qwen3SimulSystemPrompt, mode: hotwordMode } = hotwords
  const [storedPreferences] = useState(readShowcasePreferences)
  const menuSettingsTouchedRef = useRef(false)
  const initialDeviceSelectionDoneRef = useRef(false)
  const [returnView, setReturnView] = useState<Extract<ShowcaseReturnView, { mode: 'duo' }> | null>(() => {
    const value = sessionMode === 'consumer' ? readShowcaseReturnView() : null
    return value?.mode === 'duo' ? value : null
  })
  const routes = useMemo(() => availableShowcaseProviders(config?.providers || []), [config?.providers])
  const [service, setService] = useState<ShowcaseService>(() => (
    returnView
      ? (returnView.provider.endsWith('-volc-rtc') ? 'volc-rtc' : 'websocket')
      : storedMenuSettings.service === 'volc-rtc' ? 'volc-rtc' : 'websocket'
  ))
  const [webRTCEchoCancellation, setWebRTCEchoCancellation] = useState(storedMenuSettings.webRTCEchoCancellation ?? true)
  const [deepFilterNet, setDeepFilterNet] = useState(storedMenuSettings.deepFilterNet ?? false)
  const [highlightReadingTextOnly, setHighlightReadingTextOnly] = useState(storedMenuSettings.highlightReadingTextOnly ?? false)
  const [vadLoudnessMode, setVADLoudnessMode] = useState<VADLoudnessMode>(() => storedVADLoudnessMode(storedMenuSettings.vadLoudnessMode))
  const [frameRMSLoudnessThresholdDbfs, setFrameRMSLoudnessThresholdDbfs] = useState<FrameRMSLoudnessThresholdDbfs>(() => storedFrameRMSThreshold(storedMenuSettings.frameRMSLoudnessThresholdDbfs))
  const [p90LoudnessThresholdDbfs, setP90LoudnessThresholdDbfs] = useState<P90LoudnessThresholdDbfs>(() => storedP90Threshold(storedMenuSettings.p90LoudnessThresholdDbfs))
  const providers = useMemo(() => routesForService(routes, service), [routes, service])
  const defaultProvider = preferredShowcaseProvider(providers)?.id || 'vuilabs-qwen3simul-qwen'
  const [chosenProvider, setChosenProvider] = useState(returnView?.provider || storedMenuSettings.provider || '')
  const provider = resolveShowcaseProvider(providers, chosenProvider, defaultProvider)
  const selectedProvider = providers.find((item) => item.id === provider)
  const baseProvider = selectedProvider ? baseProviderID(selectedProvider) : provider
  const translationModel: ShowcaseTranslationModel = 'flash-v2'
  const ttsModel = showcaseTTSModel(provider)
  const [microphoneMode, setMicrophoneMode] = useState<DuoMicrophoneMode>(storedMenuSettings.duoMicrophoneMode === 'stereo' ? 'stereo' : 'separate')
  const [leftDeviceId, setLeftDeviceId] = useState(storedMenuSettings.leftDeviceId || 'default')
  const [rightDeviceId, setRightDeviceId] = useState(storedMenuSettings.rightDeviceId || 'default')
  const [stereoDeviceId, setStereoDeviceId] = useState(storedMenuSettings.stereoDeviceId || 'default')
  const [swapStereoChannels, setSwapStereoChannels] = useState(storedMenuSettings.swapStereoChannels ?? false)
  const [leftOutputDeviceId, setLeftOutputDeviceId] = useState(storedMenuSettings.leftOutputDeviceId || 'default')
  const [rightOutputDeviceId, setRightOutputDeviceId] = useState(storedMenuSettings.rightOutputDeviceId || 'default')
  const [outputMode, setOutputMode] = useState<DuoOutputMode>(storedMenuSettings.duoOutputMode === 'stereo' ? 'stereo' : 'separate')
  const [stereoOutputDeviceId, setStereoOutputDeviceId] = useState(storedMenuSettings.stereoOutputDeviceId || 'default')
  const stereoOutput = outputMode === 'stereo' && service === 'websocket'
  // In crossed listening mode L belongs to A and R to B, including capture.
  // Ignore legacy swap preferences so upgrading cannot reverse the roles.
  const effectiveSwapStereoChannels = stereoOutput ? false : swapStereoChannels
  const effectiveLeftOutputDeviceId = stereoOutput ? stereoOutputDeviceId : leftOutputDeviceId
  const effectiveRightOutputDeviceId = stereoOutput ? stereoOutputDeviceId : rightOutputDeviceId
  const leftOutputChannel = stereoOutput ? 'right' : 'both'
  const rightOutputChannel = stereoOutput ? 'left' : 'both'
  const leftOutputLabel = selectedAudioDeviceLabel(audioDevices.outputDevices, effectiveLeftOutputDeviceId, audioDevices.defaultOutputDeviceLabel, '甲的系统默认输出')
    + (stereoOutput ? ' · R/右声道，乙收听甲的译音' : '')
  const rightOutputLabel = selectedAudioDeviceLabel(audioDevices.outputDevices, effectiveRightOutputDeviceId, audioDevices.defaultOutputDeviceLabel, '乙的系统默认输出')
    + (stereoOutput ? ' · L/左声道，甲收听乙的译音' : '')
  const [snapshotError, setSnapshotError] = useState('')
  const [savedHistoryId, setSavedHistoryId] = useState(returnView?.historyId || '')
  const [historySaving, setHistorySaving] = useState(false)
  const [completionRequested, setCompletionRequested] = useState(false)
  const [echoCancellationSetupOpen, setEchoCancellationSetupOpen] = useState(false)
  const snapshotSavingRef = useRef(false)
  const startedAtRef = useRef(0)
  const [leftSourceLanguage, setLeftSourceLanguage] = useState(normalizeShowcaseSourceLanguage(returnView?.leftSourceLanguage || storedPreferences.duoLeft?.sourceLanguage))
  const [finishedDurationMs, setFinishedDurationMs] = useState<number | null>(null)
  const [rightSourceLanguage, setRightSourceLanguage] = useState(normalizeShowcaseSourceLanguage(returnView?.rightSourceLanguage || storedPreferences.duoRight?.sourceLanguage, 'en'))
  const [leftSelectedTargets, setLeftTargetLanguages] = useState<string[]>(returnView?.leftTargetLanguages || storedPreferences.duoLeft?.targetLanguages || ['en'])
  const [rightSelectedTargets, setRightTargetLanguages] = useState<string[]>(returnView?.rightTargetLanguages || storedPreferences.duoRight?.targetLanguages || ['zh'])
  const leftTargetLanguages = useMemo(() => returnView ? leftSelectedTargets : translationTargets(leftSourceLanguage, leftSelectedTargets, showcaseTargetLanguages), [returnView, leftSourceLanguage, leftSelectedTargets])
  const rightTargetLanguages = useMemo(() => returnView ? rightSelectedTargets : translationTargets(rightSourceLanguage, rightSelectedTargets, showcaseTargetLanguages), [returnView, rightSourceLanguage, rightSelectedTargets])
  const [leftPrimaryLanguage, setLeftPrimaryLanguage] = useState(returnView?.leftPrimaryLanguage || storedPreferences.duoLeft?.primaryLanguage || 'en')
  const [rightPrimaryLanguage, setRightPrimaryLanguage] = useState(returnView?.rightPrimaryLanguage || storedPreferences.duoRight?.primaryLanguage || 'zh')
  useEffect(() => {
    writeShowcasePreferences({
      duoLeft: { sourceLanguage: leftSourceLanguage, targetLanguages: leftTargetLanguages, primaryLanguage: leftPrimaryLanguage },
      duoRight: { sourceLanguage: rightSourceLanguage, targetLanguages: rightTargetLanguages, primaryLanguage: rightPrimaryLanguage },
    })
  }, [leftSourceLanguage, leftTargetLanguages, leftPrimaryLanguage, rightSourceLanguage, rightTargetLanguages, rightPrimaryLanguage])
  const [muted, setMuted] = useState(false)
  const [activeSide, setActiveSide] = useState<'a' | 'b'>('a')
  const [openLanguageSelect, setOpenLanguageSelect] = useState<'a-source' | 'a-target' | 'b-source' | 'b-target' | null>(null)
  const historySync = useHistorySync({ config, initialScope: 'local', sessionMode: 'multilingual', transientErrorMs: 5000 })
  const playback = useArchivedAudioPlayback()
  const health = useS2STHealth(Boolean(baseProvider))
  // 支持克隆的路由默认开启，不提供界面开关。
  const effectiveVoiceClone = Boolean(selectedProvider?.voiceClone)
  const vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs = vadLoudnessMode === 'p90_400ms'
    ? p90LoudnessThresholdDbfs
    : frameRMSLoudnessThresholdDbfs
  const selectedVoice = voiceOptions[provider]?.[0]?.id || voiceOptions[baseProvider]?.[0]?.id || ''
  const leftAllowedTargets = useMemo(() => new Set(showcaseTargetLanguages.filter(language => returnView || language !== leftSourceLanguage)), [baseProvider, returnView, leftSourceLanguage])
  const rightAllowedTargets = useMemo(() => new Set(showcaseTargetLanguages.filter(language => returnView || language !== rightSourceLanguage)), [baseProvider, returnView, rightSourceLanguage])
  const modelReady = Boolean(selectedProvider?.ready && health.available === true && leftTargetLanguages.length > 0 && rightTargetLanguages.length > 0)
  const mutedLeft = useMemo(() => new Set(
    muted ? leftTargetLanguages : leftTargetLanguages.filter((language) => language !== leftPrimaryLanguage),
  ), [leftPrimaryLanguage, leftTargetLanguages, muted])
  const mutedRight = useMemo(() => new Set(
    muted ? rightTargetLanguages : rightTargetLanguages.filter((language) => language !== rightPrimaryLanguage),
  ), [muted, rightPrimaryLanguage, rightTargetLanguages])

  useEffect(() => {
    if (!config || providers.length > 0) return
    if (routesForService(routes, 'websocket').length > 0) setService('websocket')
    else if (routesForService(routes, 'volc-rtc').length > 0) setService('volc-rtc')
  }, [config, providers.length, routes])

  useEffect(() => {
    if (service === 'volc-rtc' && microphoneMode === 'stereo') setMicrophoneMode('separate')
  }, [microphoneMode, service])

  useEffect(() => {
    if (!audioDevices.permissionGranted || audioDevices.inputDevices.length < 2) return
    const preferred = preferredDJIInputDevice(audioDevices.inputDevices)
    const ordered = preferred
      ? [preferred, ...audioDevices.inputDevices.filter((device) => device.deviceId !== preferred.deviceId)]
      : audioDevices.inputDevices
    if (leftDeviceId === 'default') setLeftDeviceId(ordered[0].deviceId)
    if (rightDeviceId === 'default') setRightDeviceId(ordered[1].deviceId)
  }, [audioDevices.inputDevices, audioDevices.permissionGranted, leftDeviceId, rightDeviceId])

  useEffect(() => {
    if (!audioDevices.permissionGranted || audioDevices.inputDevices.length < 1) return
    if (stereoDeviceId === 'default') {
      setStereoDeviceId((preferredDJIInputDevice(audioDevices.inputDevices) || audioDevices.inputDevices[0]).deviceId)
    }
  }, [audioDevices.inputDevices, audioDevices.permissionGranted, stereoDeviceId])

  useEffect(() => {
    if (!audioDevices.outputSelectionSupported || audioDevices.outputDevices.length < 2) return
    if (leftOutputDeviceId === 'default') setLeftOutputDeviceId(audioDevices.outputDevices[0].deviceId)
    if (rightOutputDeviceId === 'default') setRightOutputDeviceId(audioDevices.outputDevices[1].deviceId)
  }, [audioDevices.outputDevices, audioDevices.outputSelectionSupported, leftOutputDeviceId, rightOutputDeviceId])

  useEffect(() => {
    setLeftTargetLanguages((current) => {
      const retained = current.filter((language) => leftAllowedTargets.has(language))
      return retained.length > 0 ? retained : [...leftAllowedTargets].slice(0, 2)
    })
  }, [leftAllowedTargets])

  useEffect(() => {
    setRightTargetLanguages((current) => {
      const retained = current.filter((language) => rightAllowedTargets.has(language))
      return retained.length > 0 ? retained : [...rightAllowedTargets].slice(0, 2)
    })
  }, [rightAllowedTargets])

  useEffect(() => {
    if (!leftTargetLanguages.includes(leftPrimaryLanguage)) setLeftPrimaryLanguage(leftTargetLanguages[0] || '')
  }, [leftPrimaryLanguage, leftTargetLanguages])

  useEffect(() => {
    if (!rightTargetLanguages.includes(rightPrimaryLanguage)) setRightPrimaryLanguage(rightTargetLanguages[0] || '')
  }, [rightPrimaryLanguage, rightTargetLanguages])

  useEffect(() => {
    if (!config || !provider || !menuSettingsTouchedRef.current) return
    writeShowcaseMenuSettings({
      service,
      provider,
      webRTCEchoCancellation,
      deepFilterNet,
      vadLoudnessMode,
      frameRMSLoudnessThresholdDbfs,
      p90LoudnessThresholdDbfs,
      highlightReadingTextOnly,
      duoMicrophoneMode: microphoneMode,
      leftDeviceId,
      rightDeviceId,
      stereoDeviceId,
      swapStereoChannels,
      leftOutputDeviceId,
      rightOutputDeviceId,
      duoOutputMode: outputMode,
      stereoOutputDeviceId,
      hotwordMode,
      asrContext,
      qwen3SimulSystemPrompt,
    })
  }, [config, deepFilterNet, frameRMSLoudnessThresholdDbfs, leftDeviceId, leftOutputDeviceId, microphoneMode, p90LoudnessThresholdDbfs, provider, rightDeviceId, rightOutputDeviceId, service, stereoDeviceId, swapStereoChannels, vadLoudnessMode, webRTCEchoCancellation, outputMode, stereoOutputDeviceId, asrContext, qwen3SimulSystemPrompt, hotwordMode, highlightReadingTextOnly])

  const recordSession = (entry: HistoryEntry, audio: HistoryAudioArchive) => {
    const durationMs = typeof entry.sessionDurationMs === 'number'
      ? entry.sessionDurationMs
      : startedAtRef.current > 0 ? Math.max(0, Date.now() - startedAtRef.current) : null
    if (durationMs !== null) setFinishedDurationMs((previous) => Math.max(previous || 0, durationMs))
    playback.capture(entry, audio)
    historySync.recordSession(entry, audio)
  }
  const stereoRecorders = useMemo(() => createSharedStereoRecorderFactories(
    stereoDeviceId,
    effectiveSwapStereoChannels,
  ), [stereoDeviceId, effectiveSwapStereoChannels])
  const loggedIn = useConsumerLogin() && sessionMode === 'consumer'
  const [consumerQuota, setConsumerQuota] = useState<ConsumerQuota | null>(null)
  const sharedOptions = {
    endOnPageExit: true,
    privacyGate: canaryDesignEnabled() && sessionMode !== 'eval' ? canaryAIPrivacyGate : undefined,
    asrContext,
    asrContextOverride: true,
    qwen3SimulSystemPrompt: qwen3SimulSystemPrompt.trim() || defaultShowcaseSystemPrompt,
    // 甲、乙各自是独立的 consumer 计量会话（各有自己的 cs-* sessionId 与 ticket）。
    mode: sessionMode,
    sessionLayout: 'duo' as const,
    onQuota: setConsumerQuota,
    provider,
    baseProviderId: baseProvider,
    service,
    transport: service === 'websocket' ? 'websocket' as const : 'webrtc' as const,
    model: selectedProvider?.model || '—',
    effectiveVoiceClone,
    selectedVoice,
    deepFilterNet,
    qwen3ModelIntervalMs: 2000 as const,
    vadLoudnessMode,
    vadLoudnessThresholdDbfs,
    ready: modelReady,
    webRTCEchoCancellation,
    notReadyReason: loadFailed
      ? '无法读取服务配置，请稍后刷新。'
      : health.available === false
        ? health.reason || 'S2ST 服务暂时不可用。'
        : selectedProvider?.reason || '所选模型服务尚未就绪。',
    refreshAudioDevices: () => { void audioDevices.refresh().catch(() => undefined) },
    onSessionRecorded: recordSession,
  }
  const leftSession = useMultilingualRealtimeSession({
    ...sharedOptions,
    sourceLanguage: leftSourceLanguage,
    targetLanguages: leftTargetLanguages,
    priorityLanguage: leftPrimaryLanguage,
    inputDeviceId: microphoneMode === 'stereo' ? stereoDeviceId : leftDeviceId,
    recorderFactory: microphoneMode === 'stereo' ? stereoRecorders.left : undefined,
    outputDeviceId: effectiveLeftOutputDeviceId,
    outputChannel: leftOutputChannel,
    mutedLanguages: mutedLeft,
  })
  const rightSession = useMultilingualRealtimeSession({
    ...sharedOptions,
    sourceLanguage: rightSourceLanguage,
    targetLanguages: rightTargetLanguages,
    priorityLanguage: rightPrimaryLanguage,
    inputDeviceId: microphoneMode === 'stereo' ? stereoDeviceId : rightDeviceId,
    recorderFactory: microphoneMode === 'stereo' ? stereoRecorders.right : undefined,
    outputDeviceId: effectiveRightOutputDeviceId,
    outputChannel: rightOutputChannel,
    mutedLanguages: mutedRight,
  })
  const leftSemanticLayouts = useMultilingualSemanticLayouts(
    leftTargetLanguages,
    leftSession.outputs,
    terminalStatus(leftSession.status),
    true,
  )
  const rightSemanticLayouts = useMultilingualSemanticLayouts(
    rightTargetLanguages,
    rightSession.outputs,
    terminalStatus(rightSession.status),
    true,
  )
  const status = combineDuoStatus(leftSession.status, rightSession.status) as Status
  useConsumerQuotaRefresh(loggedIn, status, setConsumerQuota)
  const busy = busyStatus(status)
  // 结束前最后 10 秒的提醒（双人）：甲、乙是两条独立会话，取更早结束的那条。
  const sessionEnding = useSessionEndingCountdown(
    earliestSessionEndsAt(leftSession.sessionEndsAtMs, rightSession.sessionEndsAtMs),
    status === 'recording' || status === 'processing',
  )
  const noisePreset = service === 'websocket' && deepFilterNet && vadLoudnessMode === 'p90_400ms'
    ? 'demo-presentation' : showcaseNoisePreset(
    service,
    webRTCEchoCancellation,
    deepFilterNet,
    vadLoudnessMode,
    false,
    showcaseDuoNoisePresetSettings.demo.deepFilterNet,
  )
  // 双人模式：两条会话共用同一套设置，语言取并集（源语言不一致时记 'auto'，
  // 与历史记录 sourceLanguage 的口径一致），音色模式取先握手成功的一侧。
  const duoTargetLanguages = useMemo(
    () => [...new Set([...leftTargetLanguages, ...rightTargetLanguages])],
    [leftTargetLanguages, rightTargetLanguages],
  )
  const sessionSettings = useMemo(() => buildSessionSettings({
    platform: 'web',
    buildSha: config?.buildSha,
    mode: 'duo',
    sourceLanguage: leftSourceLanguage === rightSourceLanguage ? leftSourceLanguage : 'auto',
    targetLanguages: duoTargetLanguages,
    translationModel,
    ttsModel,
    provider,
    noisePreset,
    service,
    echoCancellation: webRTCEchoCancellation,
    deepFilterNet,
    vadLoudnessMode,
    vadLoudnessThresholdDbfs,
    voiceClone: effectiveVoiceClone,
    voiceMode: leftSession.voiceMode || rightSession.voiceMode,
    fontSize,
  }), [config?.buildSha, deepFilterNet, duoTargetLanguages, effectiveVoiceClone, fontSize, leftSession.voiceMode, leftSourceLanguage, noisePreset, provider, rightSession.voiceMode, rightSourceLanguage, service, translationModel, ttsModel, vadLoudnessMode, vadLoudnessThresholdDbfs, webRTCEchoCancellation])
  const microphoneError = microphoneMode === 'stereo'
    ? validateDuoStereoMicrophone(stereoDeviceId)
    : validateDuoMicrophones(leftDeviceId, rightDeviceId)
  const outputDeviceError = stereoOutput ? (
    stereoOutputDeviceId !== 'default' && !audioDevices.outputSelectionSupported
      ? '当前浏览器不支持指定输出设备，请选择默认设备。' : ''
  ) : validateDuoOutputDevices(
    leftOutputDeviceId,
    rightOutputDeviceId,
    audioDevices.outputSelectionSupported,
  )
  const allLanguageBubbles = useMemo(() => {
    const sideBubbles = (
      side: 'a' | 'b',
      sourceLanguage: string,
      targetLanguages: string[],
      primaryLanguage: string,
      semanticLayouts: ReturnType<typeof useMultilingualSemanticLayouts>,
      sourceText: string,
      sourceSegments: typeof leftSession.sourceSegments,
      outputs: typeof leftSession.outputs,
    ) => {
      const displayLanguageOrder = [
        primaryLanguage,
        ...targetLanguages.filter((language) => language !== primaryLanguage),
      ]
      const fallbackRows = buildMultilingualShowcaseRows(
        sourceText,
        sourceSegments,
        displayLanguageOrder,
        outputs,
      )
      return buildPrimaryDrivenMultilingualRows(
        targetLanguages,
        primaryLanguage,
        semanticLayouts,
        fallbackRows,
        outputs,
      ).map((row) => ({ ...row, side, sourceLanguage, targetLanguages, layoutLanguage: primaryLanguage }))
    }
    return [
      ...leftTargetLanguages.flatMap(language => sideBubbles('a', leftSourceLanguage, leftTargetLanguages, language, leftSemanticLayouts, leftSession.sourceText, leftSession.sourceSegments, leftSession.outputs)),
      ...rightTargetLanguages.flatMap(language => sideBubbles('b', rightSourceLanguage, rightTargetLanguages, language, rightSemanticLayouts, rightSession.sourceText, rightSession.sourceSegments, rightSession.outputs)),
    ]
  }, [
    leftSemanticLayouts,
    leftTargetLanguages,
    leftSourceLanguage,
    leftSession.outputs,
    leftSession.sourceSegments,
    leftSession.sourceText,
    rightSemanticLayouts,
    rightTargetLanguages,
    rightSourceLanguage,
    rightSession.outputs,
    rightSession.sourceSegments,
    rightSession.sourceText,
  ])
  const bubbles = useMemo(() => selectDuoLanguageLayouts(allLanguageBubbles, leftPrimaryLanguage, rightPrimaryLanguage), [allLanguageBubbles, leftPrimaryLanguage, rightPrimaryLanguage])
  const historyBubbles = useMemo(() => allLanguageBubbles.map(bubble => {
    const language = bubble.layoutLanguage!
    return {
      ...bubble,
      translations: { [language]: bubble.translations[language] || '' },
      outputAudioStarts: bubble.outputAudioStarts[language] === undefined ? {} : { [language]: bubble.outputAudioStarts[language] },
      outputAudioEnds: bubble.outputAudioEnds[language] === undefined ? {} : { [language]: bubble.outputAudioEnds[language] },
      primaryLanguage: bubble.side === 'a' ? leftTargetLanguages[0] : rightTargetLanguages[0],
    }
  }), [allLanguageBubbles, leftTargetLanguages, rightTargetLanguages])
  const checkpointSessionIDs = [leftSession.parentSessionID, rightSession.parentSessionID].filter(Boolean)
  const checkpointInput = useMemo(() => (
    sessionMode === 'consumer' && checkpointSessionIDs.length === 2 && bubbles.length > 0
      ? buildConsumerHistoryInput({
          sessionId: checkpointSessionIDs.join(':'),
          provider,
          sourceLanguage: leftSourceLanguage === rightSourceLanguage ? leftSourceLanguage : 'auto',
          targetLanguages: [...new Set([...leftTargetLanguages, ...rightTargetLanguages])],
          durationMs: startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0,
          devices: {
            inputs: microphoneMode === 'stereo'
              ? [{ side: 'shared', label: selectedAudioDeviceLabel(audioDevices.inputDevices, stereoDeviceId, audioDevices.defaultInputDeviceLabel, '系统默认麦克风（具体设备由系统决定）') }]
              : [
                  { side: 'a', label: selectedAudioDeviceLabel(audioDevices.inputDevices, leftDeviceId, audioDevices.defaultInputDeviceLabel, '甲的输入设备（名称不可用）') },
                  { side: 'b', label: selectedAudioDeviceLabel(audioDevices.inputDevices, rightDeviceId, audioDevices.defaultInputDeviceLabel, '乙的输入设备（名称不可用）') },
                ],
            outputs: [
              { side: 'a', label: leftOutputLabel },
              { side: 'b', label: rightOutputLabel },
            ],
          },
          rows: historyBubbles,
          settings: sessionSettings,
          traceId: leftSession.traceId,
        })
      : null
  ), [audioDevices.defaultInputDeviceLabel, audioDevices.defaultOutputDeviceLabel, audioDevices.inputDevices, audioDevices.outputDevices, bubbles, historyBubbles, checkpointSessionIDs.join(':'), leftDeviceId, leftOutputDeviceId, leftPrimaryLanguage, leftSession.traceId, leftSourceLanguage, leftTargetLanguages, microphoneMode, provider, rightDeviceId, rightOutputDeviceId, rightPrimaryLanguage, rightSourceLanguage, rightTargetLanguages, sessionMode, sessionSettings, stereoDeviceId, leftOutputLabel, rightOutputLabel])
  useConsumerHistoryCheckpoint(checkpointInput, busyStatus(status))
  useEffect(() => {
    if (loggedIn) void retryConsumerHistoryCheckpoints()
  }, [loggedIn])
  const visibleBubbles = bubbles.length > 0 ? bubbles : selectDuoLanguageLayouts(returnView?.bubbles || [], leftPrimaryLanguage, rightPrimaryLanguage)
  useProductSessionAnalytics(analyticsAttemptRef, [leftSession, rightSession], visibleBubbles.some(row => Object.values(row.translations).some(text => text.trim())))
  const visibleLeftSessionId = leftSession.parentSessionID || returnView?.leftSessionId || ''
  const visibleRightSessionId = rightSession.parentSessionID || returnView?.rightSessionId || ''
  const captureArchivedAudio = playback.capture
  useEffect(() => {
    const sessionIds = [returnView?.leftSessionId, returnView?.rightSessionId].filter((id): id is string => Boolean(id))
    if (sessionIds.length === 0) return undefined
    let active = true
    void Promise.all(sessionIds.map(async (sessionId) => ({ sessionId, archive: await loadHistoryAudio(sessionId) }))).then((archives) => {
      if (!active) return
      archives.forEach(({ sessionId, archive }) => captureArchivedAudio({ id: sessionId }, archive))
    }).catch(() => undefined)
    return () => { active = false }
  }, [captureArchivedAudio, returnView?.leftSessionId, returnView?.rightSessionId])
  useEffect(() => {
    if (leftSession.completionReason !== 'session_time_limit' && rightSession.completionReason !== 'session_time_limit') return
    setCompletionRequested(true)
    // Either microphone reaching the limit ends the whole dual-mic session.
    void leftSession.stop('session_time_limit')
    void rightSession.stop('session_time_limit')
  }, [leftSession.completionReason, rightSession.completionReason])
  useEffect(() => {
    if (!completionRequested) return
    if (status === 'idle') {
      setCompletionRequested(false)
      return
    }
    if (!terminalStatus(status)) return
    setCompletionRequested(false)
    if (sessionMode !== 'consumer' || bubbles.length === 0 || snapshotSavingRef.current) return
    snapshotSavingRef.current = true
    setHistorySaving(true)
    const targetLanguages = [...new Set([...leftTargetLanguages, ...rightTargetLanguages])]
    const localSessionIds = [leftSession.parentSessionID, rightSession.parentSessionID].filter(Boolean)
    const sessionFailed = [...Object.values(leftSession.outputs), ...Object.values(rightSession.outputs)].some(output => Boolean(output.error))
    const input = { ...buildConsumerHistoryInput({
      sessionId: localSessionIds.join(':'),
      provider,
      sourceLanguage: leftSourceLanguage === rightSourceLanguage ? leftSourceLanguage : 'auto',
      targetLanguages,
      durationMs: startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0,
      devices: {
        inputs: microphoneMode === 'stereo'
          ? [{
              side: 'shared',
              label: selectedAudioDeviceLabel(
                audioDevices.inputDevices,
                stereoDeviceId,
                audioDevices.defaultInputDeviceLabel,
                '系统默认麦克风（具体设备由系统决定）',
              ),
            }]
          : [
              {
                side: 'a',
                label: selectedAudioDeviceLabel(audioDevices.inputDevices, leftDeviceId, audioDevices.defaultInputDeviceLabel, '甲的输入设备（名称不可用）'),
              },
              {
                side: 'b',
                label: selectedAudioDeviceLabel(audioDevices.inputDevices, rightDeviceId, audioDevices.defaultInputDeviceLabel, '乙的输入设备（名称不可用）'),
              },
            ],
        outputs: [
          {
            side: 'a',
            label: leftOutputLabel,
          },
          {
            side: 'b',
            label: rightOutputLabel,
          },
        ],
      },
      rows: historyBubbles,
      settings: sessionSettings,
      traceId: leftSession.traceId,
    }), abnormalExit: sessionFailed, completionReason: sessionFailed ? 'client_error' : leftSession.completionReason || rightSession.completionReason || 'client_stopped' }
    void saveConsumerHistory(input).then((saved) => {
      snapshotSavingRef.current = false
      setHistorySaving(false)
      setSavedHistoryId(saved.id)
      clearConsumerHistoryCheckpoint(localSessionIds.join(':'))
      void Promise.all(localSessionIds.map(historySync.waitForAudioSave)).catch(() => undefined)
    }).catch((caught) => {
      snapshotSavingRef.current = false
      setHistorySaving(false)
      setSnapshotError(caught instanceof Error ? caught.message : '无法保存同传历史记录。')
    })
  }, [audioDevices.defaultInputDeviceLabel, audioDevices.defaultOutputDeviceLabel, audioDevices.inputDevices, audioDevices.outputDevices, bubbles, historyBubbles, completionRequested, leftSession.outputs, rightSession.outputs, leftDeviceId, leftOutputDeviceId, leftPrimaryLanguage, leftSession.parentSessionID, leftSession.traceId, leftSourceLanguage, leftTargetLanguages, microphoneMode, provider, rightDeviceId, rightOutputDeviceId, rightPrimaryLanguage, rightSession.parentSessionID, rightSourceLanguage, rightTargetLanguages, sessionMode, sessionSettings, status, stereoDeviceId, leftOutputLabel, rightOutputLabel])
  const terminal = completionRequested || terminalStatus(status) || Boolean(returnView && status === 'idle')
  useModelInputArchive([visibleLeftSessionId, visibleRightSessionId], terminal && sessionMode === 'consumer', playback.capture)
  const finishedView = terminal && sessionMode === 'consumer'
  const historyTitle = useHistoryTitle(savedHistoryId, undefined, finishedView)
  const follow = useTranscriptFollow(visibleBubbles.map((bubble) => [bubble.source, bubble.translations]), !terminal)
  // Figma 938:6312：录音中甲、乙各占一个面板、各自滚动，乙面板用独立的跟随器。
  const followB = useTranscriptFollow(visibleBubbles.filter((bubble) => bubble.side === 'b').map((bubble) => [bubble.source, bubble.translations]), !terminal)
  const visibleLeftBubbles = useMemo(
    () => visibleBubbles.filter((bubble) => bubble.side === 'a'),
    [visibleBubbles],
  )
  const visibleRightBubbles = useMemo(
    () => visibleBubbles.filter((bubble) => bubble.side === 'b'),
    [visibleBubbles],
  )
  const displayedLeftBubbles = useSegmentedShowcaseTypewriter(
    visibleLeftBubbles,
    leftPrimaryLanguage,
    leftSession.status === 'recording' && !completionRequested,
    follow.onTextProgress,
  )
  const displayedRightBubbles = useSegmentedShowcaseTypewriter(
    visibleRightBubbles,
    rightPrimaryLanguage,
    rightSession.status === 'recording' && !completionRequested,
    follow.onTextProgress,
  )
  const punctuatedLeftBubbles = useMemo(() => moveLeadingTranslationPunctuation(displayedLeftBubbles), [displayedLeftBubbles])
  const punctuatedRightBubbles = useMemo(() => moveLeadingTranslationPunctuation(displayedRightBubbles), [displayedRightBubbles])
  const displayedBubbles = useMemo(() => mergeDuoSpeakerRows(punctuatedLeftBubbles, punctuatedRightBubbles), [
    punctuatedLeftBubbles,
    punctuatedRightBubbles,
  ])
  // 甲、乙各自是独立会话，逐句反馈按各自的 parentSessionID 归档。
  const leftFeedback = useSentenceFeedback(visibleLeftSessionId)
  const rightFeedback = useSentenceFeedback(visibleRightSessionId)
  const displayStatus = completionRequested || (returnView && status === 'idle') ? 'finished' : status
  const featuredBubbleIds = {
    a: featuredShowcaseRowId(displayedLeftBubbles),
    b: featuredShowcaseRowId(displayedRightBubbles),
  }
  const inputOptions = useMemo<ShowcaseComboboxOption[]>(() => [
    { value: 'default', label: '请选择明确的麦克风', disabled: true },
    ...audioDevices.inputDevices.map((device) => ({ value: device.deviceId, label: device.label })),
  ], [audioDevices.inputDevices])
  const outputOptions = useMemo<ShowcaseComboboxOption[]>(() => [
    { value: 'default', label: '请选择明确的输出设备', disabled: true },
    ...audioDevices.outputDevices.map((device) => ({ value: device.deviceId, label: device.label })),
  ], [audioDevices.outputDevices])
  // 使用本地模型名称；可用性仍由 /api/config 的路由就绪状态决定。
  const ttsOptions = showcaseTTSOptions(providers, translationModel)
  const recording = status === 'recording'
  const paused = leftSession.paused || rightSession.paused
  const deviceSwitching = leftSession.inputDeviceSwitching || rightSession.inputDeviceSwitching
    || leftSession.outputDeviceSwitching || rightSession.outputDeviceSwitching

  useEffect(() => {
    if (busy || !audioDevices.initialized || !audioDevices.permissionGranted) return
    const inputExists = (deviceId: string) => deviceId === 'default'
      || audioDevices.inputDevices.some((device) => device.deviceId === deviceId)
    const outputExists = (deviceId: string) => deviceId === 'default'
      || audioDevices.outputDevices.some((device) => device.deviceId === deviceId)
    let changed = false
    if (!inputExists(leftDeviceId)) { setLeftDeviceId('default'); changed = true }
    if (!inputExists(rightDeviceId)) { setRightDeviceId('default'); changed = true }
    if (!inputExists(stereoDeviceId)) { setStereoDeviceId('default'); changed = true }
    if (!outputExists(leftOutputDeviceId)) { setLeftOutputDeviceId('default'); changed = true }
    if (!outputExists(rightOutputDeviceId)) { setRightOutputDeviceId('default'); changed = true }
    if (!outputExists(stereoOutputDeviceId)) { setStereoOutputDeviceId('default'); changed = true }
    if (changed && !preferredDJIInputDevice(audioDevices.inputDevices)) menuSettingsTouchedRef.current = true
  }, [audioDevices.initialized, audioDevices.inputDevices, audioDevices.outputDevices, audioDevices.permissionGranted, busy, leftDeviceId, leftOutputDeviceId, rightDeviceId, rightOutputDeviceId, stereoDeviceId, stereoOutputDeviceId])
  const leftInputOptions = inputOptions.map((option) => ({
    ...option,
    disabled: option.disabled || option.value === rightDeviceId,
  }))
  const rightInputOptions = inputOptions.map((option) => ({
    ...option,
    disabled: option.disabled || option.value === leftDeviceId,
  }))
  const leftOutputOptions = outputOptions.map((option) => ({
    ...option,
    disabled: option.disabled || option.value === rightOutputDeviceId,
  }))
  const rightOutputOptions = outputOptions.map((option) => ({
    ...option,
    disabled: option.disabled || option.value === leftOutputDeviceId,
  }))

  const chooseProvider = (model: ShowcaseTranslationModel, tts: ShowcaseTTSModel) => {
    const next = providerForShowcaseSelection(providers, model, tts)
    if (next) {
      menuSettingsTouchedRef.current = true
      setChosenProvider(next.id)
    }
  }
  const chooseService = (nextService: ShowcaseService) => {
    const nextProviders = routesForService(routes, nextService)
    const next = providerForShowcaseSelection(nextProviders, translationModel, ttsModel)
      || preferredShowcaseProvider(nextProviders)
    menuSettingsTouchedRef.current = true
    setService(nextService)
    if (next) setChosenProvider(next.id)
  }
  const [settingsInfoTopic, setSettingsInfoTopic] = useState<ShowcaseSettingsInfoTopic | null>(null)
  const [deviceGuideSignal, setDeviceGuideSignal] = useState(0)
  const closeSettingsInfo = useCallback(() => setSettingsInfoTopic(null), [])
  const applyNoisePreset = (value: Exclude<ShowcaseNoisePreset, 'custom'>) => {
    // 双人模式是双声道专用设备采集，不提供手机通话模式。
    if (value === 'phone-call') return
    const preset = showcaseDuoNoisePresetSettings[value]
    chooseService(preset.service)
    setWebRTCEchoCancellation(preset.echoCancellation)
    setDeepFilterNet(preset.deepFilterNet)
    setVADLoudnessMode(preset.mode)
    if (preset.mode === 'p90_400ms') setP90LoudnessThresholdDbfs(preset.threshold)
    else setFrameRMSLoudnessThresholdDbfs(preset.threshold)
  }
  const chooseNoisePreset = (value: string) => {
    if (value === 'custom') return
    if (value === 'echo-cancellation') {
      setEchoCancellationSetupOpen(true)
      return
    }
    applyNoisePreset(value as Exclude<ShowcaseNoisePreset, 'custom'>)
  }

  useEffect(() => {
    if (initialDeviceSelectionDoneRef.current || !config || audioDevices.loading || !audioDevices.initialized || !audioDevices.permissionGranted) return
    initialDeviceSelectionDoneRef.current = true
    if (busy || menuSettingsTouchedRef.current) return
    const preferred = preferredDJIInputDevice(audioDevices.inputDevices)
    if (!preferred) return
    const demoOutputs = audioDevices.outputSelectionSupported ? showcaseDemoOutputs(audioDevices.outputDevices) : undefined
    const preset = demoOutputs ? showcaseDuoNoisePresetSettings['demo-presentation'] : showcaseDuoNoisePresetSettings.demo
    setStereoDeviceId(preferred.deviceId)
    setMicrophoneMode('stereo')
    setSwapStereoChannels(false)
    setOutputMode(demoOutputs ? 'separate' : 'stereo')
    if (demoOutputs) {
      setLeftOutputDeviceId(demoOutputs.external.deviceId)
      setRightOutputDeviceId(demoOutputs.inzone.deviceId)
    } else {
      setStereoOutputDeviceId(current => audioDevices.outputDevices.some(device => device.deviceId === current) ? current : 'default')
    }
    setService(preset.service)
    setWebRTCEchoCancellation(preset.echoCancellation)
    setDeepFilterNet(preset.deepFilterNet)
    setVADLoudnessMode(preset.mode)
    setP90LoudnessThresholdDbfs(preset.threshold)
  }, [audioDevices.initialized, audioDevices.permissionGranted, audioDevices.loading, audioDevices.inputDevices, audioDevices.outputDevices, audioDevices.outputSelectionSupported, busy, config])

  const toggleTarget = (side: 'a' | 'b', language: string) => {
    const allowedTargets = side === 'a' ? leftAllowedTargets : rightAllowedTargets
    if (language === (side === 'a' ? leftSourceLanguage : rightSourceLanguage)) return
    if (busy || !allowedTargets.has(language)) return
    const update = (current: string[]) => {
      if (current.includes(language)) return current.length > 1 ? current.filter((item) => item !== language) : current
      return [...current, language]
    }
    if (side === 'a') setLeftTargetLanguages(update)
    else setRightTargetLanguages(update)
  }

  const changeLeftInputDevice = async (nextDeviceId: string) => {
    menuSettingsTouchedRef.current = true
    if (leftSession.paused) {
      setLeftDeviceId(nextDeviceId)
      return
    }
    if (!recording) {
      if (!busy) setLeftDeviceId(nextDeviceId)
      return
    }
    if (microphoneMode === 'separate' && await leftSession.changeInputDevice(nextDeviceId)) setLeftDeviceId(nextDeviceId)
  }

  const changeRightInputDevice = async (nextDeviceId: string) => {
    menuSettingsTouchedRef.current = true
    if (rightSession.paused) {
      setRightDeviceId(nextDeviceId)
      return
    }
    if (!recording) {
      if (!busy) setRightDeviceId(nextDeviceId)
      return
    }
    if (microphoneMode === 'separate' && await rightSession.changeInputDevice(nextDeviceId)) setRightDeviceId(nextDeviceId)
  }

  const changeStereoInputDevice = async (nextDeviceId: string) => {
    menuSettingsTouchedRef.current = true
    if (nextDeviceId === stereoDeviceId) return
    if (paused) {
      setStereoDeviceId(nextDeviceId)
      return
    }
    if (!recording) {
      if (!busy) setStereoDeviceId(nextDeviceId)
      return
    }
    if (leftSession.status !== 'recording' || rightSession.status !== 'recording') return
    const nextRecorders = createSharedStereoRecorderFactories(nextDeviceId, effectiveSwapStereoChannels)
    const [leftChanged, rightChanged] = await Promise.all([
      leftSession.changeInputDevice(nextDeviceId, nextRecorders.left),
      rightSession.changeInputDevice(nextDeviceId, nextRecorders.right),
    ])
    if (leftChanged && rightChanged) setStereoDeviceId(nextDeviceId)
  }

  const changeLeftOutputDevice = async (nextDeviceId: string) => {
    menuSettingsTouchedRef.current = true
    if (!recording) {
      if (!busy) setLeftOutputDeviceId(nextDeviceId)
      return
    }
    if (await leftSession.changeOutputDevice(nextDeviceId)) setLeftOutputDeviceId(nextDeviceId)
  }

  const changeRightOutputDevice = async (nextDeviceId: string) => {
    menuSettingsTouchedRef.current = true
    if (!recording) {
      if (!busy) setRightOutputDeviceId(nextDeviceId)
      return
    }
    if (await rightSession.changeOutputDevice(nextDeviceId)) setRightOutputDeviceId(nextDeviceId)
  }

  const microphoneSettings = microphoneMode === 'separate' ? (
    <>
      <PanelRow label="甲输入设备"><DeviceCombobox ariaLabel="甲的输入设备" options={leftInputOptions} value={leftDeviceId} disabled={deviceSwitching} onChange={(value) => { void changeLeftInputDevice(value) }} /></PanelRow>
      <PanelRow label="乙输入设备"><DeviceCombobox ariaLabel="乙的输入设备" options={rightInputOptions} value={rightDeviceId} disabled={deviceSwitching} onChange={(value) => { void changeRightInputDevice(value) }} /></PanelRow>
    </>
  ) : (
    <PanelRow label="双声道接收器"><DeviceCombobox ariaLabel="双声道接收器" options={inputOptions} value={stereoDeviceId} disabled={deviceSwitching} onChange={(value) => { void changeStereoInputDevice(value) }} /></PanelRow>
  )

  const outputSettings = stereoOutput ? (
    <>
      <PanelRow label="双声道输出设备"><DeviceCombobox ariaLabel="双声道输出设备" options={[
        { value: 'default', label: selectedAudioDeviceLabel(audioDevices.outputDevices, 'default', audioDevices.defaultOutputDeviceLabel, '默认设备') },
        ...audioDevices.outputDevices.map((device) => ({ value: device.deviceId, label: device.label })),
      ]} value={stereoOutputDeviceId} disabled={busy || !audioDevices.outputSelectionSupported} onChange={(value) => {
        menuSettingsTouchedRef.current = true
        setStereoOutputDeviceId(value)
      }} /></PanelRow>
      <div className="realtime-showcase-setting-row"><span><strong>交叉收听（固定）</strong><small>甲耳机=L/左，听乙译音 · 乙耳机=R/右，听甲译音</small></span></div>
      <p className="realtime-showcase-settings-note">L 接甲的输入设备和耳机，R 接乙的输入设备和耳机；译音自动交叉。甲的输出语言选乙听懂的语言，乙的输出语言选甲听懂的语言。请关闭系统“单声道音频”；此分配仅用于实时译音，历史回放保持原方式。</p>
    </>
  ) : (
    <>
      <PanelRow label="甲输出设备"><DeviceCombobox ariaLabel="甲的输出设备" options={leftOutputOptions} value={leftOutputDeviceId} disabled={deviceSwitching || !audioDevices.outputSelectionSupported} onChange={(value) => { void changeLeftOutputDevice(value) }} /></PanelRow>
      <PanelRow label="乙输出设备"><DeviceCombobox ariaLabel="乙的输出设备" options={rightOutputOptions} value={rightOutputDeviceId} disabled={deviceSwitching || !audioDevices.outputSelectionSupported} onChange={(value) => { void changeRightOutputDevice(value) }} /></PanelRow>
    </>
  )

  const settings = (
    <>
      {/* 常用设置与单人模式保持相同顺序。 */}
      <ShowcaseSettingsInfoDialog topic={settingsInfoTopic} onClose={closeSettingsInfo} duo />
      <div className="realtime-showcase-settings-title"><strong>{busy ? SETTINGS_PANEL_COPY.busy.title : SETTINGS_PANEL_COPY.duo.title}</strong><span>{recording ? SETTINGS_PANEL_COPY.busy.subtitle : SETTINGS_PANEL_COPY.duo.subtitle}</span></div>
      <div className="showcase-panel-fields">
        {!busy && <PanelRow label={<>翻译模型<ShowcaseSettingsInfoButton topic="translation" onOpen={setSettingsInfoTopic} /></>}><PanelStaticValue value="Luna-LT-Flash v2" placeholder="Luna-LT-Flash v2" /></PanelRow>}
        {!busy && <PanelRow label="输入方式"><DeviceCombobox ariaLabel="麦克风输入方式" options={service === 'volc-rtc' ? [{ value: 'separate', label: '两支独立麦克风' }] : [{ value: 'separate', label: '两支独立麦克风' }, { value: 'stereo', label: '一台双声道接收器' }]} value={microphoneMode} disabled={false} onChange={(value) => {
          menuSettingsTouchedRef.current = true
          setMicrophoneMode(value as DuoMicrophoneMode)
        }} /></PanelRow>}
        {(!busy || recording) && microphoneSettings}
        {!busy && <PanelRow label="输出方式"><DeviceCombobox ariaLabel="音频输出方式" options={[
          { value: 'separate', label: '两台独立播放设备' },
          { value: 'stereo', label: '一台设备，左右声道分开', disabled: service !== 'websocket' },
        ]} value={stereoOutput ? 'stereo' : 'separate'} disabled={false} onChange={(value) => {
          menuSettingsTouchedRef.current = true
          setOutputMode(value as DuoOutputMode)
        }} /></PanelRow>}
        {!busy && service !== 'websocket' && <p className="realtime-showcase-settings-note">左右声道输出暂仅支持 WebSocket 服务线路。</p>}
        {(!busy || (recording && (stereoOutput || audioDevices.outputSelectionSupported))) && outputSettings}
        {!busy && <>
            <PanelRow label={<>设备模式<ShowcaseSettingsInfoButton topic="noise" onOpen={setSettingsInfoTopic} /></>}><DeviceCombobox ariaLabel="选择设备模式" options={noisePresetOptions(noisePreset, false, true)} value={noisePreset} disabled={false} onChange={chooseNoisePreset} /></PanelRow>
            <PanelRow label="降噪模式"><DeviceCombobox ariaLabel="选择降噪模式" options={noiseReductionOptions(vadLoudnessMode)} value={String(vadLoudnessThresholdDbfs)} fallbackLabel="自定义" disabled={false} onChange={(value) => {
              menuSettingsTouchedRef.current = true
              if (vadLoudnessMode === 'p90_400ms') setP90LoudnessThresholdDbfs(Number(value) as P90LoudnessThresholdDbfs)
              else setFrameRMSLoudnessThresholdDbfs(Number(value) as FrameRMSLoudnessThresholdDbfs)
            }} /></PanelRow>
            <PanelRow label={<>使用场景<ShowcaseSettingsInfoButton topic="tts" onOpen={setSettingsInfoTopic} /></>}><DeviceCombobox ariaLabel="选择使用场景" options={ttsOptions} value={ttsModel} disabled={false} onChange={(value) => chooseProvider(translationModel, value as ShowcaseTTSModel)} /></PanelRow>
        </>}
      </div>
      {!busy && <>
        <details hidden className="realtime-showcase-advanced-audio showcase-panel-advanced">
          <summary>高级设置</summary>
          <div className="realtime-showcase-advanced-audio__content">
            <ShowcaseLanguageSettings value={hotwords} onChange={(value) => {
              menuSettingsTouchedRef.current = true
              setHotwords(value)
            }} />
            <PanelToggleRow title="DeepFilterNet3 降噪" description="所有语言共享降噪后的输入" ariaLabel="DeepFilterNet3 降噪" checked={deepFilterNet} disabled={false} onToggle={() => {
              menuSettingsTouchedRef.current = true
              setDeepFilterNet(!deepFilterNet)
            }} />
            {microphoneMode === 'stereo' && <div className="realtime-showcase-setting-row"><span><strong>甲乙输入声道</strong><small>{effectiveSwapStereoChannels ? '甲=右/TX2 · 乙=左/TX1' : '甲=左/TX1 · 乙=右/TX2'}</small></span>{!stereoOutput && <button type="button" className="showcase-stereo-swap" onClick={() => {
              menuSettingsTouchedRef.current = true
              setSwapStereoChannels((value) => !value)
            }}>左右互换</button>}</div>}
            <PanelToggleRow title="高亮仅显示阅读文本" description="关闭后高亮正在播放的整段译文" ariaLabel="高亮仅显示阅读文本" checked={highlightReadingTextOnly} disabled={false} onToggle={() => {
              menuSettingsTouchedRef.current = true
              setHighlightReadingTextOnly(!highlightReadingTextOnly)
            }} />
            <ShowcaseAudioProcessingSettings
              plain
              hideDeepFilterNet
              service={service}
              webRTCEchoCancellation={webRTCEchoCancellation}
              deepFilterNet={deepFilterNet}
              vadLoudnessMode={vadLoudnessMode}
              vadLoudnessThresholdDbfs={vadLoudnessThresholdDbfs}
              disabled={false}
              onServiceChange={chooseService}
              onWebRTCEchoCancellationChange={(enabled) => {
                menuSettingsTouchedRef.current = true
                setWebRTCEchoCancellation(enabled)
              }}
              onDeepFilterNetChange={(enabled) => {
                menuSettingsTouchedRef.current = true
                setDeepFilterNet(enabled)
              }}
              onVADLoudnessModeChange={(nextMode) => {
                menuSettingsTouchedRef.current = true
                setVADLoudnessMode(nextMode)
              }}
              onVADLoudnessThresholdChange={(threshold) => {
                menuSettingsTouchedRef.current = true
                if (vadLoudnessMode === 'p90_400ms') setP90LoudnessThresholdDbfs(threshold as P90LoudnessThresholdDbfs)
                else setFrameRMSLoudnessThresholdDbfs(threshold as FrameRMSLoudnessThresholdDbfs)
              }}
            />
            <p className="realtime-showcase-settings-note">甲、乙输入语言分别在顶栏设置；双声道模式将左/TX1、右/TX2 分别作为两位角色。</p>
          </div>
        </details>
      </>}
      {busy && !recording && <p className="realtime-showcase-settings-note">会话正在连接或结束处理中，暂时没有可调整的选项。</p>}
      <ConsumerAccountSettings
        loggedIn={loggedIn}
        quota={consumerQuota}
        historyVisible={!busyStatus(status)}
        onBeforeHistory={() => (terminal && visibleBubbles.length > 0 ? writeShowcaseReturnView({
          mode: 'duo',
          leftSessionId: visibleLeftSessionId,
          rightSessionId: visibleRightSessionId,
          provider,
          leftSourceLanguage,
          rightSourceLanguage,
          leftTargetLanguages,
          rightTargetLanguages,
          leftPrimaryLanguage,
          rightPrimaryLanguage,
          bubbles: allLanguageBubbles.length > 0 ? allLanguageBubbles : returnView?.bubbles || [],
          historyId: savedHistoryId,
        }) : clearShowcaseReturnView())}
      />
    </>
  )

  const startBoth = async () => {
    const leftPageLease = leftSession.capturePageLease(), rightPageLease = rightSession.capturePageLease()
    if (!leftPageLease() || !rightPageLease()) return
    const guarded = canaryDesignEnabled() && sessionMode !== 'eval'
    const consentLease = guarded ? canaryAIPrivacyGate.captureAuthorization() : () => true
    if (guarded && !await canaryAIPrivacyGate.ensureAuthorized()) return
    if (!consentLease() || !leftPageLease() || !rightPageLease()) return
    const fields = beginProductAttempt({ mode: 'duo', sourceLanguage: leftSourceLanguage, targetLanguage: leftPrimaryLanguage, targetCount: duoTargetLanguages.length, audioEnabled: true })
    analyticsAttemptRef.current = { fields, startedAt: performance.now() }
    if (!audioDevices.permissionGranted) {
      const granted = await audioDevices.requestPermissionAndRefresh()
      if (!consentLease() || !leftPageLease() || !rightPageLease()) return
      trackProduct('microphone_result', { ...fields, result: granted ? 'success' : 'failure', reason: granted ? 'granted' : 'denied_or_unavailable' })
      // 双人模式需为甲、乙分别指定设备：读取后直接打开设置面板并展开麦克风列表。
      setDeviceGuideSignal((value) => value + 1)
      return
    }
    if (microphoneError || outputDeviceError || !modelReady) { trackProduct('session_error', { ...fields, reason: !modelReady ? 'provider_not_ready' : 'device_configuration' }); return }
    setSnapshotError('')
    setSavedHistoryId('')
    setHistorySaving(false)
    setCompletionRequested(false)
    clearShowcaseReturnView()
    setReturnView(null)
    playback.clear()
    startedAtRef.current = Date.now()
    setFinishedDurationMs(null)
    await Promise.all([leftSession.start(fields, leftPageLease), rightSession.start(fields, rightPageLease)])
  }
  const stopBoth = () => {
    setCompletionRequested(true)
    void Promise.all([leftSession.stop(), rightSession.stop()])
  }
  const togglePauseBoth = () => {
    void Promise.all(paused
      ? [leftSession.resume(), rightSession.resume()]
      : [leftSession.pause(), rightSession.pause()])
  }

  const duoSideLabel = (side: 'a' | 'b') => (side === 'a' ? '甲' : '乙')
  type DuoFollower = ReturnType<typeof useTranscriptFollow>
  // Figma 938:6312（录音）/ 938:5168（结束）：录音态行首右侧时间戳、最新一句带语言 chips；
  // 结束态左侧甲/乙角标，脚注行放点赞点踩与时间戳。
  const renderDuoBubble = (bubble: DuoShowcaseBubble, follower: DuoFollower) => {
    const featured = !terminal && featuredBubbleIds[bubble.side] === bubble.id
    const variant: ShowcaseRowVariant = featured ? 'featured' : bubble.committed ? 'history' : 'live'
    const primaryLanguage = bubble.side === 'a' ? leftPrimaryLanguage : rightPrimaryLanguage
    const sessionId = bubble.side === 'a' ? visibleLeftSessionId : visibleRightSessionId
    const outputDeviceId = bubble.side === 'a' ? leftOutputDeviceId : rightOutputDeviceId
    const sideRows = visibleBubbles.filter((candidate) => candidate.side === bubble.side)
    const sideRowIndex = sideRows.findIndex((candidate) => candidate.id === bubble.id)
    const sourceKey = `${bubble.side}:source:${bubble.id}`
    const playableLanguages = new Set(bubble.targetLanguages.filter((language) => (
      terminal
      && typeof bubble.outputAudioStarts[language] === 'number'
      && playback.hasTrack(sessionId, language)
    )))
    const playingLanguages = new Set([
      ...bubble.targetLanguages.filter((language) => playback.playingKey === `${bubble.side}:translation:${bubble.id}:${language}`),
    ])
    const playedLanguages = new Set(bubble.targetLanguages.filter((language) => playback.playedKeys.has(`${bubble.side}:translation:${bubble.id}:${language}`)))
    const source = asrDisplayText(bubble.source)
    return (
      <ShowcaseMotionArticle terminal={terminal}
        key={`${bubble.side}-${bubble.id}`}
        className={`showcase-duo-bubble showcase-duo-bubble--${bubble.side} showcase-duo-bubble--${variant}${activeSide === bubble.side ? ' is-active' : ''}`}
      >
        {terminal && <span className="showcase-duo-bubble-badge" aria-hidden="true">{duoSideLabel(bubble.side)}</span>}
        <div className="showcase-duo-bubble-body">
          {terminal && playback.hasTrack(sessionId) ? (
            <button
              type="button"
              className={`realtime-showcase-source showcase-source-playback${playback.playingKey === sourceKey ? ' is-playing' : ''}`}
              title={playback.playingKey === sourceKey ? '正在播放，点击停止' : '播放实际传入模型的音频（按本次降噪/VAD设置处理）'}
              aria-pressed={playback.playingKey === sourceKey}
              aria-label={`播放${duoSideLabel(bubble.side)}原文音频：${source}`}
              onClick={() => { void playback.play({
                sessionId,
                startMs: bubble.startMs,
                endMs: showcaseAudioEndMs(sideRows, sideRowIndex),
                outputDeviceId,
                key: sourceKey,
              }) }}
            >
              <ShowcaseTypewriterText text={source} enabled={false} onProgress={follower.onTextProgress} />
              <SentencePlaybackIcon playing={playback.playingKey === sourceKey} />
            </button>
          ) : (
            <p className="realtime-showcase-source">
              <ShowcaseTypewriterText text={source} enabled={false} onProgress={follower.onTextProgress} />
            </p>
          )}
          <ShowcaseTranslationList
            translations={bubble.translations}
            translationPlaybackFragments={bubble.translationPlaybackFragments}
            targetLanguages={bubble.targetLanguages}
            primaryLanguage={primaryLanguage}
            featured={featured}
            terminal={terminal}
            solo
            chips={false}
            primaryOnly={terminal || variant === 'history'}
            primaryPlaybackStatus={bubble.playbackStatus}
            highlightReadingTextOnly={highlightReadingTextOnly}
            livePlayback={{ enabled: !terminal && !paused, segmentId: (bubble.side === 'a' ? leftSession : rightSession).outputs[primaryLanguage]?.playingTranslationSegmentId || null }}
            onPrimaryLanguage={(language) => {
              setActiveSide(bubble.side)
              if (bubble.side === 'a') setLeftPrimaryLanguage(language)
              else setRightPrimaryLanguage(language)
            }}
            playableLanguages={playableLanguages}
            playingLanguages={playingLanguages}
            playedLanguages={playedLanguages}
            typewriterEnabled={false}
            onTextProgress={follower.onTextProgress}
            onPlayTranslation={(language) => { void playback.play({
              sessionId,
              language,
              startMs: bubble.outputAudioStarts[language],
              endMs: showcaseAudioEndMs(sideRows, sideRowIndex, language),
              outputDeviceId,
              key: `${bubble.side}:translation:${bubble.id}:${language}`,
            }) }}
          />
          {/* 反馈按钮放行外 article 层：译文行本身是 <button>，不得嵌套。 */}
          {terminal && (
            <footer className="showcase-row-footer">
              <SentenceFeedback unitId={bubble.id} feedback={bubble.side === 'a' ? leftFeedback : rightFeedback} context={{ sourceText: bubble.source, translationText: bubble.translations[primaryLanguage], targetLanguage: primaryLanguage, side: bubble.side, startMs: Math.round(bubble.startMs) }} />
            </footer>
          )}
        </div>
      </ShowcaseMotionArticle>
    )
  }

  return (
    <>
    <ShowcaseFrame
      mode={mode}
      status={displayStatus}
      fontSize={fontSize}
      paused={paused}
      muted={muted}
      busy={busy}
      restoreHeader={completionRequested}
      infoNotice={leftSession.completionReason === 'session_time_limit' || rightSession.completionReason === 'session_time_limit' ? sessionTimeLimitNotice : undefined}
      endingNotice={sessionEnding.notice}
      liveSnapshot={sessionMode === 'consumer' && checkpointSessionIDs.length === 2 ? { ...(checkpointInput || { sessionId: checkpointSessionIDs.join(':'), sourceLanguage: leftSourceLanguage, targetLanguage: leftTargetLanguages[0], durationMs: 0, sourceText: '', translationText: '', units: [] }), targetLanguages: [...new Set([...leftTargetLanguages, ...rightTargetLanguages])] } : undefined}
      liveStatus={terminalStatus(status) ? 'ended' : leftSession.paused && rightSession.paused ? 'paused' : 'live'}
      settings={settings}
      toolbar={busy && !completionRequested ? null : (
        <div className={`showcase-language-rail showcase-duo-rail${terminal ? ' showcase-language-rail--completed' : ''}${finishedView ? ' showcase-language-rail--finished' : ''}`}>
          <LanguageDirectionSelect
            side="甲"
            sourceLanguage={leftSourceLanguage}
            sourceOptions={showcaseSourceLanguages}
            selected={leftTargetLanguages}
            allowedTargets={leftAllowedTargets}
            disabled={busy}
            open={openLanguageSelect?.startsWith('a-') ? openLanguageSelect.slice(2) as 'source' | 'target' : null}
            onOpenChange={(open) => setOpenLanguageSelect(open ? `a-${open}` : null)}
            onSourceChange={setLeftSourceLanguage}
            onToggle={(language) => toggleTarget('a', language)}
          />
          <LanguageDirectionSelect
            side="乙"
            sourceLanguage={rightSourceLanguage}
            sourceOptions={showcaseSourceLanguages}
            selected={rightTargetLanguages}
            allowedTargets={rightAllowedTargets}
            disabled={busy}
            open={openLanguageSelect?.startsWith('b-') ? openLanguageSelect.slice(2) as 'source' | 'target' : null}
            onOpenChange={(open) => setOpenLanguageSelect(open ? `b-${open}` : null)}
            onSourceChange={setRightSourceLanguage}
            onToggle={(language) => toggleTarget('b', language)}
          />
          {finishedView && (
            <HistorySessionSummary context={{ mode: 'duo', ...historyTitle }} duration={finishedDurationMs !== null ? formatShowcaseDuration(finishedDurationMs) : undefined}>
                输出语言 {[...new Set([...leftTargetLanguages, ...rightTargetLanguages])].map((language) => chineseLanguageNames[language] || languageNames[language] || language).join(' / ')}
                {consumerQuota ? ` · ${consumerQuotaLabel(consumerQuota)}` : ''}
            </HistorySessionSummary>
          )}
          {terminal && <CompletedLanguageSwitch groups={[{
            side: '甲',
            sourceLanguage: leftSourceLanguage,
            languages: leftTargetLanguages,
            value: leftPrimaryLanguage,
            onChange: setLeftPrimaryLanguage,
          }, {
            side: '乙',
            sourceLanguage: rightSourceLanguage,
            languages: rightTargetLanguages,
            value: rightPrimaryLanguage,
            onChange: setRightPrimaryLanguage,
          }]} />}
        </div>
      )}
      notice={((leftSession.error || rightSession.error) && terminal && sessionMode === 'consumer' ? `${leftSession.error || rightSession.error} 点击尝试读取后台保存的转录记录。` : leftSession.error || rightSession.error) || snapshotError || audioDevices.error || historySync.sharedHistoryError || microphoneError || outputDeviceError || (!modelReady && health.available === false ? health.reason || 'S2ST 服务暂时不可用。' : '')}
      noticeActionOpensDevices={!((leftSession.error || rightSession.error) && terminal && sessionMode === 'consumer')}
      onNoticeAction={(leftSession.error || rightSession.error) && terminal && sessionMode === 'consumer' ? () => { void openRecoveredSessionHistory([leftSession.parentSessionID, rightSession.parentSessionID].filter(Boolean).join(':')) } : !leftSession.error && !rightSession.error && !snapshotError && audioDevices.error ? async () => { const gated = canaryDesignEnabled() && sessionMode !== 'eval'; const lease = gated ? canaryAIPrivacyGate.captureAuthorization() : () => true; if ((!gated || await canaryAIPrivacyGate.ensureAuthorized()) && lease()) await audioDevices.requestPermissionAndRefresh() } : undefined}
      deviceGuideSignal={deviceGuideSignal}
      welcomeTitle={WELCOME_COPY.duo.title}
      welcomeSubtitle={WELCOME_COPY.duo.subtitle}
      hasContent={visibleBubbles.length > 0}
      controlDisabled={!canStartDuoShowcase() || completionRequested || status === 'connecting' || status === 'processing' || (!modelReady || (audioDevices.permissionGranted && (Boolean(microphoneError) || Boolean(outputDeviceError)))) && status !== 'recording'}
      pauseDisabled={deviceSwitching}
      onModeChange={onModeChange}
      onControl={canStartDuoShowcase() ? startBoth : () => undefined}
      onMute={() => setMuted((value) => !value)}
      onPause={togglePauseBoth}
      leaveReady={(terminalStatus(status) || status === 'idle') && !completionRequested && !historySaving}
      onLeave={async () => {
        const released = await Promise.all([
          leftSession.paused ? true : leftSession.pause(),
          rightSession.paused ? true : rightSession.pause(),
        ])
        if (released.some(value => !value)) throw new Error('microphone release failed')
        setCompletionRequested(true)
        await Promise.all([leftSession.stop(), rightSession.stop()])
      }}
      onComplete={stopBoth}
      footerAction={terminal && sessionMode === 'consumer' && visibleBubbles.length > 0
        ? <ConsumerSessionShare historyId={savedHistoryId} sessionId={[visibleLeftSessionId, visibleRightSessionId].filter(Boolean).join(':')} saving={historySaving || completionRequested} onResolved={setSavedHistoryId} />
        : undefined}
      finished={finishedView}
    >
      {terminal ? (
        <div className={`realtime-showcase-transcript showcase-multilingual-transcript showcase-duo-transcript showcase-multilingual-transcript--completed${finishedView ? ' showcase-multilingual-transcript--finished' : ''}`} {...follow.playbackGesture} ref={follow.transcriptRef} onScroll={follow.onScroll} onPointerDown={follow.onPointerDown} onPointerUp={follow.onPointerUp} onPointerCancel={follow.onPointerUp}>
          <div className="realtime-showcase-transcript-track">
            {displayedBubbles.map((bubble) => renderDuoBubble(bubble, follow))}
            {visibleBubbles.length === 0 && <p className="showcase-finished-empty-title">本次没有识别到语音</p>}
            <SessionAudioDownloads archives={playback.archives} sessionIds={[visibleLeftSessionId, visibleRightSessionId]} playingKey={playback.playingKey} onPlay={playback.stop} />
          </div>
        </div>
      ) : (
        // Figma 938:6312：乙在上（深绿）、甲在下（浅灰），各自带说话人抬头、语言摘要与独立滚动区。
        <div className="realtime-showcase-transcript showcase-multilingual-transcript showcase-duo-transcript showcase-duo-transcript--split">
          {([['b', followB], ['a', follow]] as const).map(([side, follower]) => {
            const sideBubbles = side === 'a' ? punctuatedLeftBubbles : punctuatedRightBubbles
            const sourceLanguage = side === 'a' ? leftSourceLanguage : rightSourceLanguage
            const targets = side === 'a' ? leftTargetLanguages : rightTargetLanguages
            const primaryLanguage = side === 'a' ? leftPrimaryLanguage : rightPrimaryLanguage
            return (
              <section key={side} className={`showcase-duo-panel showcase-duo-panel--${side}`} aria-label={`${duoSideLabel(side)}说话人`}>
                <header className="showcase-duo-panel-head">
                  <span className="showcase-duo-panel-side"><b aria-hidden="true">{duoSideLabel(side)}</b>说话人</span>
                  <span className="showcase-duo-panel-languages">
                    <span>{directionLanguageLabel(sourceLanguage)}</span>
                    <i aria-hidden="true" />
                    <span>{targets.map((language) => languageLabels[language] || language).join(' / ')}</span>
                  </span>
                </header>
                <div className="showcase-duo-panel-scroll" {...follower.playbackGesture} ref={follower.transcriptRef} onScroll={follower.onScroll} onPointerDown={follower.onPointerDown} onPointerUp={follower.onPointerUp} onPointerCancel={follower.onPointerUp}>
                  <div className="realtime-showcase-transcript-track">
                    {sideBubbles.map((bubble) => renderDuoBubble(bubble, follower))}
                    {sideBubbles.length === 0 && (
                      <p className="realtime-showcase-listening">{visibleBubbles.length === 0 && side === 'a' ? '请甲或乙开始说话，翻译结果将在这里显示…' : `请${duoSideLabel(side)}开始说话…`}</p>
                    )}
                  </div>
                </div>
                {(status === 'recording' || status === 'connecting' || status === 'processing') && targets.length > 1 && (
                  <div className="showcase-row-languages showcase-duo-panel-language-switch" role="group" aria-label={`切换${duoSideLabel(side)}主要译文语言`}>
                    {targets.map((language) => (
                      <button
                        type="button"
                        key={language}
                        className={language === primaryLanguage ? 'is-active' : ''}
                        aria-label={`${duoSideLabel(side)}主要译文切换为${languageNames[language] || language}`}
                        aria-pressed={language === primaryLanguage}
                        onClick={() => {
                          setActiveSide(side)
                          if (side === 'a') setLeftPrimaryLanguage(language)
                          else setRightPrimaryLanguage(language)
                        }}
                      >{languageLabels[language] || language.slice(0, 2).toUpperCase()}</button>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </ShowcaseFrame>
    <EchoCancellationSetupDialog
      open={echoCancellationSetupOpen}
      onConfirm={() => {
        setEchoCancellationSetupOpen(false)
        applyNoisePreset('echo-cancellation')
      }}
      onUseHeadphones={() => {
        setEchoCancellationSetupOpen(false)
        applyNoisePreset('headphones')
      }}
    />
    </>
  )
}
