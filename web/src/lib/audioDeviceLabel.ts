export function displayAudioDeviceLabel(label: string) {
  return label
}

export function defaultAudioDeviceLabel(label: string, fallback: string) {
  return label.trim() ? label : fallback
}

export function isHeadsetEarpieceLabel(label: string) {
  const name = label.trim().replace(/^(?:default|默认(?:值|设备)?|系统默认)\s*[-–—:：]\s*/i, '')
  return name.toLowerCase() === 'headset earpiece'
}
