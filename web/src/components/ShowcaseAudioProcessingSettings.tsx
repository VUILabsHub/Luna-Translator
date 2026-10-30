import ShowcaseCombobox from './ShowcaseCombobox'
import {
  frameRMSLoudnessOptions,
  p90LoudnessOptions,
  type VADLoudnessMode,
  type VADLoudnessThresholdDbfs,
} from '@simultrans/ui-shared/src/lib/audioProcessing'

type Props = {
  summary?: string
  /** 不包 <details>，直接输出内容（宿主已经放在自己的「高级设置」折叠区里）。 */
  plain?: boolean
  /** DeepFilterNet 开关由宿主在面板顶层渲染时隐藏此处的重复开关。 */
  hideDeepFilterNet?: boolean
  service?: 'websocket' | 'volc-rtc'
  webRTCEchoCancellation?: boolean
  deepFilterNet: boolean
  vadLoudnessMode: VADLoudnessMode
  vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs
  disabled: boolean
  onServiceChange?: (service: 'websocket' | 'volc-rtc') => void
  onWebRTCEchoCancellationChange?: (enabled: boolean) => void
  onDeepFilterNetChange: (enabled: boolean) => void
  onVADLoudnessModeChange: (mode: VADLoudnessMode) => void
  onVADLoudnessThresholdChange: (threshold: VADLoudnessThresholdDbfs) => void
}

const modeOptions = [
  { value: 'frame_rms', label: '实时帧级门控（32ms RMS）' },
  { value: 'p90_400ms', label: '稳健分位门控（400ms P90）' },
]

export default function ShowcaseAudioProcessingSettings({
  summary = '高级音频处理',
  plain = false,
  hideDeepFilterNet = false,
  service,
  webRTCEchoCancellation,
  deepFilterNet,
  vadLoudnessMode,
  vadLoudnessThresholdDbfs,
  disabled,
  onServiceChange,
  onWebRTCEchoCancellationChange,
  onDeepFilterNetChange,
  onVADLoudnessModeChange,
  onVADLoudnessThresholdChange,
}: Props) {
  const thresholdOptions = vadLoudnessMode === 'p90_400ms'
    ? p90LoudnessOptions
    : frameRMSLoudnessOptions

  const content = (
      <div className="realtime-showcase-advanced-audio__content">
        {service && onServiceChange && <div className="realtime-showcase-setting-select">
          <span>服务线路</span>
          <ShowcaseCombobox
            ariaLabel="选择服务线路"
            className="realtime-showcase-device-combobox"
            disabled={disabled}
            options={[{ value: 'websocket', label: 'WebSocket' }, { value: 'volc-rtc', label: 'WebRTC' }]}
            value={service}
            onChange={(value) => onServiceChange(value as 'websocket' | 'volc-rtc')}
            renderTrigger={(option, open) => (
              <>
                <span className="realtime-showcase-device-label">{option?.label || '选择服务线路'}</span>
                <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
              </>
            )}
          />
        </div>}
        {service === 'volc-rtc' && onWebRTCEchoCancellationChange && <div className="realtime-showcase-setting-select">
          <span>AEC</span>
          <ShowcaseCombobox
            ariaLabel="选择 AEC 状态"
            className="realtime-showcase-device-combobox"
            disabled={disabled}
            options={[{ value: 'on', label: '开启 AEC' }, { value: 'off', label: '关闭 AEC' }]}
            value={webRTCEchoCancellation ? 'on' : 'off'}
            onChange={(value) => onWebRTCEchoCancellationChange(value === 'on')}
            renderTrigger={(option, open) => (
              <>
                <span className="realtime-showcase-device-label">{option?.label || '选择 AEC 状态'}</span>
                <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
              </>
            )}
          />
        </div>}
        {!hideDeepFilterNet && <div className="realtime-showcase-setting-row">
          <span>
            <strong>DeepFilterNet3 语音增强</strong>
            <small>在响度门控和双 VAD 前处理输入音频</small>
          </span>
          <button
            type="button"
            role="switch"
            className={`realtime-showcase-switch${deepFilterNet ? ' is-on' : ''}`}
            aria-label="DeepFilterNet3 语音增强"
            aria-checked={deepFilterNet}
            disabled={disabled}
            onClick={() => onDeepFilterNetChange(!deepFilterNet)}
          ><span /></button>
        </div>}
        <div className="realtime-showcase-setting-select">
          <span>响度门控</span>
          <ShowcaseCombobox
            ariaLabel="选择响度门控方式"
            className="realtime-showcase-device-combobox"
            disabled={disabled}
            options={modeOptions}
            value={vadLoudnessMode}
            onChange={(value) => onVADLoudnessModeChange(value as VADLoudnessMode)}
            renderTrigger={(option, open) => (
              <>
                <span className="realtime-showcase-device-label">{option?.label || '选择门控方式'}</span>
                <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
              </>
            )}
          />
        </div>
        <div className="realtime-showcase-setting-select">
          <span>响度阈值</span>
          <ShowcaseCombobox
            ariaLabel="选择响度门控阈值"
            className="realtime-showcase-device-combobox"
            disabled={disabled}
            options={thresholdOptions}
            value={String(vadLoudnessThresholdDbfs)}
            onChange={(value) => onVADLoudnessThresholdChange(Number(value) as VADLoudnessThresholdDbfs)}
            renderTrigger={(option, open) => (
              <>
                <span className="realtime-showcase-device-label">{option?.label || '选择响度阈值'}</span>
                <img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" />
              </>
            )}
          />
        </div>
      </div>
  )
  if (plain) return content
  return (
    <details className="realtime-showcase-advanced-audio">
      <summary>{summary}</summary>
      {content}
    </details>
  )
}
