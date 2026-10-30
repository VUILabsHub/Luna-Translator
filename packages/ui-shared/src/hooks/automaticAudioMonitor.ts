import {
  hasExplicitMonitorOutputId,
  monitorOutputConflict,
  resolveAutomaticAudioMonitor,
  type AudioMonitorDevice,
} from '../lib/audioMonitorDevices'

export type AutomaticAudioMonitorState = {
  /** auto follows a recognized shared-audio route; empty means explicitly off. */
  choice: string
  deviceId: string | null
  notice: string
}

export type AutomaticAudioMonitorSnapshot = {
  mainDeviceId: string
  inputDeviceId: string
  rawDevices: readonly AudioMonitorDevice[]
  available: boolean
  initialized: boolean
}

type DesiredMonitor = { deviceId: string | null; key: string; notice: string }

/**
 * Owns the optional headphone route only. configure(null) must cancel any
 * pending sink setup, as createMultilingualMonitor already does. Revisions
 * prevent a late setup completion from restoring an obsolete UI selection.
 */
export function createAutomaticAudioMonitor(
  configure: (deviceId: string | null) => Promise<boolean>,
  publish: (state: AutomaticAudioMonitorState) => void,
) {
  let state: AutomaticAudioMonitorState = { choice: 'auto', deviceId: null, notice: '' }
  let publishedState = state
  let snapshot: AutomaticAudioMonitorSnapshot | null = null
  let revision = 0
  let suspended = false
  let requestedDeviceId: string | null = null
  let requestedKey = ''
  let pending: Promise<void> = Promise.resolve()
  let failureKey: string | null = null
  let failureNotice = ''

  const updateState = (next: AutomaticAudioMonitorState) => {
    state = next
    if (publishedState.choice === next.choice && publishedState.deviceId === next.deviceId && publishedState.notice === next.notice) return
    publishedState = next
    publish({ ...next })
  }

  const desiredMonitor = (): DesiredMonitor => {
    if (!snapshot || !snapshot.initialized || state.choice === '') return { deviceId: null, key: '', notice: '' }
    if (!snapshot.available) {
      return { deviceId: null, key: '', notice: state.choice === 'auto' ? '' : '当前设备模式不支持本地监听。' }
    }
    const { mainDeviceId, inputDeviceId, rawDevices } = snapshot
    const automatic = resolveAutomaticAudioMonitor({ mainDeviceId, inputDeviceId, rawDevices })
    if (state.choice === 'auto') {
      if (automatic.reason === 'inactive') return { deviceId: null, key: '', notice: '' }
      if (!automatic.deviceId) {
        return {
          deviceId: null,
          key: '',
          notice: automatic.reason === 'ambiguous'
            ? '已检测到共享声音和多副耳机，请选择用于本地监听的耳机。'
            : '已检测到共享声音，请连接耳机或选择本地监听设备。',
        }
      }
      const device = rawDevices.find(item => item.kind === 'audiooutput' && item.deviceId === automatic.deviceId)
      return {
        deviceId: automatic.deviceId,
        key: JSON.stringify([automatic.routeKey, automatic.deviceId]),
        notice: `已自动开启本地监听：${device?.label || '耳机'}。`,
      }
    }

    const selected = rawDevices.find(item => item.kind === 'audiooutput' && item.deviceId === state.choice)
    if (!selected || !hasExplicitMonitorOutputId(selected)) {
      return { deviceId: null, key: '', notice: '监听设备已断开，请重新选择监听耳机。' }
    }
    if (monitorOutputConflict({ monitorDeviceId: selected.deviceId, mainDeviceId, rawDevices })) {
      return { deviceId: null, key: '', notice: '播放设备已包含监听设备，已关闭额外监听，避免重复播放。' }
    }
    const main = rawDevices.find(item => item.kind === 'audiooutput' && item.deviceId === (mainDeviceId || 'default'))
    return {
      deviceId: selected.deviceId,
      key: JSON.stringify([mainDeviceId, main?.groupId || '', main?.label || '', selected.deviceId]),
      notice: '',
    }
  }

  const disconnect = (notice: string, emit = true): Promise<void> => {
    // Fence both failed operations and the currently selected sink before any
    // asynchronous cleanup can settle. Clearing an already clear sink is free.
    ++revision
    const hadRequestedDevice = requestedDeviceId !== null
    requestedDeviceId = null
    requestedKey = ''
    if (emit) updateState({ ...state, deviceId: null, notice })
    else state = { ...state, deviceId: null, notice }
    if (!hadRequestedDevice) return Promise.resolve()
    try {
      return Promise.resolve(configure(null)).then(() => {}, () => {})
    } catch {
      return Promise.resolve()
    }
  }

  const fail = (message: string) => {
    if (suspended || !requestedDeviceId) return
    failureKey = requestedKey
    failureNotice = message || '本地监听未能开启，请重新选择耳机重试。'
    pending = disconnect(failureNotice)
  }

  const reconcile = (): Promise<void> => {
    if (suspended) return Promise.resolve()
    const desired = desiredMonitor()
    // A different route or candidate represents new evidence. Identical
    // devicechange snapshots must not retry a rejected autoplay/sink in a loop.
    if (failureKey !== null && failureKey !== desired.key) {
      failureKey = null
      failureNotice = ''
    }
    if (!desired.deviceId || desired.key === failureKey) {
      pending = disconnect(desired.key === failureKey ? failureNotice : desired.notice)
      return pending
    }
    if (requestedDeviceId === desired.deviceId) {
      requestedKey = desired.key
      if (state.deviceId) updateState({ ...state, notice: desired.notice })
      return pending
    }

    const operation = ++revision
    requestedDeviceId = desired.deviceId
    requestedKey = desired.key
    updateState({ ...state, deviceId: null, notice: '正在开启本地监听…' })
    const current = () => !suspended && operation === revision
    pending = (async () => {
      try {
        const success = await configure(desired.deviceId)
        if (!current()) return
        if (!success) {
          fail('本地监听未能开启，请重新选择耳机重试。')
          return
        }
        updateState({ ...state, deviceId: desired.deviceId, notice: desiredMonitor().notice })
      } catch (error) {
        if (current()) fail(error instanceof Error ? error.message : '本地监听未能开启，请重新选择耳机重试。')
      }
    })()
    return pending
  }

  return {
    update: (next: AutomaticAudioMonitorSnapshot): Promise<void> => {
      snapshot = next
      suspended = false
      return reconcile()
    },
    choose: (choice: string): Promise<void> => {
      failureKey = null
      failureNotice = ''
      updateState({ ...state, choice: choice.trim(), notice: '' })
      suspended = false
      return reconcile()
    },
    fail,
    getState: (): AutomaticAudioMonitorState => ({ ...state }),
    suspend: (emit = true): void => {
      suspended = true
      pending = disconnect('', emit)
    },
  }
}
