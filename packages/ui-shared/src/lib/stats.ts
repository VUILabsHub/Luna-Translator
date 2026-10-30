import type {
  NativeMetricSample,
  TimedAudioSegment,
  TimedTranscriptSegment,
  TimelineLatencyStats,
} from '../types/history'

export function percentile(values: number[], rank: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(rank / 100 * sorted.length) - 1))
  return sorted[index]
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function calculateValueStats(values: number[]): TimelineLatencyStats {
  const latencies = values.filter((value) => Number.isFinite(value) && value >= 0)
  return { averageMs: average(latencies), p95Ms: percentile(latencies, 95), sampleCount: latencies.length }
}

export type DistributionStats = {
  average: number | null
  median: number | null
  minimum: number | null
  maximum: number | null
  q1: number | null
  q3: number | null
  p95: number | null
  sampleCount: number
  missingCount: number
  lowerOutlierBound: number | null
  upperOutlierBound: number | null
}

export function calculateDistributionStats(values: Array<number | null | undefined>): DistributionStats {
  const valid = values.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ))
  const q1 = percentile(valid, 25)
  const q3 = percentile(valid, 75)
  const iqr = q1 === null || q3 === null ? null : q3 - q1
  return {
    average: average(valid),
    median: percentile(valid, 50),
    minimum: valid.length > 0 ? Math.min(...valid) : null,
    maximum: valid.length > 0 ? Math.max(...valid) : null,
    q1,
    q3,
    p95: percentile(valid, 95),
    sampleCount: valid.length,
    missingCount: values.length - valid.length,
    lowerOutlierBound: q1 === null || iqr === null ? null : Math.max(0, q1 - 1.5 * iqr),
    upperOutlierBound: q3 === null || iqr === null ? null : q3 + 1.5 * iqr,
  }
}

function ranks(values: number[]) {
  const sorted = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value)
  const result = new Array<number>(values.length)
  for (let start = 0; start < sorted.length;) {
    let end = start + 1
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++
    const averageRank = (start + 1 + end) / 2
    for (let index = start; index < end; index++) result[sorted[index].index] = averageRank
    start = end
  }
  return result
}

export function spearmanCorrelation(pairs: Array<{ x: number; y: number }>): number | null {
  const valid = pairs.filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
  if (valid.length < 2) return null
  const xRanks = ranks(valid.map(({ x }) => x))
  const yRanks = ranks(valid.map(({ y }) => y))
  const xAverage = average(xRanks)
  const yAverage = average(yRanks)
  if (xAverage === null || yAverage === null) return null
  let numerator = 0
  let xSquares = 0
  let ySquares = 0
  for (let index = 0; index < valid.length; index++) {
    const xDelta = xRanks[index] - xAverage
    const yDelta = yRanks[index] - yAverage
    numerator += xDelta * yDelta
    xSquares += xDelta * xDelta
    ySquares += yDelta * yDelta
  }
  const denominator = Math.sqrt(xSquares * ySquares)
  return denominator === 0 ? null : numerator / denominator
}

export function calculateInputSendIntervalMetrics(timestampsMs: number[]) {
  const intervals = timestampsMs.slice(1).map((value, index) => value - timestampsMs[index])
  const stats = calculateValueStats(intervals)
  return {
    p95Ms: stats.p95Ms,
    maxGapMs: intervals.length > 0 ? Math.max(...intervals) : null,
    sampleCount: stats.sampleCount,
  }
}

export function validLatencies(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

export function segmentTimelineLatency(segment: TimedTranscriptSegment) {
  if (segment.timingSource === 'client_estimated') return null
  if (typeof segment.receivedAtMs !== 'number' || !Number.isFinite(segment.receivedAtMs)) return null
  const latency = segment.receivedAtMs - segment.endMs
  return latency >= 0 ? latency : null
}

export function hasClientEstimatedTiming(segments: TimedTranscriptSegment[]) {
  return segments.some((segment) => segment.timingSource === 'client_estimated')
}

export function calculateTimelineLatencyStats(segments: TimedTranscriptSegment[]): TimelineLatencyStats {
  const latencies = segments
    .map(segmentTimelineLatency)
    .filter((latency): latency is number => latency !== null)
  return calculateValueStats(latencies)
}

export function calculateAudioTimelineLatencyStats(segments: TimedAudioSegment[]): TimelineLatencyStats {
  return calculateValueStats(segments.map((segment) => segment.receivedAtMs - segment.endMs).filter((value) => value >= 0))
}

export function calculateNativeMetricStats(samples: NativeMetricSample[]): TimelineLatencyStats {
  return calculateValueStats(samples.map((sample) => sample.valueMs))
}

export function historyTimelineStats(segments: TimedTranscriptSegment[]) {
  const stats = calculateTimelineLatencyStats(segments)
  return {
    averageTimelineLatencyMs: stats.averageMs,
    tailTimelineLatencyP95Ms: stats.p95Ms,
    timelineSampleCount: stats.sampleCount,
  }
}

export function historyAudioTimelineStats(segments: TimedAudioSegment[]) {
  const stats = calculateAudioTimelineLatencyStats(segments)
  return {
    averageAudioTimelineLatencyMs: stats.averageMs,
    tailAudioTimelineLatencyP95Ms: stats.p95Ms,
    audioTimelineSampleCount: stats.sampleCount,
  }
}

export function historyNativeMetricStats(samples: NativeMetricSample[], kind: 'providerLag' | 'synthesisDuration') {
  const stats = calculateNativeMetricStats(samples)
  if (kind === 'providerLag') {
    return {
      providerLagAverageMs: stats.averageMs,
      providerLagP95Ms: stats.p95Ms,
      providerLagSampleCount: stats.sampleCount,
    }
  }
  return {
    synthesisDurationAverageMs: stats.averageMs,
    synthesisDurationP95Ms: stats.p95Ms,
    synthesisDurationSampleCount: stats.sampleCount,
  }
}
