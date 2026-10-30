import type { PublicProvider, RealtimeService } from './config'

export type RealtimeModel = 'qwen25' | 'qwen3' | 'qwen3simul' | string
export type RealtimeTTS = 'qwen' | 'qwen17b' | 'omnivoice' | 'omnivoice-xc' | 'qwentts-sc' | 'cosyvoice' | 'integrated'

export type RealtimeRouteDimensions = {
  service: RealtimeService
  model: RealtimeModel
  tts: RealtimeTTS
}

export const realtimeServices: Array<{ id: RealtimeService; label: string }> = [
  { id: 'websocket', label: 'WebSocket' },
  { id: 'livekit', label: 'WebRTC · LiveKit' },
  { id: 'volc-rtc', label: 'WebRTC · 火山 RTC（实验）' },
]

export const realtimeModelLabels: Record<string, string> = {
  qwen25: 'Qwen2.5-Omni',
  qwen3: 'Qwen3-Omni',
  qwen3simul: 'Qwen3Simul',
}

export const realtimeTTSLabels: Record<RealtimeTTS, string> = {
  qwen: 'QwenTTS',
  qwen17b: 'Qwen3-TTS 1.7B',
  omnivoice: 'OmniVoice',
  'omnivoice-xc': 'OmniVoice-XC',
  'qwentts-sc': 'qwentts-sc',
  cosyvoice: 'CosyVoice',
  integrated: '模型 / 供应商内置',
}

export function serviceForProvider(provider: Pick<PublicProvider, 'service' | 'transport'>): RealtimeService {
  if (provider.service) return provider.service
  return provider.transport === 'webrtc' ? 'livekit' : 'websocket'
}

export function baseProviderID(provider: Pick<PublicProvider, 'id' | 'baseProviderId'>) {
  if (provider.baseProviderId) return provider.baseProviderId
  if (provider.id.endsWith('-volc-rtc')) return provider.id.slice(0, -'-volc-rtc'.length)
  if (provider.id.endsWith('-webrtc')) return provider.id.slice(0, -'-webrtc'.length)
  return provider.id
}

export function realtimeRouteDimensions(provider: PublicProvider): RealtimeRouteDimensions {
  const baseID = baseProviderID(provider)
  const match = /^vuilabs-(qwen25-omni|qwen3-omni|qwen3simul)-(qwen|qwen17b|omnivoice|omnivoice-xc|qwentts-sc|cosyvoice)$/.exec(baseID)
  if (!match) {
    return { service: serviceForProvider(provider), model: baseID, tts: 'integrated' }
  }
  const model = match[1] === 'qwen25-omni'
    ? 'qwen25'
    : match[1] === 'qwen3-omni' ? 'qwen3' : 'qwen3simul'
  return {
    service: serviceForProvider(provider),
    model,
    tts: match[2] as RealtimeTTS,
  }
}

export function routesForService(providers: PublicProvider[], service: RealtimeService) {
  return providers.filter((provider) => serviceForProvider(provider) === service)
}

export function selectRealtimeRoute(
  providers: PublicProvider[],
  desired: RealtimeRouteDimensions,
) {
  const serviceRoutes = routesForService(providers, desired.service)
  const tiers = [
    serviceRoutes.filter((provider) => {
      const route = realtimeRouteDimensions(provider)
      return route.model === desired.model && route.tts === desired.tts
    }),
    serviceRoutes.filter((provider) => {
      const route = realtimeRouteDimensions(provider)
      return route.model === desired.model && route.tts === 'qwen'
    }),
    serviceRoutes.filter((provider) => realtimeRouteDimensions(provider).model === desired.model),
    serviceRoutes.filter((provider) => {
      const route = realtimeRouteDimensions(provider)
      return route.model === 'qwen3simul' && route.tts === 'qwen'
    }),
    serviceRoutes,
  ]
  for (const tier of tiers) {
    const selectable = tier.find((provider) => provider.ready || provider.id === 'volcengine')
    if (selectable) return selectable
  }
  return tiers.find((tier) => tier.length > 0)?.[0]
}
