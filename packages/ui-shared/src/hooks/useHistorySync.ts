import { useEffect, useRef, useState } from 'react'
import { deleteHistoryAudio, saveHistoryAudio, type HistoryAudioArchive } from '../historyAudio'
import type { PublicConfig } from '../lib/config'
import { apiFetch } from '../lib/apiFetch'
import { historyFetch } from '../lib/historyFetch'
import {
  loadHistory,
  mergeSharedHistory,
  normalizeBatchHistory,
  normalizeHistory,
  saveHistory,
  deleteSharedHistoryEntry,
  fetchSharedHistoryByTraceID,
  uploadHistoryEntry,
} from '../lib/historyApi'
import { clientTZOffset, fetchSharedHistoryDates, localDateOf, type HistoryDateCount } from '../lib/historyDates'
import { useAnnotationIdentity } from '../shell/ShellProviders'
import type { HistoryEntry } from '../types/history'

export type HistorySyncOptions = {
  config: PublicConfig | null
  initialScope: 'local' | 'shared'
  sessionMode?: 'realtime' | 'multilingual'
  transientErrorMs?: number
}

export type HistorySync = {
  history: HistoryEntry[]
  sharedHistory: HistoryEntry[]
  historyScope: 'local' | 'shared'
  setHistoryScope: (scope: 'local' | 'shared') => void
  sharedHistoryLoading: boolean
  sharedHistoryLoadingMore: boolean
  sharedHistoryHasMore: boolean
  sharedHistoryError: string
  failedHistorySyncIDs: string[]
  historySyncing: boolean
  historyAudioRevision: number
  sharedDates: HistoryDateCount[]
  selectedDate: string | null
  selectDate: (date: string | null) => void
  sharedUploaderFilter: string | null
  selectSharedUploader: (email: string | null) => void
  recordSession: (entry: HistoryEntry, audio: HistoryAudioArchive) => void
  waitForAudioSave: (id: string) => Promise<void>
  clearHistory: () => void
  deleteHistoryEntries: (entries: HistoryEntry[], scope: 'local' | 'shared') => Promise<void>
  showSharedHistory: (date?: string | null) => Promise<void>
  loadMoreSharedHistory: () => Promise<void>
  findSharedHistoryByTraceID: (traceID: string) => Promise<boolean>
  retryHistorySync: () => Promise<void>
}

const SHARED_HISTORY_PAGE_SIZE = 10

export function useHistorySync({ config, initialScope, sessionMode, transientErrorMs = 0 }: HistorySyncOptions): HistorySync {
  // The uploader is captured server-side at upload time; this browser's local
  // records are stamped with the same email so a guest→login transition can
  // re-attribute the earlier guest uploads (see the claim effect below).
  const { user } = useAnnotationIdentity()
  const uploaderEmail = user?.normalizedEmail?.trim() ?? ''
  const uploaderEmailRef = useRef(uploaderEmail)
  uploaderEmailRef.current = uploaderEmail

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory)
  const [sharedHistory, setSharedHistory] = useState<HistoryEntry[]>([])
  const [historyScope, setHistoryScope] = useState<'local' | 'shared'>(initialScope)
  const [sharedHistoryLoading, setSharedHistoryLoading] = useState(false)
  const [sharedHistoryLoadingMore, setSharedHistoryLoadingMore] = useState(false)
  const [sharedHistoryHasMore, setSharedHistoryHasMore] = useState(false)
  const [sharedHistoryError, setSharedHistoryError] = useState('')
  const [failedHistorySyncIDs, setFailedHistorySyncIDs] = useState<string[]>([])
  const [historySyncing, setHistorySyncing] = useState(false)
  const [historyAudioRevision, setHistoryAudioRevision] = useState(0)
  const [sharedDates, setSharedDates] = useState<HistoryDateCount[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [sharedUploaderFilter, setSharedUploaderFilter] = useState<string | null>(null)

  const historyRef = useRef(history)
  const failedHistorySyncIDsRef = useRef<string[]>([])
  const historyBackfillStartedRef = useRef(false)
  const sharedHistoryInitialLoadStartedRef = useRef(false)
  const sharedHistoryRequestSeqRef = useRef(0)
  const selectedDateRef = useRef<string | null>(null)
  const sharedUploaderFilterRef = useRef<string | null>(null)
  const sharedRealtimeOffsetRef = useRef(0)
  const sharedBatchOffsetRef = useRef(0)
  const sharedRealtimeHasMoreRef = useRef(true)
  const sharedBatchHasMoreRef = useRef(true)
  const audioSavePromisesRef = useRef(new Map<string, Promise<void>>())

  useEffect(() => {
    if (!sharedHistoryError || transientErrorMs <= 0) return undefined
    const timer = window.setTimeout(() => setSharedHistoryError(''), transientErrorMs)
    return () => window.clearTimeout(timer)
  }, [sharedHistoryError, transientErrorMs])

  const persistLocalHistory = (next: HistoryEntry[]) => {
    try {
      const persisted = saveHistory(next)
      historyRef.current = persisted
      setHistory(persisted)
      return persisted
    } catch (caught) {
      setSharedHistoryError(caught instanceof Error ? caught.message : '浏览器无法保存本次历史文本。')
      return null
    }
  }

  useEffect(() => {
    if (!config?.historySharing || historyBackfillStartedRef.current) return
    historyBackfillStartedRef.current = true
    let cancelled = false
    void (async () => {
      const failedIDs: string[] = []
      const syncedIDs: string[] = []
      for (const entry of historyRef.current) {
        if (entry.synced) continue
        try {
          const result = await uploadHistoryEntry(entry)
          if (result.failedKinds.length > 0) failedIDs.push(entry.id)
          else syncedIDs.push(entry.id)
        } catch {
          failedIDs.push(entry.id)
        }
      }
      if (syncedIDs.length > 0) {
        const syncedSet = new Set(syncedIDs)
        const email = uploaderEmailRef.current
        const next = historyRef.current.map((entry) => (syncedSet.has(entry.id) && !entry.synced ? { ...entry, synced: true, uploaderEmail: email || undefined } : entry))
        persistLocalHistory(next)
      }
      if (cancelled) return
      failedHistorySyncIDsRef.current = failedIDs
      setFailedHistorySyncIDs(failedIDs)
    })()
    return () => {
      cancelled = true
    }
  }, [config?.historySharing])

  // Claim earlier guest uploads once the viewer logs in. Records this browser
  // synced while signed out carry no (or a different) uploader; re-POSTing them
  // lets the backend re-tag each with the now-authenticated email from the
  // login cookie, so they stop showing as 游客 in the shared view. Best-effort:
  // a failed record stays guest and is retried on the next login.
  useEffect(() => {
    const email = uploaderEmail
    if (!email || !config?.historySharing) return
    const targets = historyRef.current.filter((entry) => entry.synced && (entry.uploaderEmail ?? '') !== email)
    if (targets.length === 0) return
    let cancelled = false
    void (async () => {
      const claimedIDs: string[] = []
      for (const entry of targets) {
        if (cancelled) return
        try {
          await uploadHistoryEntry(entry)
          claimedIDs.push(entry.id)
        } catch {
          // Leave unclaimed; the next login re-attempts.
        }
      }
      if (cancelled || claimedIDs.length === 0) return
      const claimedSet = new Set(claimedIDs)
      const next = historyRef.current.map((entry) => (claimedSet.has(entry.id) ? { ...entry, uploaderEmail: email } : entry))
      persistLocalHistory(next)
      // Refresh the shared view if it is open so the re-attribution shows.
      window.dispatchEvent(new Event('simultrans:history-updated'))
    })()
    return () => {
      cancelled = true
    }
  }, [uploaderEmail, config?.historySharing])

  const markHistorySynced = (id: string) => {
    if (!historyRef.current.some((entry) => entry.id === id && !entry.synced)) return
    const email = uploaderEmailRef.current
    const next = historyRef.current.map((entry) => (entry.id === id ? { ...entry, synced: true, uploaderEmail: email || undefined } : entry))
    persistLocalHistory(next)
  }

  const recordSession = (entry: HistoryEntry, audioArchive: HistoryAudioArchive) => {
    const next = [entry, ...historyRef.current]
    const persisted = persistLocalHistory(next)
    if (!persisted?.some((item) => item.id === entry.id)) return
    const savedEntry = persisted.find((item) => item.id === entry.id)
    if (
      savedEntry
      && (savedEntry.diagnosticEvents?.length ?? 0) < (entry.diagnosticEvents?.length ?? 0)
    ) {
      setSharedHistoryError('历史文本已保存；因浏览器空间有限，本机诊断事件已精简。')
    }
    const localAudioSave = saveHistoryAudio(entry.id, audioArchive)
      .then(() => setHistoryAudioRevision((revision) => revision + 1))
      .catch(() => setSharedHistoryError('文本记录已保存，但浏览器未能持久化本次音频。'))
    audioSavePromisesRef.current.set(entry.id, localAudioSave)
    if (config?.historySharing) {
      // Finish the durable local write before starting the remote upload. If
      // navigation interrupts the PUT, the next page load can retry from IDB.
      void localAudioSave.then(() => uploadHistoryEntry(entry, audioArchive)).then((result) => {
        if (result.failedKinds.length === 0) markHistorySynced(entry.id)
        setSharedHistory((current) => [result.entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 100))
        const nextIDs = result.failedKinds.length > 0
          ? [...new Set([...failedHistorySyncIDsRef.current, entry.id])]
          : failedHistorySyncIDsRef.current.filter((id) => id !== entry.id)
        failedHistorySyncIDsRef.current = nextIDs
        setFailedHistorySyncIDs(nextIDs)
      }).catch((caught) => {
        const nextIDs = [...new Set([...failedHistorySyncIDsRef.current, entry.id])]
        failedHistorySyncIDsRef.current = nextIDs
        setFailedHistorySyncIDs(nextIDs)
        setSharedHistoryError(caught instanceof Error ? caught.message : '本次记录已保存在本机，但同步 OSS 失败。')
      })
    }
  }

  const waitForAudioSave = async (id: string) => {
    const pending = audioSavePromisesRef.current.get(id)
    if (!pending) return
    await pending
    if (audioSavePromisesRef.current.get(id) === pending) audioSavePromisesRef.current.delete(id)
  }

  const clearHistory = () => {
    const ids = historyRef.current.map((entry) => entry.id)
    historyRef.current = []
    setHistory([])
    try {
      saveHistory([])
    } catch {
      // Removing an absent localStorage key cannot make the visible clear fail.
    }
    void deleteHistoryAudio(ids).catch(() => undefined)
  }

  const deleteHistoryEntries = async (entries: HistoryEntry[], scope: 'local' | 'shared') => {
    if (entries.length === 0) return
    if (scope === 'shared') {
      await Promise.all(entries.map(deleteSharedHistoryEntry))
      const deleted = new Set(entries.map((entry) => `${entry.id}\u0000${entry.createdAt}`))
      setSharedHistory((current) => current.filter((entry) => !deleted.has(`${entry.id}\u0000${entry.createdAt}`)))
      const counts = new Map<string, number>()
      for (const entry of entries) {
        const date = localDateOf(entry.createdAt)
        counts.set(date, (counts.get(date) ?? 0) + 1)
      }
      setSharedDates((current) => current
        .map((item) => ({ ...item, count: Math.max(0, item.count - (counts.get(item.date) ?? 0)) }))
        .filter((item) => item.count > 0))
      return
    }
    const deleted = new Set(entries.map((entry) => `${entry.id}\u0000${entry.createdAt}`))
    const ids = [...new Set(entries.map((entry) => entry.id))]
    const next = historyRef.current.filter((entry) => !deleted.has(`${entry.id}\u0000${entry.createdAt}`))
    if (!persistLocalHistory(next)) throw new Error('本机历史删除失败')
    await deleteHistoryAudio(ids).catch(() => setSharedHistoryError('历史记录已删除，但本机音频缓存清理失败。'))
    const nextFailedIDs = failedHistorySyncIDsRef.current.filter((id) => !ids.includes(id))
    failedHistorySyncIDsRef.current = nextFailedIDs
    setFailedHistorySyncIDs(nextFailedIDs)
  }

  const showSharedHistoryPage = async (date?: string | null, append = false) => {
    setHistoryScope('shared')
    if (!config?.historySharing && !config?.benchmarkSharing) {
      setSharedHistoryError('共享历史与线上批量评测尚未配置 OSS。')
      return
    }
    const activeDate = date ?? null
    const activeUploader = sharedUploaderFilterRef.current
    selectedDateRef.current = activeDate
    setSelectedDate(activeDate)
    if (!append) {
      sharedRealtimeOffsetRef.current = 0
      sharedBatchOffsetRef.current = 0
      sharedRealtimeHasMoreRef.current = Boolean(config?.historySharing)
      sharedBatchHasMoreRef.current = Boolean(config?.benchmarkSharing) && activeUploader === null
      setSharedHistoryHasMore(false)
    }
    // The date sidebar counts are independent of which day is open; refresh them
    // only on a full (all-days) load so per-day drilldowns stay cheap.
    if (!activeDate) {
      void fetchSharedHistoryDates(config).then(setSharedDates).catch(() => setSharedDates([]))
    }
    const historyParams = new URLSearchParams({
      limit: String(SHARED_HISTORY_PAGE_SIZE),
      offset: String(sharedRealtimeOffsetRef.current),
    })
    if (sessionMode) historyParams.set('sessionMode', sessionMode)
    const benchmarkParams = new URLSearchParams({
      limit: String(SHARED_HISTORY_PAGE_SIZE),
      offset: String(sharedBatchOffsetRef.current),
    })
    if (activeDate) {
      const tz = String(clientTZOffset())
      historyParams.set('date', activeDate)
      historyParams.set('tz', tz)
      benchmarkParams.set('date', activeDate)
      benchmarkParams.set('tz', tz)
    }
    if (activeUploader !== null) {
      historyParams.set('uploaderEmail', activeUploader)
    }
    const historyURL = `/api/history?${historyParams}`
    const benchmarkURL = `/api/benchmark/results?${benchmarkParams}`
    const requestSeq = ++sharedHistoryRequestSeqRef.current
    if (append) setSharedHistoryLoadingMore(true)
    else setSharedHistoryLoading(true)
    setSharedHistoryError('')
    try {
      const [realtimeResponse, batchResponse] = await Promise.all([
        config?.historySharing && sharedRealtimeHasMoreRef.current ? historyFetch(historyURL) : Promise.resolve(null),
        config?.benchmarkSharing && sharedBatchHasMoreRef.current ? apiFetch(benchmarkURL) : Promise.resolve(null),
      ])
      if (realtimeResponse && !realtimeResponse.ok) throw new Error('读取实时同传历史失败')
      if (batchResponse && !batchResponse.ok) throw new Error('读取批量评测历史失败')
      const realtimeValue = realtimeResponse
        ? await realtimeResponse.json() as { items?: unknown; hasMore?: boolean }
        : { items: [], hasMore: false }
      const batchValue = batchResponse
        ? await batchResponse.json() as { items?: unknown; hasMore?: boolean }
        : { items: [], hasMore: false }
      if (requestSeq !== sharedHistoryRequestSeqRef.current) return
      const realtimeItems = Array.isArray(realtimeValue.items) ? realtimeValue.items : []
      const batchItems = Array.isArray(batchValue.items) ? batchValue.items : []
      const nextPage = mergeSharedHistory(normalizeHistory(realtimeItems), normalizeBatchHistory(batchItems))
      sharedRealtimeOffsetRef.current += realtimeItems.length
      sharedBatchOffsetRef.current += batchItems.length
      sharedRealtimeHasMoreRef.current = realtimeResponse !== null && realtimeValue.hasMore === true
      sharedBatchHasMoreRef.current = batchResponse !== null && batchValue.hasMore === true
      setSharedHistoryHasMore(sharedRealtimeHasMoreRef.current || sharedBatchHasMoreRef.current)
      setSharedHistory((current) => append ? mergeSharedHistory(current, nextPage) : nextPage)
    } catch {
      if (requestSeq !== sharedHistoryRequestSeqRef.current) return
      setSharedHistoryError('读取 OSS 全部记录失败，请稍后重试。')
    } finally {
      if (requestSeq === sharedHistoryRequestSeqRef.current) {
        setSharedHistoryLoading(false)
        setSharedHistoryLoadingMore(false)
      }
    }
  }

  const showSharedHistory = (date?: string | null) => showSharedHistoryPage(date, false)

  const loadMoreSharedHistory = () => {
    if (!sharedHistoryHasMore || sharedHistoryLoading || sharedHistoryLoadingMore) return Promise.resolve()
    return showSharedHistoryPage(selectedDateRef.current, true)
  }

  const findSharedHistoryByTraceID = async (traceID: string) => {
    if (!config?.historySharing) {
      setSharedHistoryError('共享历史尚未配置，无法按 Trace ID 查询。')
      return false
    }
    sharedUploaderFilterRef.current = null
    setSharedUploaderFilter(null)
    setSharedHistoryError('')
    try {
      const entries = await fetchSharedHistoryByTraceID(traceID)
      if (entries.length === 0) {
        setSharedHistoryError('没有找到该 Trace ID 对应的同传记录。')
        return false
      }
      setSharedHistory((current) => mergeSharedHistory(current, entries))
      return true
    } catch (caught) {
      setSharedHistoryError(caught instanceof Error ? caught.message : '按 Trace ID 查询失败。')
      return false
    }
  }

  const selectDate = (date: string | null) => {
    selectedDateRef.current = date
    setSelectedDate(date)
    // Shared records live on the backend, so drilling into a day refetches it;
    // local records are already in memory and get filtered in the view.
    if (historyScope === 'shared') void showSharedHistory(date)
  }

  const selectSharedUploader = (email: string | null) => {
    if (sharedUploaderFilterRef.current === email) return
    sharedUploaderFilterRef.current = email
    setSharedUploaderFilter(email)
    selectedDateRef.current = null
    setSelectedDate(null)
    if (historyScope === 'shared') void showSharedHistoryPage(null, false)
  }

  const changeHistoryScope = (scope: 'local' | 'shared') => {
    setHistoryScope(scope)
    selectedDateRef.current = null
    setSelectedDate(null)
    sharedUploaderFilterRef.current = null
    setSharedUploaderFilter(null)
  }

  useEffect(() => {
    if (initialScope !== 'shared' || !config || sharedHistoryInitialLoadStartedRef.current) return
    sharedHistoryInitialLoadStartedRef.current = true
    void showSharedHistory()
  }, [config, initialScope])

  useEffect(() => {
    if (historyScope !== 'shared') return
    const refreshSharedHistory = () => void showSharedHistory(selectedDateRef.current)
    window.addEventListener('simultrans:history-updated', refreshSharedHistory)
    return () => window.removeEventListener('simultrans:history-updated', refreshSharedHistory)
  }, [historyScope, config?.historySharing, config?.benchmarkSharing])

  const retryHistorySync = async () => {
    if (historySyncing || failedHistorySyncIDs.length === 0) return
    const pendingIDs = new Set(failedHistorySyncIDs)
    const pendingEntries = historyRef.current.filter((entry) => pendingIDs.has(entry.id))
    setHistorySyncing(true)
    setSharedHistoryError(`正在重试 ${pendingEntries.length} 条本机记录的音频同步…`)
    const remaining: string[] = []
    for (const entry of pendingEntries) {
      try {
        const result = await uploadHistoryEntry(entry)
        setSharedHistory((current) => [result.entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 100))
        if (result.failedKinds.length > 0) remaining.push(entry.id)
        else markHistorySynced(entry.id)
      } catch {
        remaining.push(entry.id)
      }
    }
    failedHistorySyncIDsRef.current = remaining
    setFailedHistorySyncIDs(remaining)
    setSharedHistoryError(remaining.length > 0 ? '' : '本机历史及音频已全部同步到后端与 OSS。')
    setHistorySyncing(false)
  }

  return {
    history,
    sharedHistory,
    historyScope,
    setHistoryScope: changeHistoryScope,
    sharedHistoryLoading,
    sharedHistoryLoadingMore,
    sharedHistoryHasMore,
    sharedHistoryError,
    failedHistorySyncIDs,
    historySyncing,
    historyAudioRevision,
    sharedDates,
    selectedDate,
    selectDate,
    sharedUploaderFilter,
    selectSharedUploader,
    recordSession,
    waitForAudioSave,
    clearHistory,
    deleteHistoryEntries,
    showSharedHistory,
    loadMoreSharedHistory,
    findSharedHistoryByTraceID,
    retryHistorySync,
  }
}
