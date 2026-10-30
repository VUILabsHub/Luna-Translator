/** Refresh titles without opening records or triggering paid model generation. */
export function pollPendingHistoryTitles<T extends { id: string; title?: string; titleStatus?: string }>({
  ids, read, update,
}: { ids: string[]; read: () => Promise<T[] | null>; update: (records: T[]) => void }): () => void {
  if (!ids.length) return () => {}
  const pending = new Set(ids)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => { stopped = true; if (timer !== undefined) clearTimeout(timer); clearTimeout(deadline) }
  const deadline = setTimeout(stop, 30_000)
  const refresh = async () => {
    try {
      const records = await read()
      if (stopped) return
      if (records) {
        update(records.filter(record => pending.has(record.id)))
        for (const id of pending) {
          if (records.find(record => record.id === id)?.titleStatus !== 'pending') pending.delete(id)
        }
      }
    } catch { /* Keep the usable list on transient failures. */ }
    if (stopped || !pending.size) { stop(); return }
    timer = setTimeout(() => { void refresh() }, 2000)
  }
  timer = setTimeout(() => { void refresh() }, 2000)
  return stop
}
