import { useEffect, useRef, useState } from 'react'
import type { AudioMonitorDevice } from '../lib/audioMonitorDevices'
import { createAutomaticAudioMonitor } from './automaticAudioMonitor'

/** Resolve the optional local sink without changing the main output or mute state. */
export function useAutomaticAudioMonitor(options: {
  mainDeviceId: string
  inputDeviceId: string
  rawDevices: AudioMonitorDevice[]
  available: boolean
  initialized: boolean
  configure: (deviceId: string | null) => Promise<boolean>
  error: string
}) {
  const configureRef = useRef(options.configure)
  configureRef.current = options.configure
  const [state, setState] = useState({ choice: 'auto', deviceId: null as string | null, notice: '' })
  const controllerRef = useRef<ReturnType<typeof createAutomaticAudioMonitor> | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createAutomaticAudioMonitor(id => configureRef.current(id), setState)
  }
  const controller = controllerRef.current
  useEffect(() => {
    if (options.error) controller.fail(options.error)
  }, [controller, options.error])
  // Attribute an existing failure to the old route before reconciling a new
  // device snapshot; otherwise it could cancel a newly connected headset.
  useEffect(() => {
    void controller.update(options)
  }, [controller, options.mainDeviceId, options.inputDeviceId, options.rawDevices, options.available, options.initialized])
  useEffect(() => () => controller.suspend(false), [controller])
  return { ...state, choose: controller.choose, suspend: controller.suspend, reconcile: () => controller.update(options) }
}
