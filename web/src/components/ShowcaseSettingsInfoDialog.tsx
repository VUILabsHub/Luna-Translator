// 设置面板信息弹窗：点击标签旁的 ⓘ 打开，展示该项各选项的引擎与差异。
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { showcaseSettingsInfo, type ShowcaseSettingsInfoTopic } from '../lib/showcaseSettingsInfo'
import { useSettingsCatalog } from '../lib/settingsCatalog'

export function ShowcaseSettingsInfoButton({ topic, onOpen }: { topic: ShowcaseSettingsInfoTopic; onOpen: (topic: ShowcaseSettingsInfoTopic) => void }) {
  return (
    <button
      type="button"
      className="showcase-setting-info"
      aria-label={`查看${showcaseSettingsInfo[topic].title}说明`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(topic)
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
        <rect x="7.25" y="6.9" width="1.5" height="4.6" rx="0.75" fill="currentColor" />
      </svg>
    </button>
  )
}

export function ShowcaseSettingsInfoDialog({ topic, onClose, duo = false }: { topic: ShowcaseSettingsInfoTopic | null; onClose: () => void; duo?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  // 说明内容以后端设置目录为准（/api/settings/catalog），拉不到时用内置文案。
  const catalog = useSettingsCatalog()

  useEffect(() => {
    if (!topic) return undefined
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, topic])

  if (!topic) return null
  // Noise names and device routing are mode-specific local frontend behavior.
  const info = topic === 'noise' ? (duo ? {
    ...showcaseSettingsInfo.noise,
    intro: '刷新后检测到大疆麦克风时，默认使用耳机模式；同时发现外置耳机 (Built-in) 与 INZONE H3 (054c:0e47)，且浏览器支持指定输出设备时，自动切换演示模式。输入固定 L=甲、R=乙。',
    rows: [
      { ...showcaseSettingsInfo.noise.rows[0], name: '双麦-外接单麦' },
      { ...showcaseSettingsInfo.noise.rows[1], name: '双麦-系统降噪' },
      { name: '双麦-大疆专用-耳机', summary: '大疆双声道麦克风配耳机。', points: [], cells: ['大疆双声道麦克风配耳机', '一台播放设备，左右声道交叉收听', '保留原双麦处理，不启用额外降噪'] },
      { name: '双麦-大疆专用-演示', summary: '指定双输出设备的演示场景。', points: [], cells: ['指定双输出设备的演示场景', '外置耳机 (Built-in) 与 INZONE H3 (054c:0e47)', '采用原大疆降噪配置，两路独立播放'] },
    ],
  } : showcaseSettingsInfo.noise) : catalog?.info?.[topic] ?? showcaseSettingsInfo[topic]
  // 设置面板本身是可滚动的定位容器，弹窗必须挂到 body 才不会被裁切。
  const dialog = (
    <div
      className="showcase-setting-info-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="showcase-setting-info-dialog" role="dialog" aria-modal="true" aria-labelledby="showcase-setting-info-title">
        <header className="showcase-setting-info-header">
          <h2 id="showcase-setting-info-title">{info.title}</h2>
          <button type="button" ref={closeRef} className="showcase-setting-info-close" aria-label="关闭说明" onClick={onClose}>×</button>
        </header>
        <p className="showcase-setting-info-intro">{info.intro}</p>
        {info.columns ? (
          <div className="showcase-setting-info-table-wrap">
            <table className="showcase-setting-info-table">
              <thead>
                <tr>
                  <th scope="col">{topic === 'noise' ? '模式' : topic === 'tts' ? '场景' : '模型'}</th>
                  {info.columns.map((column) => <th scope="col" key={column} data-column={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {info.rows.map((row) => (
                  <tr key={row.name} className={row.recommended ? 'is-recommended' : ''}>
                    <th scope="row">{row.name}{row.recommended && !info.columns?.includes('推荐') ? '（推荐）' : ''}</th>
                    {(row.cells || []).map((cell, index) => <td key={info.columns?.[index] || index} data-column={info.columns?.[index]}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="showcase-setting-info-list">
            {info.rows.map((row) => (
              <li key={row.name}>
                <strong>{row.name}</strong>
                {row.engine && <small>{row.engine}</small>}
                <p>{row.summary}</p>
                <ul>
                  {row.points.map((point) => <li key={point}>{point}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
