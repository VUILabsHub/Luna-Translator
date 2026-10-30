import type { QuickAudioPreferences } from '../lib/quickAudio'

const levels: readonly QuickAudioPreferences['noiseReduction'][] = ['weak', 'default', 'strong']
const labels = ['弱', '默认', '强']

/** 与移动端同一套播放音量和三档响度门；会话中只能调整播放音量。 */
export function QuickAudioSettings({ value, busy, onChange }: {
  value: QuickAudioPreferences; busy: boolean; onChange: (value: QuickAudioPreferences) => void
}) {
  const index = levels.indexOf(value.noiseReduction)
  return <div className="showcase-quick-audio">
    <label className="showcase-quick-audio-slider">降噪模式
      <input type="range" min="0" max="2" step="1" aria-label="降噪模式" aria-valuetext={labels[index]} value={index} disabled={busy}
        title={busy ? '开始同传时生效，同传中不能修改。' : '向右滤掉更多环境声，向左较轻的说话声也能收进来。'}
        onChange={event => onChange({ ...value, noiseReduction: levels[Number(event.target.value)] })} />
      <span className="showcase-quick-noise-labels" aria-hidden="true">{labels.map((label, position) => <span key={label} className={position === index ? 'is-selected' : ''}>{label}</span>)}</span>
    </label>
    <label className="showcase-quick-audio-slider">播放音量 <span>{value.volume}%</span>
      <input type="range" min="0" max="100" step="1" aria-label="播放音量" value={value.volume}
        onChange={event => onChange({ ...value, volume: Number(event.target.value) })} />
    </label>
  </div>
}
