import { useEffect, useRef, useState } from 'react'
import type { MultilingualShowcaseRow } from '../lib/multilingualShowcase'
import '../styles/home-conversation.css'
import type { TranscriptDisplayMode } from '../lib/transcriptDisplay'

export type ConversationSide = 'top' | 'bottom'
export type ConversationLanguages = [string, string]

const languages = [
  { code: 'zh', native: '中文', name: '中文', original: '原文', translated: '译文' },
  { code: 'en', native: 'English', name: '英语', original: 'Original', translated: 'Translated' },
] as const

function languageLabel(code: string) {
  return languages.find(language => language.code === code)
    ?? { code, native: code, name: code, original: '原文', translated: '译文' }
}

export function ConversationLanguageControls({
  languages: selected,
  disabled = false,
  onChange,
}: {
  languages: ConversationLanguages
  disabled?: boolean
  onChange: (languages: ConversationLanguages) => void
}) {
  const choose = (index: 0 | 1, code: string) => {
    if (disabled || !languages.some(language => language.code === code) || code === selected[index === 0 ? 1 : 0]) return
    onChange(index === 0 ? [code, selected[1]] : [selected[0], code])
  }

  return (
    <fieldset className="home-conversation-languages" disabled={disabled}>
      <legend>面对面，选择两种语言</legend>
      <div className="home-conversation-language-pair">
        {([0, 1] as const).map((index) => (
          <label key={index} className="home-conversation-language-choice">
            <span>{index === 0 ? '上方语言' : '下方语言'}</span>
            <select
              aria-label={index === 0 ? '上方语言' : '下方语言'}
              value={selected[index]}
              onChange={event => choose(index, event.target.value)}
            >
              {languages.map(language => (
                <option
                  key={language.code}
                  value={language.code}
                  disabled={language.code === selected[index === 0 ? 1 : 0]}
                >
                  {language.native}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          className="home-conversation-swap"
          aria-label="交换上下语言"
          onClick={() => { if (!disabled) onChange([selected[1], selected[0]]) }}
        >
          <span aria-hidden="true">⇄</span>
        </button>
      </div>
      <p>共用一支麦克风，轮流说话；录音前可更换语言。</p>
    </fieldset>
  )
}

export function ConversationTranscript({
  languages: selected,
  rowsByLanguage,
  activeSide,
  onActiveSideChange,
  displayModes,
  speakingControls = false,
  disabled = false,
}: {
  languages: ConversationLanguages
  rowsByLanguage: Record<string, MultilingualShowcaseRow[]>
  activeSide: ConversationSide
  onActiveSideChange: (side: ConversationSide) => void
  displayModes?: Record<ConversationSide, TranscriptDisplayMode>
  speakingControls?: boolean
  disabled?: boolean
}) {
  return (
    <div className="home-conversation-transcript" aria-label="双语对话字幕">
      {(['top', 'bottom'] as const).map((side, index) => (
        <ConversationPanel
          key={side}
          side={side}
          language={selected[index]}
          rows={rowsByLanguage[selected[index]] ?? []}
          active={activeSide === side}
          onActivate={() => onActiveSideChange(side)}
          displayMode={displayModes?.[side]}
          speakingControls={speakingControls}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function ConversationPanel({ side, language, rows, active, onActivate, displayMode = 'bilingual', speakingControls = false, disabled = false }: {
  side: ConversationSide
  language: string
  rows: MultilingualShowcaseRow[]
  active: boolean
  onActivate: () => void
  displayMode?: TranscriptDisplayMode
  speakingControls?: boolean
  disabled?: boolean
}) {
  const [rotated, setRotated] = useState(side === 'top')
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const label = languageLabel(language)
  const visibleRows = rows.filter(row => row.source.trim() || row.translations[language]?.trim())

  // Retain every supplied row and follow new text only while the reader is at
  // the end. Browsing older captions must not be interrupted by live updates.
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller && followRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [rows, language])

  return (
    <section
      className={`home-conversation-panel${active ? ' is-active' : ''}`}
      aria-label={`${side === 'top' ? '上方' : '下方'}${label.name}字幕`}
      data-side={side}
    >
      <div className={`home-conversation-panel-content${rotated ? ' is-rotated' : ''}`}>
        <header className="home-conversation-panel-header">
          <button type="button" onClick={onActivate} disabled={disabled} aria-pressed={active} aria-label={speakingControls ? `切换到${side === 'top' ? '上方' : '下方'}屏幕发言` : `选择${label.name}语言提示`}>
            <span lang={language}>{label.native}</span>
            <small>{speakingControls ? active ? '当前发言方' : '点击切换发言' : active ? '当前语言提示' : '点击选择语言提示'}</small>
          </button>
        </header>
        <div
          className="home-conversation-panel-scroll"
          ref={scrollRef}
          tabIndex={0}
          aria-label={`${label.name}字幕记录`}
          onScroll={(event) => {
            const target = event.currentTarget
            followRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32
          }}
        >
          {visibleRows.length === 0 ? (
            <p className="home-conversation-empty">开始说话，字幕会显示在这里。</p>
          ) : visibleRows.map((row, index) => {
            const translation = row.translations[language]?.trim() ?? ''
            const source = row.source.trim()
            const sameText = Boolean(source && source === translation)
            return (
              <article key={row.id} className={`home-conversation-row${index === visibleRows.length - 1 ? ' is-latest' : ''}`}>
                {displayMode !== 'translation' && source && !sameText && (
                  <p className="home-conversation-original" lang={row.sourceLanguage}><span>{label.original}</span>{row.source}</p>
                )}
                {displayMode !== 'source' && (translation || sameText) ? (
                  <p className="home-conversation-translation" lang={language}>
                    <span>{sameText ? label.original : label.translated}</span>
                    {sameText ? row.source : row.translations[language]}
                  </p>
                ) : displayMode !== 'source' ? (
                  <p className="home-conversation-pending">等待{label.name}译文…</p>
                ) : null}
                {displayMode === 'source' && sameText && <p className="home-conversation-original" lang={row.sourceLanguage}>{source}</p>}
              </article>
            )
          })}
        </div>
      </div>
      <button
        type="button"
        className="home-conversation-rotate"
        aria-label={`翻转${side === 'top' ? '上方' : '下方'}字幕方向`}
        aria-pressed={rotated}
        onClick={() => setRotated(current => !current)}
      >
        <span aria-hidden="true">↻</span><span>转向</span>
      </button>
    </section>
  )
}
