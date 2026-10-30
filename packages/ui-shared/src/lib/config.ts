// Change record (2026-08-05): advertise Bad Case storage readiness.
import { createContext, useContext } from 'react'
import { apiFetch, configureExhibitionConsumerAuth } from './apiFetch'

export type PublicProvider = {
  id: string
  baseProviderId?: string
  transport?: 'websocket' | 'webrtc'
  service?: RealtimeService
  model: string
  ready: boolean
  voiceClone: boolean
  reason?: string
  configured?: boolean
}

export type RealtimeService = 'websocket' | 'livekit' | 'volc-rtc'

export type SourceASRProvider = 'qwen-realtime' | 'volc' | 'qwen3'

export const sourceASRProviderLabels: Record<SourceASRProvider, string> = {
  'qwen-realtime': 'Qwen ASR Realtime',
  volc: '火山 BigModel ASR',
  qwen3: 'Qwen3-ASR-1.7B',
}

export type PublicConfig = {
  // AppShell.tsx 曾用: configured / providers[].configured
  // App.tsx 曾用: defaultProvider / voiceClone / historySharing / benchmarkSharing / annotationStorage / providers
  // BatchBenchmark.tsx 曾用: benchmarkSharing / benchmarkMedia / providers
  configured?: boolean
  defaultProvider: string
  voiceClone: boolean
  historySharing?: boolean
  consumerTargetLanguages?: string[]
  consumerSourceLanguages?: string[]
  consumerVoiceCloneRequired?: boolean
  translationEvaluation?: boolean
  benchmarkSharing?: boolean
  benchmarkMedia?: boolean
  benchmarkMaxConcurrency?: number
  annotationStorage?: boolean
  annotationV2Storage?: boolean
  annotationWorkEmailAuth?: boolean
  annotationAuthMode?: 'otp' | 'email_only' | 'password'
  exhibitionMode?: boolean
  badCaseStorage?: boolean
  referenceTextStorage?: boolean
  referenceTextClassifier?: boolean
  buildSha?: string
  eventSchemaVersion?: number
	sourceAsr?: 'gateway' | 'qwen-realtime' | 'volc-bigmodel' | 'qwen3-asr-1.7b' | 'selectable'
  sourceAsrProviders?: SourceASRProvider[]
  defaultSourceAsrProvider?: SourceASRProvider
  sourceAsrVadGated?: boolean
  // 账号资料一期（backend/server/server.go）：只在 Canary 候选下发 name=true；avatar 是二期上传头像，目前恒为 false。
  // 老服务端 / prod 不带这个字段，按全关处理（web/src/lib/profile.ts profileNamesEnabled）。
  profile?: { name?: boolean; avatar?: boolean }
  providers: PublicProvider[]
}

export function configuredSourceASRProviders(
  config: Pick<PublicConfig, 'sourceAsr' | 'sourceAsrProviders'> | null | undefined,
): SourceASRProvider[] {
  const configured = config?.sourceAsrProviders?.filter((provider, index, providers) => (
    ['qwen-realtime', 'volc', 'qwen3'].includes(provider) && providers.indexOf(provider) === index
  ))
  if (configured?.length) return configured
  if (config?.sourceAsr === 'qwen-realtime') return ['qwen-realtime']
  if (config?.sourceAsr === 'volc-bigmodel') return ['volc']
  if (config?.sourceAsr === 'qwen3-asr-1.7b') return ['qwen3']
  if (config?.sourceAsr === 'selectable') return ['qwen3', 'volc']
  return ['qwen3']
}

export function configuredDefaultSourceASRProvider(
  config: Pick<PublicConfig, 'sourceAsr' | 'sourceAsrProviders' | 'defaultSourceAsrProvider'> | null | undefined,
): SourceASRProvider {
  const available = configuredSourceASRProviders(config)
  return config?.defaultSourceAsrProvider && available.includes(config.defaultSourceAsrProvider)
    ? config.defaultSourceAsrProvider
    : available[0]
}

const UNVERIFIED_CONFIG_VALUE = 'unknown（未核验）'

export function describeBackendVersion(
  config: Pick<PublicConfig, 'buildSha' | 'eventSchemaVersion'> | null | undefined,
) {
  const buildSha = typeof config?.buildSha === 'string' && config.buildSha.trim()
    ? config.buildSha.trim()
    : UNVERIFIED_CONFIG_VALUE
  const rawEventSchemaVersion = config?.eventSchemaVersion
  const eventSchemaVersion = typeof rawEventSchemaVersion === 'number'
    && Number.isSafeInteger(rawEventSchemaVersion)
    && rawEventSchemaVersion > 0
    ? `v${rawEventSchemaVersion}`
    : UNVERIFIED_CONFIG_VALUE
  return `后端 SHA：${buildSha} · 事件协议：${eventSchemaVersion}`
}

export type PublicConfigState = {
  config: PublicConfig | null
  loadFailed: boolean
}

type FetchPublicConfigOptions = {
  signal?: AbortSignal
  retryDelaysMs?: readonly number[]
}

const DEFAULT_CONFIG_RETRY_DELAYS_MS = [250, 500, 1000, 2000] as const

class PublicConfigResponseError extends Error {
  constructor(readonly status: number) {
    super(`config unavailable (${status})`)
    this.name = 'PublicConfigResponseError'
  }
}

function retryableConfigStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function abortedError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function waitForConfigRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortedError())
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchPublicConfig({
  signal,
  retryDelaysMs = DEFAULT_CONFIG_RETRY_DELAYS_MS,
}: FetchPublicConfigOptions = {}): Promise<PublicConfig> {
  let lastError: unknown = new Error('config unavailable')
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (signal?.aborted) throw abortedError()
    try {
      const response = await apiFetch('/api/config', { signal })
      if (!response.ok) throw new PublicConfigResponseError(response.status)
      const config = await response.json() as PublicConfig
      configureExhibitionConsumerAuth(config.exhibitionMode === true)
      return config
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error
      }
      if (error instanceof PublicConfigResponseError && !retryableConfigStatus(error.status)) {
        throw error
      }
      lastError = error
      if (attempt === retryDelaysMs.length) break
      await waitForConfigRetry(retryDelaysMs[attempt], signal)
    }
  }
  throw lastError
}

export const PublicConfigContext = createContext<PublicConfigState>({ config: null, loadFailed: false })

export function usePublicConfig(): PublicConfigState {
  return useContext(PublicConfigContext)
}
