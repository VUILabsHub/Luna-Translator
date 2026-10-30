import type { RTCStatsArchive } from './webrtcStats'
import { pcmChunksToWav } from './audio'

export type HistoryAudioArchive = {
  input?: Blob
  /** Filtered model input on the source clock; removed spans are silence. */
  modelInput?: Blob
  output?: Blob
  outputs?: Record<string, Blob>
  // Best-effort telemetry, uploaded once at session end via uploadHistoryEntry.
  // Deliberately NOT persisted to IndexedDB and NOT retried on backfill.
  rtcStats?: RTCStatsArchive
}

/** Archives are canonical PCM16 WAV: a 44-byte header alone is not audio. */
export function hasHistoryAudioSamples(blob: Blob | undefined): blob is Blob {
  return Boolean(blob && blob.size >= 46)
}

// Inspect only complete canonical PCM16 WAVs already held locally. Unknown,
// unreadable or larger files stay available; this never fetches remote audio.
const SILENCE_SCAN_MAX_BYTES = 64 * 1024 * 1024
const SILENCE_SCAN_CHUNK_BYTES = 64 * 1024
const silentWAVs = new WeakMap<Blob, Promise<boolean>>()
let silenceScanQueue: Promise<unknown> = Promise.resolve()

export function isStrictlySilentPCM16Wav(blob: Blob): Promise<boolean> {
  const cached = silentWAVs.get(blob)
  if (cached) return cached
  // Serialize scans across capture/save/read so several output languages do
  // not allocate/decode whole recordings at once. Immutable Blob identity is
  // the cache key: a later, longer recording must be inspected independently.
  const result = silenceScanQueue.then(async () => {
    try {
      if (blob.size < 46 || blob.size > SILENCE_SCAN_MAX_BYTES) return false
      const header = new Uint8Array(await blob.slice(0, 44).arrayBuffer())
      if (header.length !== 44) return false
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const tag = (offset: number, value: string) => [...value].every((char, index) => header[offset + index] === char.charCodeAt(0))
      const channels = view.getUint16(22, true)
      const rate = view.getUint32(24, true)
      const alignment = view.getUint16(32, true)
      const dataBytes = view.getUint32(40, true)
      if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
        || view.getUint32(4, true) !== blob.size - 8 || view.getUint32(16, true) !== 16
        || view.getUint16(20, true) !== 1 || view.getUint16(34, true) !== 16
        || channels === 0 || rate === 0 || alignment !== channels * 2
        || view.getUint32(28, true) !== rate * alignment
        || dataBytes !== blob.size - 44 || dataBytes === 0 || dataBytes % alignment !== 0) return false
      for (let offset = 44; offset < blob.size; offset += SILENCE_SCAN_CHUNK_BYTES) {
        const end = Math.min(blob.size, offset + SILENCE_SCAN_CHUNK_BYTES)
        const pcm = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
        if (pcm.length !== end - offset || pcm.some((byte) => byte !== 0)) return false
      }
      return true
    } catch {
      return false
    }
  })
  silentWAVs.set(blob, result)
  silenceScanQueue = result
  return result
}

/** Preserve any nonzero sample, even amplitude 1; ASR text is deliberately irrelevant. */
export async function filterSilentHistoryAudio(archive: HistoryAudioArchive): Promise<HistoryAudioArchive> {
  const filtered = { ...archive }
  for (const kind of ['input', 'modelInput', 'output'] as const) {
    if (filtered[kind] && await isStrictlySilentPCM16Wav(filtered[kind])) filtered[kind] = undefined
  }
  if (archive.outputs) {
    filtered.outputs = {}
    for (const [language, blob] of Object.entries(archive.outputs)) {
      if (!await isStrictlySilentPCM16Wav(blob)) filtered.outputs[language] = blob
    }
  }
  return filtered
}

const DATABASE_NAME = 'simultrans-history-audio'
const DATABASE_VERSION = 2
const STORE_NAME = 'sessions'
const PCM_STORE_NAME = 'pcmChunks'
const PCM_SESSION_INDEX = 'sessionId'
const PCM_FLUSH_BYTES = 32_000
const PCM_FLUSH_MS = 1_000

type HistoryPCMKind = 'input' | 'output' | `output-${string}`
type PendingPCMJournal = {
  id: string
  kind: HistoryPCMKind
  sampleRate: number
  chunks: Uint8Array[]
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
  write: Promise<void>
}

type StoredPCMChunk = {
  sequence?: number
  sessionId: string
  kind: HistoryPCMKind
  sampleRate: number
  audio: Blob
}

const pendingPCM = new Map<string, PendingPCMJournal>()

export function queueHistoryPCMChunk(id: string, kind: HistoryPCMKind, chunk: Uint8Array, sampleRate: number) {
  if (!id || chunk.byteLength === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return
  const key = `${id}:${kind}`
  let pending = pendingPCM.get(key)
  if (!pending) {
    pending = { id, kind, sampleRate, chunks: [], bytes: 0, timer: null, write: Promise.resolve() }
    pendingPCM.set(key, pending)
  }
  pending.sampleRate = sampleRate
  pending.chunks.push(chunk.slice())
  pending.bytes += chunk.byteLength
  if (pending.bytes >= PCM_FLUSH_BYTES) {
    void flushPendingPCM(pending).catch(() => undefined)
  } else if (pending.timer === null) {
    pending.timer = setTimeout(() => {
      pending!.timer = null
      void flushPendingPCM(pending!).catch(() => undefined)
    }, PCM_FLUSH_MS)
  }
}

export async function flushHistoryAudioJournal(id: string) {
  const writes: Promise<void>[] = []
  for (const pending of pendingPCM.values()) {
    if (pending.id === id) writes.push(flushPendingPCM(pending))
  }
  await Promise.all(writes)
}

async function flushPendingPCM(pending: PendingPCMJournal) {
  if (pending.timer !== null) {
    clearTimeout(pending.timer)
    pending.timer = null
  }
  if (pending.chunks.length === 0) {
    await pending.write
    return
  }
  const audio = new Blob(pending.chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer), { type: 'application/octet-stream' })
  pending.chunks = []
  pending.bytes = 0
  const write = pending.write.catch(() => undefined).then(async () => {
    const database = await openDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(PCM_STORE_NAME, 'readwrite')
        transaction.objectStore(PCM_STORE_NAME).add({
          sessionId: pending.id,
          kind: pending.kind,
          sampleRate: pending.sampleRate,
          audio,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error || new Error('保存历史音频分片失败'))
        transaction.onabort = () => reject(transaction.error || new Error('保存历史音频分片失败'))
      })
    } finally {
      database.close()
    }
  })
  pending.write = write
  await write
}

export async function saveHistoryAudio(id: string, archive: HistoryAudioArchive) {
  if (!archive.input && !archive.output && Object.keys(archive.outputs || {}).length === 0) return
  // The complete in-memory archive is authoritative at normal session end.
  // A failed checkpoint must not prevent this final durable write.
  await flushHistoryAudioJournal(id).catch(() => undefined)
  const filtered = await filterSilentHistoryAudio(archive)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite')
      transaction.objectStore(STORE_NAME).put({ id, input: filtered.input, output: filtered.output, outputs: filtered.outputs })
      deletePCMChunks(transaction.objectStore(PCM_STORE_NAME), id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('保存历史音频失败'))
      transaction.onabort = () => reject(transaction.error || new Error('保存历史音频失败'))
    })
    for (const key of pendingPCM.keys()) {
      if (key.startsWith(`${id}:`)) pendingPCM.delete(key)
    }
  } finally {
    database.close()
  }
}

export async function loadHistoryAudio(id: string): Promise<HistoryAudioArchive> {
  const database = await openDatabase()
  let value: unknown
  try {
    value = await runRequest(database, 'readonly', (store) => store.get(id))
  } finally {
    database.close()
  }
  const record = value && typeof value === 'object'
    ? value as { input?: unknown; output?: unknown; outputs?: unknown }
    : {}
  const outputs = record.outputs && typeof record.outputs === 'object'
    ? Object.fromEntries(Object.entries(record.outputs).filter((entry): entry is [string, Blob] => entry[1] instanceof Blob))
    : undefined
  const archive: HistoryAudioArchive = {
    input: record.input instanceof Blob ? record.input : undefined,
    output: record.output instanceof Blob ? record.output : undefined,
    outputs,
  }
  const chunks = await loadPCMChunks(id)
  for (const kind of ['input', 'output'] as const) {
    if (archive[kind]) continue
    const matching = chunks.filter((chunk) => chunk.kind === kind && chunk.audio instanceof Blob)
    if (matching.length === 0) continue
    const pcm = new Uint8Array(await new Blob(matching.map((chunk) => chunk.audio)).arrayBuffer())
    archive[kind] = pcmChunksToWav([pcm], matching[0].sampleRate)
  }
  const languages = [...new Set(chunks.flatMap((chunk) => (
    chunk.kind.startsWith('output-') ? [chunk.kind.slice('output-'.length)] : []
  )))]
  for (const language of languages) {
    if (archive.outputs?.[language]) continue
    const matching = chunks.filter((chunk) => chunk.kind === `output-${language}` && chunk.audio instanceof Blob)
    if (matching.length === 0) continue
    const pcm = new Uint8Array(await new Blob(matching.map((chunk) => chunk.audio)).arrayBuffer())
    archive.outputs = { ...archive.outputs, [language]: pcmChunksToWav([pcm], matching[0].sampleRate) }
  }
  return filterSilentHistoryAudio(archive)
}

export async function deleteHistoryAudio(ids: string[]) {
  if (ids.length === 0) return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const pcmStore = transaction.objectStore(PCM_STORE_NAME)
      ids.forEach((id) => {
        store.delete(id)
        deletePCMChunks(pcmStore, id)
        for (const key of pendingPCM.keys()) {
          if (key.startsWith(`${id}:`)) pendingPCM.delete(key)
        }
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('删除历史音频失败'))
      transaction.onabort = () => reject(transaction.error || new Error('删除历史音频失败'))
    })
  } finally {
    database.close()
  }
}

export function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(PCM_STORE_NAME)) {
        const store = database.createObjectStore(PCM_STORE_NAME, { keyPath: 'sequence', autoIncrement: true })
        store.createIndex(PCM_SESSION_INDEX, 'sessionId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开历史音频存储失败'))
  })
}

export function runRequest(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
) {
  return new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onerror = () => reject(request.error || new Error('历史音频存储操作失败'))
    transaction.onabort = () => reject(transaction.error || new Error('历史音频存储事务失败'))
    if (mode === 'readonly') {
      request.onsuccess = () => resolve(request.result)
    } else {
      let result: unknown
      request.onsuccess = () => { result = request.result }
      transaction.oncomplete = () => resolve(result)
    }
  })
}

async function loadPCMChunks(id: string): Promise<StoredPCMChunk[]> {
  const database = await openDatabase()
  try {
    return await new Promise<StoredPCMChunk[]>((resolve, reject) => {
      const transaction = database.transaction(PCM_STORE_NAME, 'readonly')
      const request = transaction.objectStore(PCM_STORE_NAME).index(PCM_SESSION_INDEX).getAll(IDBKeyRange.only(id))
      request.onsuccess = () => resolve((request.result as StoredPCMChunk[]).sort((left, right) => (left.sequence || 0) - (right.sequence || 0)))
      request.onerror = () => reject(request.error || new Error('读取历史音频分片失败'))
      transaction.onabort = () => reject(transaction.error || new Error('读取历史音频分片失败'))
    })
  } finally {
    database.close()
  }
}

function deletePCMChunks(store: IDBObjectStore, id: string) {
  const request = store.index(PCM_SESSION_INDEX).openKeyCursor(IDBKeyRange.only(id))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    store.delete(cursor.primaryKey)
    cursor.continue()
  }
}
