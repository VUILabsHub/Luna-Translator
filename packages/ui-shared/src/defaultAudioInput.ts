type InputDevice = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'> & { groupId?: string }

export function resolveDefaultAudioInput(devices: InputDevice[]): InputDevice | null {
  const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId !== 'communications')
  const alias = inputs.find((device) => device.deviceId === 'default')
  if (!alias) return inputs[0] || null
  const physical = inputs.filter((device) => device.deviceId !== 'default')
  const grouped = alias.groupId ? physical.filter((device) => device.groupId === alias.groupId) : []
  if (grouped.length === 1) return grouped[0]
  const label = alias.label.replace(/^(?:default|默认(?:设备)?|系统默认)\s*[-–—:：]\s*/i, '').trim()
  const named = label ? physical.filter((device) => device.label.trim() === label) : []
  // An unresolved alias is still an explicit browser device. Never guess a
  // physical device from a partial or duplicate label.
  return named.length === 1 ? named[0] : alias
}

export async function getDefaultAudioInput() {
  const devices = await navigator.mediaDevices.enumerateDevices?.() || []
  return resolveDefaultAudioInput(devices)
}

export function defaultAudioInputKey(device: InputDevice | null) {
  return device ? JSON.stringify([device.deviceId, device.groupId || '', device.label]) : ''
}
