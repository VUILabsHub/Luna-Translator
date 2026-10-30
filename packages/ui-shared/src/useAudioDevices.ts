import { useCallback, useEffect, useRef, useState } from 'react'

export type AudioDeviceOption = {
  deviceId: string
  label: string
}

export type RawAudioDevice = {
  deviceId: string
  kind: string
  label: string
  groupId?: string
}

export function preferredDJIInputDevice(devices: AudioDeviceOption[]) {
  return devices.find((device) => /\bDJI\b|大疆|\bWireless\s+Mic\s+Rx\b/i.test(device.label))
}

// 手机浏览器上判断是否接了耳机 / 外接麦克风：命中走「耳机收声」（耳机保真），
// 否则默认「系统降噪」（系统通话链路）。只能看浏览器给出的设备名，各家命名不一，
// 所以是启发式：iOS 的 AirPods / 耳机、Android Chrome 的 Wired headset / Bluetooth
// headset / USB audio、DJI 等无线麦都算外接；Headset earpiece（听筒）与 Speakerphone
// 是手机自带链路，排除。未授权时名称为空，一律视为未接。
const externalInputLabelPattern = /AirPods|Beats|耳机|Headset|Headphone|Earphone|Earbud|Bluetooth|蓝牙|\bBT\b|Hands-?Free|\bHFP\b|\bUSB\b|Wired|有线|Lightning|Type-?C|External|外接|外置|\bDJI\b|大疆|Wireless\s+Mic/i
const builtInPhoneInputLabelPattern = /Earpiece|听筒|Speakerphone/i

export function preferredExternalInputDevice(devices: AudioDeviceOption[]) {
  return devices.find((device) => externalInputLabelPattern.test(device.label) && !builtInPhoneInputLabelPattern.test(device.label))
}

export function useAudioDevices() {
  const mounted = useRef(true)
  const refreshRevision = useRef(0)
  const permissionRevision = useRef(0)
  const [inputDevices, setInputDevices] = useState<AudioDeviceOption[]>([])
  const [outputDevices, setOutputDevices] = useState<AudioDeviceOption[]>([])
  // Raw kind/label pairs (labels empty before mic permission) for hardware
  // classification; the normalized lists above inject fallback labels that
  // must not be keyword-matched.
  const [rawDevices, setRawDevices] = useState<RawAudioDevice[]>([])
  const [defaultInputDeviceLabel, setDefaultInputDeviceLabel] = useState('')
  const [defaultOutputDeviceLabel, setDefaultOutputDeviceLabel] = useState('')
  const [permissionGranted, setPermissionGranted] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const mediaDeviceSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  const streamOutputSelectionSupported = typeof window !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && 'setSinkId' in AudioContext.prototype
  const outputSelectionSupported = streamOutputSelectionSupported
    && typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype

  // A devicechange may overtake a list-open refresh. Only the newest result can
  // replace the visible list; enumeration never opens or restarts a microphone.
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    const revision = ++refreshRevision.current
    try {
      const devices = typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices
        ? await navigator.mediaDevices.enumerateDevices() : []
      if (!mounted.current || revision !== refreshRevision.current) return
      setPermissionGranted(devices.some((device) => device.kind === 'audioinput' && Boolean(device.label)))
      setRawDevices(previous => sameDevices(previous, devices) ? previous : devices.map((device) => ({ deviceId: device.deviceId, kind: device.kind, label: device.label, groupId: device.groupId })))
      setDefaultInputDeviceLabel(devices.find((device) => device.kind === 'audioinput' && device.deviceId === 'default')?.label || '')
      setDefaultOutputDeviceLabel(devices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default')?.label || '')
      const inputs = normalizeDevices(devices, 'audioinput', '麦克风')
      const outputs = normalizeDevices(devices, 'audiooutput', '扬声器/耳机')
      setInputDevices(previous => sameOptions(previous, inputs) ? previous : inputs)
      setOutputDevices(previous => sameOptions(previous, outputs) ? previous : outputs)
      setError('')
    } catch {
      // Retain the last usable snapshot on a transient enumeration failure.
      if (mounted.current && revision === refreshRevision.current) setError('无法读取音频设备列表，请重新打开设备列表重试。')
    } finally {
      if (mounted.current && revision === refreshRevision.current) setInitialized(true)
    }
  }, [])

  const requestPermissionAndRefresh = useCallback(async () => {
    if (!mounted.current) return false
    const revision = ++permissionRevision.current
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前页面无法访问音频设备，请使用 HTTPS 或本机地址打开。')
      return false
    }
    setLoading(true)
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      if (!mounted.current || revision !== permissionRevision.current) return false
      setPermissionGranted(true)
      await refresh()
      return mounted.current && revision === permissionRevision.current
    } catch (caught) {
      if (!mounted.current || revision !== permissionRevision.current) return false
      const permissionDenied = caught instanceof DOMException && (caught.name === 'NotAllowedError' || caught.name === 'SecurityError')
      setError(permissionDenied
        ? '未获得麦克风权限，请在浏览器地址栏允许后重试。'
        : '无法读取音频设备，请确认设备已连接。')
      return false
    } finally {
      if (mounted.current && revision === permissionRevision.current) setLoading(false)
    }
  }, [refresh])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const handleDeviceChange = () => {
      void refresh()
    }
    // Native meeting clients can switch the system default without exposing a
    // new physical device. Refresh again when returning from their share UI.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') handleDeviceChange()
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)
    window.addEventListener('focus', handleDeviceChange)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      mounted.current = false
      ++refreshRevision.current
      ++permissionRevision.current
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
      window.removeEventListener('focus', handleDeviceChange)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refresh])

  return {
    inputDevices,
    outputDevices,
    rawDevices,
    defaultInputDeviceLabel,
    defaultOutputDeviceLabel,
    initialized,
    permissionGranted,
    loading,
    error,
    mediaDeviceSupported,
    outputSelectionSupported,
    streamOutputSelectionSupported,
    refresh,
    requestPermissionAndRefresh,
  }
}

function normalizeDevices(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallbackLabel: string,
): AudioDeviceOption[] {
  return devices
    .filter((device) => device.kind === kind && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .filter((device, index, values) => values.findIndex((candidate) => candidate.deviceId === device.deviceId) === index)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${fallbackLabel} ${index + 1}（授权后显示名称）`,
    }))
}

function sameOptions(previous: AudioDeviceOption[], next: AudioDeviceOption[]) {
  return previous.length === next.length && previous.every((device, index) => device.deviceId === next[index].deviceId && device.label === next[index].label)
}
function sameDevices(previous: RawAudioDevice[], next: MediaDeviceInfo[]) {
  return previous.length === next.length && previous.every((device, index) => device.deviceId === next[index].deviceId
    && device.kind === next[index].kind && device.label === next[index].label && device.groupId === next[index].groupId)
}
