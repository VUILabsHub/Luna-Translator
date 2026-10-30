import { historyFetch } from './historyFetch'
import type { PublicConfig } from './config'
import type { HistoryEntry } from '../types/history'

export type HistoryDateCount = { date: string; count: number }

// clientTZOffset matches the backend's tzOffsetMinutes contract: JavaScript's
// getTimezoneOffset() returns minutes where local = UTC - offset, which the Go
// handler converts back into the viewer's zone so days group the way the tester
// reads the timestamps.
export function clientTZOffset(): number {
  return new Date().getTimezoneOffset()
}

// formatHistoryDate turns a YYYY-MM-DD key into the sidebar's zh label, e.g.
// "2026-08-06" → "8月6日".
export function formatHistoryDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  return `${Number(match[2])}月${Number(match[3])}日`
}

// localDateOf returns the YYYY-MM-DD day of an ISO instant in the browser's
// timezone, so client-side grouping of local records lines up with the backend
// grouping of shared records.
export function localDateOf(createdAt: string): string {
  const parsed = new Date(createdAt)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString('sv-SE')
}

function normalizeDateCounts(value: unknown): HistoryDateCount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return []
    const record = candidate as Record<string, unknown>
    const date = record.date
    const count = record.count
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return []
    return [{ date, count }]
  })
}

export function mergeDateCounts(...lists: HistoryDateCount[][]): HistoryDateCount[] {
  const totals = new Map<string, number>()
  for (const list of lists) {
    for (const { date, count } of list) totals.set(date, (totals.get(date) || 0) + count)
  }
  return [...totals.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => right.date.localeCompare(left.date))
}

async function fetchDates(url: string): Promise<HistoryDateCount[]> {
  const response = await historyFetch(url)
  if (!response.ok) throw new Error('读取历史日期失败')
  const value = await response.json() as { dates?: unknown }
  return normalizeDateCounts(value.dates)
}

// fetchSharedHistoryDates asks the backend for per-day counts of realtime and
// batch records, merging them into a single sidebar list for the OSS view.
export async function fetchSharedHistoryDates(config: PublicConfig): Promise<HistoryDateCount[]> {
  const tz = clientTZOffset()
  const [realtime, batch] = await Promise.all([
    config.historySharing ? fetchDates(`/api/history/dates?tz=${tz}`) : Promise.resolve<HistoryDateCount[]>([]),
    config.benchmarkSharing ? fetchDates(`/api/benchmark/results/dates?tz=${tz}`) : Promise.resolve<HistoryDateCount[]>([]),
  ])
  return mergeDateCounts(realtime, batch)
}

// localHistoryDates groups already-loaded local records by browser-timezone day.
export function localHistoryDates(history: HistoryEntry[]): HistoryDateCount[] {
  const totals = new Map<string, number>()
  for (const entry of history) {
    const date = localDateOf(entry.createdAt)
    if (!date) continue
    totals.set(date, (totals.get(date) || 0) + 1)
  }
  return [...totals.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => right.date.localeCompare(left.date))
}
