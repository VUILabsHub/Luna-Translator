import {
  createStereoRecorder,
  type RecorderFactory,
  type RecorderHandle,
} from '@simultrans/ui-shared/src/audio'

type Side = 'left' | 'right'
type StereoRecorderOpener = (
  onLeftPCM: (buffer: ArrayBuffer) => void,
  onRightPCM: (buffer: ArrayBuffer) => void,
  inputDeviceId: string,
) => Promise<RecorderHandle>

type PendingSide = {
  resolve: (handle: RecorderHandle) => void
  reject: (reason: unknown) => void
}

export function createSharedStereoRecorderFactories(
  inputDeviceId: string,
  swapChannels = false,
  openRecorder: StereoRecorderOpener = createStereoRecorder,
): { left: RecorderFactory; right: RecorderFactory } {
  let callbacks: Partial<Record<Side, (buffer: ArrayBuffer) => void>> = {}
  let pending: Partial<Record<Side, PendingSide>> = {}
  let recorder: RecorderHandle | null = null
  let opening = false
  let released = new Set<Side>()
  let stopPromises: Partial<Record<Side, Promise<void>>> = {}
  let pairingTimer: ReturnType<typeof setTimeout> | null = null

  const clearPairingTimer = () => {
    if (pairingTimer !== null) clearTimeout(pairingTimer)
    pairingTimer = null
  }
  const reset = () => {
    clearPairingTimer()
    callbacks = {}
    pending = {}
    recorder = null
    opening = false
    released = new Set()
    stopPromises = {}
  }
  const rejectPending = (reason: unknown) => {
    const waiters = Object.values(pending)
    reset()
    waiters.forEach((waiter) => waiter?.reject(reason))
  }
  const stopSide = (side: Side) => {
    if (stopPromises[side]) return stopPromises[side]!
    const promise = (async () => {
      released.add(side)
      delete callbacks[side]
      if (released.size < 2 || !recorder) return
      const current = recorder
      try {
        await current.stop()
      } finally {
        if (recorder === current) reset()
      }
    })()
    stopPromises[side] = promise
    return promise
  }
  const startWhenPaired = () => {
    if (opening || !pending.left || !pending.right || !callbacks.left || !callbacks.right) return
    opening = true
    clearPairingTimer()
    const emitLeft = (buffer: ArrayBuffer) => callbacks.left?.(buffer)
    const emitRight = (buffer: ArrayBuffer) => callbacks.right?.(buffer)
    const first = swapChannels ? emitRight : emitLeft
    const second = swapChannels ? emitLeft : emitRight
    void openRecorder(first, second, inputDeviceId).then((opened) => {
      recorder = opened
      const leftWaiter = pending.left
      const rightWaiter = pending.right
      pending = {}
      leftWaiter?.resolve({ diagnostics: opened.diagnostics, stop: () => stopSide('left') })
      rightWaiter?.resolve({ diagnostics: opened.diagnostics, stop: () => stopSide('right') })
    }).catch(rejectPending)
  }
  const factory = (side: Side): RecorderFactory => (onPCM) => new Promise<RecorderHandle>((resolve, reject) => {
    if (callbacks[side] || pending[side]) {
      reject(new Error(`双声道${side === 'left' ? '左' : '右'}路已经被占用。`))
      return
    }
    callbacks[side] = onPCM
    pending[side] = { resolve, reject }
    if (pairingTimer === null) {
      pairingTimer = setTimeout(() => {
        rejectPending(new Error('甲、乙会话未能同时启动双声道录音。'))
      }, 8_000)
    }
    startWhenPaired()
  })

  return { left: factory('left'), right: factory('right') }
}
