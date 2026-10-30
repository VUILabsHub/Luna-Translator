import type { LocalAudioTrack, RemoteAudioTrack } from 'livekit-client'

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_MAX_SAMPLES = 1800

export type RTCStatsSample = {
  tUnixMs: number
  outbound: { packetsSent: number | null; bytesSent: number | null; retransmittedPackets: number | null; targetBitrate: number | null } | null
  remoteInbound: { roundTripTimeMs: number | null; fractionLost: number | null; jitterMs: number | null; packetsLost: number | null } | null
  inbound: { packetsReceived: number | null; packetsLost: number | null; bytesReceived: number | null; jitterMs: number | null; audioLevel: number | null; concealmentEvents: number | null; concealedSamples: number | null } | null
  candidatePair: { currentRoundTripTimeMs: number | null; availableOutgoingBitrate: number | null; availableIncomingBitrate: number | null; bytesSent: number | null; bytesReceived: number | null; state: string | null; localCandidateType: string | null; remoteCandidateType: string | null } | null
}

export type RTCStatsArchive = {
  startedAtUnixMs: number
  endedAtUnixMs: number
  intervalMs: number
  userAgent: string
  truncated: boolean
  samples: RTCStatsSample[]
}

type StatsTrack = Pick<LocalAudioTrack | RemoteAudioTrack, 'getRTCStatsReport'>

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000_000) / 1000 : null
}

type AudioStatsResult = {
  outbound: RTCStatsSample['outbound']
  remoteInbound: RTCStatsSample['remoteInbound']
  inbound: RTCStatsSample['inbound']
  candidatePair: RTCStatsSample['candidatePair']
}

export function extractAudioStats(report: RTCStatsReport): AudioStatsResult {
  let outbound: RTCStatsSample['outbound'] = null
  let remoteInbound: RTCStatsSample['remoteInbound'] = null
  let inbound: RTCStatsSample['inbound'] = null
  let candidatePair: RTCStatsSample['candidatePair'] = null
  let candidatePairNominated = false
  const candidates: Record<string, { candidateType?: string }> = {}

  report.forEach((raw) => {
    const stat = raw as Record<string, unknown>
    if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
      candidates[stat.id as string] = stat as { candidateType?: string }
    }
  })

  report.forEach((raw) => {
    const stat = raw as Record<string, unknown>
    const type = stat.type
    if ((type === 'outbound-rtp' || type === 'inbound-rtp' || type === 'remote-inbound-rtp') && stat.kind !== 'audio') return
    switch (type) {
      case 'outbound-rtp':
        outbound = { packetsSent: num(stat.packetsSent), bytesSent: num(stat.bytesSent), retransmittedPackets: num(stat.retransmittedPacketsSent), targetBitrate: num(stat.targetBitrate) }
        break
      case 'remote-inbound-rtp':
        remoteInbound = { roundTripTimeMs: sToMs(stat.roundTripTime), fractionLost: num(stat.fractionLost), jitterMs: sToMs(stat.jitter), packetsLost: num(stat.packetsLost) }
        break
      case 'inbound-rtp':
        inbound = { packetsReceived: num(stat.packetsReceived), packetsLost: num(stat.packetsLost), bytesReceived: num(stat.bytesReceived), jitterMs: sToMs(stat.jitter), audioLevel: num(stat.audioLevel), concealmentEvents: num(stat.concealmentEvents), concealedSamples: num(stat.concealedSamples) }
        break
      case 'candidate-pair': {
        const nominated = stat.nominated === true
        const succeeded = stat.state === 'succeeded'
        if (!nominated && !succeeded) break
        if (candidatePair && candidatePairNominated && !nominated) break
        const local = candidates[stat.localCandidateId as string]
        const remote = candidates[stat.remoteCandidateId as string]
        candidatePair = { currentRoundTripTimeMs: sToMs(stat.currentRoundTripTime), availableOutgoingBitrate: num(stat.availableOutgoingBitrate), availableIncomingBitrate: num(stat.availableIncomingBitrate), bytesSent: num(stat.bytesSent), bytesReceived: num(stat.bytesReceived), state: typeof stat.state === 'string' ? stat.state : null, localCandidateType: local?.candidateType ?? null, remoteCandidateType: remote?.candidateType ?? null }
        candidatePairNominated = nominated
        break
      }
    }
  })

  return { outbound, remoteInbound, inbound, candidatePair }
}

export function createRTCStatsCollector(opts: {
  localTrack: StatsTrack
  getRemoteAudioTrack: () => StatsTrack | null
  intervalMs?: number
  maxSamples?: number
  now?: () => number
}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES
  const now = opts.now ?? (() => Date.now())
  const samples: RTCStatsSample[] = []
  let truncated = false
  let timer: ReturnType<typeof setInterval> | null = null
  let startedAtUnixMs = 0

  async function tick() {
    try {
      const localReport = await opts.localTrack.getRTCStatsReport()
      if (!localReport) return
      const remoteTrack = opts.getRemoteAudioTrack()
      const remoteReport = remoteTrack ? await remoteTrack.getRTCStatsReport() : undefined
      const local = extractAudioStats(localReport)
      const remote = remoteReport ? extractAudioStats(remoteReport) : null
      samples.push({
        tUnixMs: now(),
        outbound: local.outbound,
        remoteInbound: local.remoteInbound,
        inbound: remote?.inbound ?? null,
        candidatePair: local.candidatePair ?? remote?.candidatePair ?? null,
      })
      if (samples.length > maxSamples) {
        samples.shift()
        truncated = true
      }
    } catch {
      // 旁路遥测:单 tick 失败跳过,绝不影响会话
    }
  }

  return {
    start() {
      if (timer) return
      startedAtUnixMs = now()
      timer = setInterval(() => { void tick() }, intervalMs)
    },
    stop(): RTCStatsArchive {
      if (timer) { clearInterval(timer); timer = null }
      return {
        startedAtUnixMs,
        endedAtUnixMs: now(),
        intervalMs,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        truncated,
        samples: [...samples],
      }
    },
  }
}
