// 会话标签与首页/面板文案的唯一真相（Web 与 React Native 共用）。
//
// 背景（settings-x1 / x7 / settings-04 / duo-15 / live-14）：同一张「模式 /
// 音色模式 / 降噪预设 / 翻译·TTS 模型 / 使用场景」的中文表，之前在四个地方
// 各存一份——`web/src/lib/sessionSettings.ts`、`mobile/src/screens/
// SessionEndScreen.tsx`、`mobile/src/settings/settingsInfo.ts`、
// `mobile/src/screens/HistoryScreen.tsx`——于是 Web 在 f7fc07c 把首页胶囊从
// 「单人多语言 / 双人对话」改成「单麦多语 / 双麦多语」之后，两端（甚至 App
// 自己的两份表之间）当场分叉。这里收成一份，两端只读这里。
//
// 口径：
//  1. **文案以 Web 页面上实际显示的为准**（首页胶囊、设置面板标题、结束页概要、
//     历史卡片）。改这里等于同时改两端，不要在任何一端就地写中文字面量。
//  2. **下拉的显示名不走这张表**：下拉优先用后端设置目录（`/api/settings/catalog`）
//     下发的 Label，目录缺失时才回落 `mobile/src/settings/settingsInfo.ts` 的
//     内置表（它从这里取值）。这张表是「读侧」的真相——结束页、历史详情、
//     分享页把落盘的开放 JSON 翻成中文时用它。
//  3. **只读映射允许多于闭集**：例如 `demo-presentation` 只有 Web 桌面演示台
//     产得出来，App 永远不会写它，但 App 的历史详情会读到它，缺一条就在屏幕上
//     回显裸字符串。同理 `omnivoice-xc` / `cosyvoice` / `qwen17b` 都保留。
//
// 纯数据 + 纯函数：不 import react / react-native / DOM。

/** 会话模式。Web 首页胶囊自 f7fc07c 起是「单麦多语 / 双麦多语」。 */
export const SESSION_MODE_LABELS: Record<string, string> = {
  solo: '单麦多语',
  duo: '双麦多语',
}

/** 五模式首页的完整标签；会话记录继续使用上面的 solo / duo 协议标签。 */
export const HOME_MODE_LABELS = {
  solo: '单麦多语言',
  listen: '听',
  speak: '说',
  conversation: '聊',
  meeting: '会议',
} as const

/** 翻译模型（Luna-Live Translation 系列）。 */
export const TRANSLATION_MODEL_LABELS: Record<string, string> = {
  'flash-v2': 'Luna-LT-Flash v2',
  flash: 'Luna-LT-Flash',
  pro: 'Luna-LT-Pro',
}

/**
 * TTS 模型 / 使用场景。`qwen` 与 `qwen17b` 同为「正式宣讲」——`qwen` 是保留的
 * 兼容路由 ID（现网通过原服务入口加载 qwentts_v5 权重），历史记录里两种都出现得了。
 * `omnivoice-xc` / `cosyvoice` 只在旧记录与内部评测路由里出现，保留只读映射。
 */
export const TTS_MODEL_LABELS: Record<string, string> = {
  qwen17b: '正式宣讲',
  qwen: '正式宣讲',
  'qwentts-sc': '日常对话',
  omnivoice: 'Luna-TTS-Trans-Multilingual',
  'omnivoice-xc': 'OmniVoice-XC',
  cosyvoice: 'CosyVoice',
}

/**
 * 降噪预设。`demo-presentation` 与 `custom` 不进任何一端的下拉闭集：
 *  - `demo-presentation` 是 Web 双麦演示台专属（靠浏览器 `enumerateDevices`
 *    匹配两台特定 USB 设备），App 产不出但读得到；
 *  - `custom` 是「用户在高级设置里手调过参数」的合成值。
 */
export const NOISE_PRESET_LABELS: Record<string, string> = {
  headphones: '耳机保真',
  'phone-call': '手机通话模式',
  'echo-cancellation': '回声消噪',
  demo: '专用设备演示',
  'demo-presentation': '双麦-大疆专用-演示',
  custom: '自定义配置',
}

/** 传输通道。App 只有 WebSocket 一条；volc-rtc 只在 Web 桌面出现。 */
export const SERVICE_LABELS: Record<string, string> = {
  websocket: 'WebSocket',
  'volc-rtc': '火山 RTC',
}

/** VAD 响度门控模式。 */
export const VAD_LOUDNESS_MODE_LABELS: Record<string, string> = {
  frame_rms: '逐帧 RMS',
  p90_400ms: 'P90 400ms',
}

/** 服务端 ready 帧自报的音色模式。 */
export const VOICE_MODE_LABELS: Record<string, string> = {
  clone: '声音克隆',
  default: '预设音色',
}

/** 显示字号（与 Web showcaseFontSizeOptions 一字不差）。 */
export const FONT_SIZE_LABELS: Record<string, string> = {
  small: '小号',
  standard: '标准',
  large: '大号',
}

/** 客户端平台。 */
export const PLATFORM_LABELS: Record<string, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
}

/**
 * 查表：空串 / 非字符串 → undefined（「没记录」而不是「空值」）；
 * 查不到的取值**原样返回**，绝不吞掉信息（未来的预设、更新的客户端）。
 */
export function sessionLabel(
  table: Record<string, string>,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  return table[raw] ?? raw
}

// ---------------------------------------------------------------------------
// provider id → 可读的模型组合
// ---------------------------------------------------------------------------

/** 翻译模型的路由前缀（`vuilabs-<family>-<tts>`）。 */
const TRANSLATION_FAMILY_PREFIXES: Record<string, string> = {
  'vuilabs-qwen3simul': 'flash-v2',
  'vuilabs-qwen25-omni': 'flash',
  'vuilabs-qwen3-omni': 'pro',
}

/** 长的先试，避免短后缀/前缀抢答（`-qwentts-sc` 不能被 `-sc` 之类截胡）。 */
function longestFirst(keys: string[]): string[] {
  return [...keys].sort((left, right) => right.length - left.length)
}

/**
 * provider id → 「Luna-LT-Flash v2 · 正式宣讲」。
 *
 * 前缀决定翻译模型、后缀决定 TTS 模型（`-webrtc` 变体先剥掉），两段都按
 * **最长匹配优先**（settings-04：以前的逐个 `endsWith` 在 `-omnivoice-xc`、
 * `-qwentts-sc` 上直接漏判，整行回显裸 provider id）。
 * 两段都认不出时原样返回 id，绝不吞掉信息。
 */
export function providerDisplayName(provider: string): string {
  if (typeof provider !== 'string' || provider.trim() === '') return provider
  const id = provider.trim().replace(/-webrtc$/, '')
  const prefix = longestFirst(Object.keys(TRANSLATION_FAMILY_PREFIXES)).find(
    (candidate) => id.startsWith(`${candidate}-`),
  )
  const translation = prefix === undefined
    ? undefined
    : TRANSLATION_MODEL_LABELS[TRANSLATION_FAMILY_PREFIXES[prefix]]
  const suffix = longestFirst(Object.keys(TTS_MODEL_LABELS)).find(
    (candidate) => id.endsWith(`-${candidate}`),
  )
  const tts = suffix === undefined ? undefined : TTS_MODEL_LABELS[suffix]
  const parts = [translation, tts].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(' · ') : provider
}

// ---------------------------------------------------------------------------
// 首页与设置面板的文案（live-14 / settings-12）
// ---------------------------------------------------------------------------

export type SessionModeKey = 'solo' | 'duo'

/** 欢迎态的 slogan（Web `welcomeTitle` / `welcomeSubtitle`）。 */
export const WELCOME_COPY: Record<SessionModeKey, { title: string; subtitle: string }> = {
  solo: { title: '一种声音，多种语言', subtitle: 'One voice, multiple languages in real time' },
  duo: { title: '两支麦克风，多语对话', subtitle: 'Two voices, multiple languages in real time' },
}

/**
 * 欢迎态首行（`WELCOME_COPY` 之上那一句）。Web `MultilingualShowcasePage.tsx`
 * 的 `<p>欢迎体验<em>同声传译</em></p>`——单麦与双麦共用同一个 `ShowcaseFrame`，
 * 所以两种模式显示的都是这一句。
 *
 * **Web 侧目前仍写成 JSX 字面量**（e84d7ff 把它从「您好,」改成现在这句时没有
 * 下沉），只有 App 读这张表。下次改 Web 时请连这里一起改，否则又会漂。
 *
 * `emphasis` 对应 `<em>`：`showcase-multilingual.css` 里它只换颜色（`#3a9d3e`，
 * = `theme.color.speaking`）并把 `font-style` 摆回 normal；字重与字形跟着整行
 * 的 `p` 走（Songti 700，`0.48rem / 0.64rem`）。
 */
export const WELCOME_LEAD = {
  prefix: '欢迎体验',
  emphasis: '同声传译',
} as const

/** 欢迎态首行的整句（无强调时用它：无障碍朗读、日志与用例断言）。 */
export const WELCOME_LEAD_TEXT = `${WELCOME_LEAD.prefix}${WELCOME_LEAD.emphasis}`

/**
 * 单人会话字幕区的空态提示。逐字来自 Web `MultilingualShowcasePage.tsx` 的
 * `.realtime-showcase-listening`（`{visibleRows.length === 0 && …}`）。
 *
 * live-14：移动端此前是「正在等待第一段语音…」——描述系统在等，Web 那句是请
 * 用户开口，语气与信息量都不同。与 `WELCOME_COPY` 同住这张表，避免下一次改
 * Web 时移动端又漏改。
 */
export const TRANSCRIPT_LISTENING_PLACEHOLDER = '请开始说话，翻译结果将在这里显示…'

/**
 * 设置面板的标题 + 副标题（Web `.realtime-showcase-settings-title`）。
 * 会话进行中两种模式共用「会话设备」一档——面板这时只剩当场生效的设备切换。
 */
export const SETTINGS_PANEL_COPY: Record<SessionModeKey | 'busy', { title: string; subtitle: string }> = {
  solo: { title: '快速开始模式设置', subtitle: '一份输入，并发输出' },
  duo: { title: '双麦多语设置', subtitle: '双方自动识别 · 独立多语输出' },
  busy: { title: '会话设备', subtitle: '切换失败时继续使用原设备' },
}

/**
 * 面板标题 / 副标题的五态收敛。
 *
 * **标题与副标题看的不是同一个量**（Web `MultilingualShowcasePage.tsx` 两处
 * 面板头都是 `<strong>{busy ? busy.title : mode.title}</strong>` +
 * `<span>{recording ? busy.subtitle : mode.subtitle}</span>`）：
 *   - `sessionActive` = busy（connecting / recording / paused / processing）；
 *   - `recording`     = 真正在采集（Web 的 `status === 'recording'`；Web 没有
 *     独立的 paused 状态，暂停时 status 仍是 recording，所以移动端对应的是
 *     `recording || paused`，与 SettingsSheet 那条设备区门控同一个量）。
 *
 * 差在 connecting / processing 两态：那时面板里只有一句「会话正在连接或结束
 * 处理中，暂时没有可调整的选项」，副标题若还写着「切换失败时继续使用原设备」
 * 就与它自相矛盾。缺省（不传 recording）按 sessionActive 走，与旧行为一致。
 */
export function settingsPanelCopy(
  mode: SessionModeKey,
  sessionActive: boolean,
  recording: boolean = sessionActive,
): { title: string; subtitle: string } {
  return {
    title: sessionActive ? SETTINGS_PANEL_COPY.busy.title : SETTINGS_PANEL_COPY[mode].title,
    subtitle: recording ? SETTINGS_PANEL_COPY.busy.subtitle : SETTINGS_PANEL_COPY[mode].subtitle,
  }
}
