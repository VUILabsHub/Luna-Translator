export type AudioMonitorDevice = {
  deviceId: string
  kind: string
  label: string
  groupId?: string
}

export type AudioMonitorConflict = 'system-default' | 'same-device' | null

const systemOutputIds = new Set(['default', 'communications'])

/** Anonymous pre-permission devices cannot be selected as an independent sink. */
export function hasExplicitMonitorOutputId(device: { deviceId: string }): boolean {
  const deviceId = device.deviceId.trim()
  return Boolean(deviceId) && !systemOutputIds.has(deviceId)
}

/** Strip browser alias prefixes without collapsing distinct device names. */
export function normalizeAudioOutputLabel(label: string): string {
  return label.normalize('NFKC').trim()
    .replace(/^(?:default|communications|系统默认|默认|通信)(?:\s*[-–—:]\s*)/i, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
}

/**
 * A monitor must use a concrete device. Re-evaluate after devicechange so that
 * a system-default route returning to the headphones does not play twice.
 * Missing browser identity data is not proof that two routes are equivalent.
 */
export function monitorOutputConflict({
  monitorDeviceId,
  mainDeviceId = 'default',
  rawDevices,
}: {
  monitorDeviceId: string
  mainDeviceId?: string
  rawDevices: readonly AudioMonitorDevice[]
}): AudioMonitorConflict {
  if (!monitorDeviceId) return null
  if (!hasExplicitMonitorOutputId({ deviceId: monitorDeviceId })) return 'system-default'

  const mainId = mainDeviceId || 'default'
  if (mainId === monitorDeviceId) return 'same-device'

  const outputs = rawDevices.filter(device => device.kind === 'audiooutput')
  const main = outputs.find(device => device.deviceId === mainId)
  const monitor = outputs.find(device => device.deviceId === monitorDeviceId)
  if (!main || !monitor) return null

  if (main.groupId && monitor.groupId) {
    return main.groupId === monitor.groupId ? 'same-device' : null
  }

  // Labels only resolve a browser alias. Two physical headsets can have the
  // same model name; their distinct IDs must not be merged by that name alone.
  if (!systemOutputIds.has(mainId)) return null
  const mainLabel = normalizeAudioOutputLabel(main.label)
  const monitorLabel = normalizeAudioOutputLabel(monitor.label)
  return mainLabel && monitorLabel && mainLabel === monitorLabel ? 'same-device' : null
}

export type AutomaticAudioMonitor = {
  deviceId: string | null
  sharingDetected: boolean
  reason: 'inactive' | 'ready' | 'no-headphones' | 'ambiguous'
  routeKey: string
}

// Only names identifying a meeting capture driver qualify. Merely installing
// that driver, or connecting a Teams-certified headset, does not activate it.
const meetingCaptureLabel = /^(?:(?:microsoft\s+)?teams?\s+audio(?:\s+(?:voice|device)|\s*\((?:voice|device)\))?|(?:microsoft\s*)?teams?audio(?:voice|device)|tencent\s*meeting\s*audio(?:\s*device)?|tencentaudiodevice|wemeet\s*audio(?:\s*device)?|腾讯会议(?:音频(?:设备)?|虚拟声卡|共享音频|音频共享|声音共享))(?:\s*\((?:virtual|虚拟)\))?$/i
const headphoneLabel = /AirPods|\bBeats\b|\b(?:headsets?|headphones?|earphones?|earbuds?)\b|耳机|耳麦/i
const loudspeakerLabel = /\b(?:speakers?|speakerphone|earpiece|built[\s-]?in|internal|hdmi|displayport|display|monitor|airplay)\b|扬声器|音箱|音响|听筒|内[建置]|电视|显示器/i
const virtualOutputLabel = /\b(?:virtual|loopback|blackhole|soundflower|aggregate|multi[\s-]?output|vb[\s-]?audio|voicemeeter|capture)\b|虚拟|聚合|多输出|多重输出|采集|共享/i

/**
 * Infer only a known capture route and an unambiguous headphone destination.
 * Browsers cannot observe a native meeting's actual screen-sharing state.
 * The caller owns manual overrides and must re-evaluate device changes.
 */
export function resolveAutomaticAudioMonitor({
  mainDeviceId,
  inputDeviceId,
  rawDevices,
}: {
  mainDeviceId: string
  inputDeviceId: string
  rawDevices: readonly AudioMonitorDevice[]
}): AutomaticAudioMonitor {
  const inactive: AutomaticAudioMonitor = { deviceId: null, sharingDetected: false, reason: 'inactive', routeKey: '' }
  if (mainDeviceId && mainDeviceId !== 'default') return inactive
  const defaultOutput = rawDevices.find(device => device.kind === 'audiooutput' && device.deviceId === 'default')
  if (!defaultOutput) return inactive
  const defaultLabel = normalizeAudioOutputLabel(defaultOutput.label)
  if (!meetingCaptureLabel.test(defaultLabel)) return inactive

  const routeKey = JSON.stringify([defaultOutput.groupId || '', defaultLabel])
  const result = (reason: AutomaticAudioMonitor['reason'], deviceId: string | null = null): AutomaticAudioMonitor => ({
    deviceId, sharingDetected: true, reason, routeKey,
  })
  const candidates = rawDevices.filter((device, index, devices) => {
    if (device.kind !== 'audiooutput' || !hasExplicitMonitorOutputId(device)) return false
    if (devices.findIndex(other => other.kind === 'audiooutput' && other.deviceId === device.deviceId) !== index) return false
    const label = normalizeAudioOutputLabel(device.label)
    return headphoneLabel.test(label) && !loudspeakerLabel.test(label) && !virtualOutputLabel.test(label)
      && !meetingCaptureLabel.test(label)
      && !monitorOutputConflict({ monitorDeviceId: device.deviceId, mainDeviceId, rawDevices })
  })
  if (!candidates.length) return result('no-headphones')

  const selectedInput = rawDevices.find(device => device.kind === 'audioinput' && device.deviceId === (inputDeviceId || 'default'))
  const paired = selectedInput?.groupId
    ? candidates.filter(device => device.groupId === selectedInput.groupId)
    : []
  if (paired.length === 1) return result('ready', paired[0].deviceId)
  if (paired.length > 1) return result('ambiguous')
  return candidates.length === 1 ? result('ready', candidates[0].deviceId) : result('ambiguous')
}
