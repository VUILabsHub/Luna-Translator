// Change record (2026-08-06): poll backend-proxied S2ST readiness so the
// workspace can block new sessions and show a clear unavailable label.
import { useEffect, useState } from 'react'
import { apiFetch } from './apiFetch'

export type S2STHealth = {
  available: boolean | null
  monitored: boolean
  checkedAt?: string
  reason?: string
}

const initialHealth: S2STHealth = { available: null, monitored: false }

export function normalizeS2STHealth(value: unknown): S2STHealth {
  if (!value || typeof value !== 'object') {
    return { available: false, monitored: true, reason: '服务暂时不可用' }
  }
  const response = value as Record<string, unknown>
  return {
    available: response.available === true,
    monitored: response.monitored === true,
    checkedAt: typeof response.checkedAt === 'string' ? response.checkedAt : undefined,
    reason: typeof response.reason === 'string' ? response.reason : undefined,
  }
}

export async function fetchS2STHealth(signal?: AbortSignal): Promise<S2STHealth> {
  const response = await apiFetch('/api/s2st-health', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('S2ST health unavailable')
  return normalizeS2STHealth(await response.json())
}

export function useS2STHealth(enabled: boolean, pollIntervalMs = 5_000): S2STHealth {
  const [health, setHealth] = useState<S2STHealth>(initialHealth)

  useEffect(() => {
    if (!enabled) {
      setHealth({ available: true, monitored: false })
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        setHealth(await fetchS2STHealth(controller.signal))
      } catch (error) {
        if (controller.signal.aborted) return
        setHealth({ available: false, monitored: true, reason: '服务暂时不可用' })
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, pollIntervalMs)
    }

    setHealth(initialHealth)
    void poll()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, pollIntervalMs])

  return health
}
