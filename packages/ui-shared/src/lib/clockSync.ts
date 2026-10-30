import { apiFetch } from './apiFetch'

export type ServerClockSync = {
  offsetUs: number
  uncertaintyMs: number
}

export type ClockSyncSample = {
  offsetUs: number
  networkRTTUs: number
}

export function clientUnixUsAt(performanceMs: number) {
  return Math.round((performance.timeOrigin + performanceMs) * 1000)
}

export function computeClockSyncSample(measurement: {
  clientSendUnixUs: number
  clientReceiveUnixUs: number
  serverReceiveUnixUs: unknown
  serverSendUnixUs: unknown
}): ClockSyncSample | null {
  const { clientSendUnixUs, clientReceiveUnixUs, serverReceiveUnixUs, serverSendUnixUs } = measurement
  if (
    typeof serverReceiveUnixUs !== 'number'
    || typeof serverSendUnixUs !== 'number'
    || !Number.isSafeInteger(serverReceiveUnixUs)
    || !Number.isSafeInteger(serverSendUnixUs)
    || serverSendUnixUs < serverReceiveUnixUs
  ) return null
  const serverProcessingUs = serverSendUnixUs - serverReceiveUnixUs
  const networkRTTUs = Math.max(0, clientReceiveUnixUs - clientSendUnixUs - serverProcessingUs)
  const offsetUs = (
    (serverReceiveUnixUs - clientSendUnixUs)
    + (serverSendUnixUs - clientReceiveUnixUs)
  ) / 2
  return { offsetUs, networkRTTUs }
}

export function summarizeClockSyncSamples(samples: ClockSyncSample[]): ServerClockSync | null {
  if (samples.length === 0) return null
  const best = [...samples].sort((left, right) => left.networkRTTUs - right.networkRTTUs).slice(0, 3)
  const offsets = best.map((sample) => sample.offsetUs).sort((left, right) => left - right)
  return {
    offsetUs: offsets[Math.floor(offsets.length / 2)],
    uncertaintyMs: best[0].networkRTTUs / 2000,
  }
}

const CLOCK_SYNC_TTL_MS = 5 * 60_000
let cachedClockSync: { value: ServerClockSync; fetchedAt: number } | null = null
let inFlightClockSync: Promise<ServerClockSync> | null = null

// The 7 sequential /api/time samples cost multiple RTTs, so callers on a
// latency-sensitive path reuse one page-level result instead of re-sampling.
export function ensureServerClockSync(): Promise<ServerClockSync> {
  if (cachedClockSync && Date.now() - cachedClockSync.fetchedAt < CLOCK_SYNC_TTL_MS) {
    return Promise.resolve(cachedClockSync.value)
  }
  if (!inFlightClockSync) {
    inFlightClockSync = synchronizeServerClock()
      .then((value) => {
        cachedClockSync = { value, fetchedAt: Date.now() }
        return value
      })
      .finally(() => {
        inFlightClockSync = null
      })
  }
  return inFlightClockSync
}

export function resetServerClockSyncCacheForTests() {
  cachedClockSync = null
  inFlightClockSync = null
}

export async function synchronizeServerClock(): Promise<ServerClockSync> {
  const samples: ClockSyncSample[] = []
  for (let index = 0; index < 7; index++) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 1500)
    try {
      const clientSendUnixUs = clientUnixUsAt(performance.now())
      const response = await apiFetch('/api/time', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      })
      if (!response.ok) continue
      const value = await response.json() as {
        serverReceiveUnixUs?: number
        serverSendUnixUs?: number
      }
      const clientReceiveUnixUs = clientUnixUsAt(performance.now())
      const sample = computeClockSyncSample({
        clientSendUnixUs,
        clientReceiveUnixUs,
        serverReceiveUnixUs: value.serverReceiveUnixUs,
        serverSendUnixUs: value.serverSendUnixUs,
      })
      if (sample) samples.push(sample)
    } catch {
      continue
    } finally {
      window.clearTimeout(timeout)
    }
  }
  const summary = summarizeClockSyncSamples(samples)
  if (!summary) throw new Error('无法校准浏览器与服务端时钟。')
  return summary
}
