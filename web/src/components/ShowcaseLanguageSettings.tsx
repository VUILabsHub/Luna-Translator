import ShowcaseCombobox from './ShowcaseCombobox'
import { selectHotwordMode, type HotwordMode, type ShowcaseHotwords } from '../lib/showcaseHotwords'
export { baseTranslationPrompt as defaultShowcaseSystemPrompt } from '../lib/showcaseHotwords'

const modes = [{ value: 'none', label: '无热词' }, { value: 'default', label: '默认配置' }, { value: 'custom', label: '自定义配置' }]

export function ShowcaseLanguageSettings({ value, onChange }: {
  value: ShowcaseHotwords
  onChange: (value: ShowcaseHotwords) => void
}) {
  return <div className="showcase-language-settings">
    <div className="realtime-showcase-setting-select"><span>热词模式</span>
      <ShowcaseCombobox ariaLabel="选择热词模式" className="realtime-showcase-device-combobox" options={modes} value={value.mode}
        onChange={mode => onChange(selectHotwordMode(mode as HotwordMode, value))}
        renderTrigger={(option, open) => <><span className="realtime-showcase-device-label">{option?.label}</span><img className={open ? 'is-open' : ''} src="/showcase/chevron.svg" alt="" aria-hidden="true" /></>}
        renderOption={(option, selected) => <><span>{option.label}</span>{selected && <img src="/showcase/check-16.svg" alt="" aria-hidden="true" />}</>} />
    </div>
    {value.mode === 'custom' && <details className="showcase-hotword-custom" open>
      <summary>自定义配置</summary>
      <div className="showcase-language-settings">
        <label><span>ASR 热词</span><textarea rows={2} value={value.asrContext} onChange={event => onChange({ ...value, asrContext: event.target.value })} placeholder="填写热词或识别上下文；留空不使用热词" /></label>
        <label><span>翻译 Prompt</span><textarea rows={3} maxLength={2000} value={value.prompt} onChange={event => onChange({ ...value, prompt: event.target.value })} placeholder="Translate into {target}." /></label>
        <p className="realtime-showcase-settings-note">{'{target}'} 自动替换为各路目标语言；留空仅使用基础翻译指令。最多 2000 字符 / 512 tokens。双麦模式下甲乙共用。</p>
        <button type="button" className="showcase-stereo-swap" onClick={() => onChange(selectHotwordMode('default', value))}>恢复默认配置</button>
      </div>
    </details>}
  </div>
}
