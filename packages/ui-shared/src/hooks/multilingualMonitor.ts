import type { PCMStreamPlayer } from '../audio'

export type MultilingualMonitorState = { error: string; switching: boolean }

/** Owns only the optional local branch; a failure must never stop primary audio. */
export function createMultilingualMonitor(
  publish: (state: MultilingualMonitorState) => void,
  initialDeviceId: string | null = null,
  initialVolume = 1,
  initiallySupported = true,
) {
  let deviceId = initialDeviceId
  let volume = normalizeMonitorVolume(initialVolume)
  let supported = initiallySupported
  let players: PCMStreamPlayer[] = []
  let revision = 0
  let state: MultilingualMonitorState = { error: '', switching: false }

  const update = (next: MultilingualMonitorState) => { state = next; publish(next) }
  const detach = (targets: readonly PCMStreamPlayer[]) => Promise.allSettled(targets.map(async (player) => {
    await player.setMonitorOutput?.(null)
  }))
  const apply = async (): Promise<boolean> => {
    const operation = ++revision
    const targets = [...players]
    const selected = deviceId
    const current = () => operation === revision
    if (selected && !supported) {
      await detach(targets)
      if (current()) update({ error: '本地监听暂仅支持 WebSocket 同传。', switching: false })
      return false
    }
    if (!selected || targets.length === 0) {
      // Cancel pending setup immediately, including while paused or ending.
      const cleanup = detach(targets)
      // Clearing a failed selection (or releasing a paused session) must not
      // erase the error before the page can explain why monitoring stopped.
      update({ error: state.error, switching: false })
      await cleanup
      return current()
    }
    update({ error: '', switching: true })
    let runtimeFailed = false
    const reportFailure = (message: string) => {
      if (!current()) return
      runtimeFailed = true
      // One failed language must not leave the others unexpectedly audible.
      // Keep the preference so the user can explicitly retry or resume.
      void detach(targets)
      update({ error: message || '本地监听不可用，主输出仍在继续。', switching: false })
    }
    const results = await Promise.allSettled(targets.map(async (player) => {
      if (!player.setMonitorOutput || !player.setMonitorVolume) {
        throw new Error('当前音频线路不支持本地监听。')
      }
      player.setMonitorVolume(volume)
      await player.setMonitorOutput(selected, reportFailure)
    }))
    if (!current()) return false
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure || runtimeFailed) {
      if (failure) reportFailure(failure.reason instanceof Error ? failure.reason.message : '本地监听不可用，主输出仍在继续。')
      return false
    }
    update({ error: '', switching: false })
    return true
  }

  return {
    configure: (nextDeviceId: string | null) => {
      deviceId = nextDeviceId?.trim() || null
      if (deviceId) state = { error: '', switching: false }
      return apply()
    },
    setVolume: (nextVolume: number) => {
      volume = normalizeMonitorVolume(nextVolume)
      players.forEach((player) => player.setMonitorVolume?.(volume))
    },
    setSupported: (next: boolean) => {
      if (next === supported) return
      supported = next
      void apply()
    },
    setPlayers: (next: readonly PCMStreamPlayer[]) => {
      if (next.length === players.length && next.every((player, index) => player === players[index])) return
      const removed = players.filter((player) => !next.includes(player))
      players = [...next]
      // apply() fences old callbacks before any asynchronous detach settles.
      const pending = apply()
      void detach(removed)
      void pending
    },
    getState: () => state,
  }
}

export function normalizeMonitorVolume(volume: number) {
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1
}
