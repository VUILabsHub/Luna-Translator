// 设置面板「设备模式 / 翻译模型 / TTS 模型」信息弹窗的说明数据。
// 内容以代码事实为准：预设映射见 MultilingualShowcasePage.tsx 的
// showcaseNoisePresetSettings；引擎/TTS 能力见 backend/providers/luna/gateway_s2st.go
// （源语言 auto 支持；仅 OmniVoice 支持的目标语言由 server.go multilingualTargetProviderID 自动路由）。

export type ShowcaseSettingsInfoTopic = 'noise' | 'translation' | 'tts'

export type ShowcaseSettingsInfoRow = {
  /** 下拉里显示的名称。 */
  name: string
  /** 底层引擎 / 路由说明；不需要展示参数的主题可省略。 */
  engine?: string
  /** 适用场景与能力差异。 */
  summary: string
  /** 关键差异点，逐条列出。 */
  points: string[]
  /** 对比表格的单元格（不含名称列）。 */
  cells?: string[]
  /** 是否为推荐项。 */
  recommended?: boolean
}

export type ShowcaseSettingsInfo = {
  title: string
  intro: string
  /** 有列定义时以对比表格展示（cells 与 columns 一一对应），否则展示卡片列表。 */
  columns?: string[]
  rows: ShowcaseSettingsInfoRow[]
}

export const showcaseSettingsInfo: Record<ShowcaseSettingsInfoTopic, ShowcaseSettingsInfo> = {
  noise: {
    title: '设备模式',
    intro: '按设备和环境选择。手机浏览器接了耳机或外接麦克风时用耳机收声，否则用系统降噪；其余情况沿用原有设置。',
    columns: ['场景', '设备', '效果'],
    rows: [
      {
        name: '耳机收声',
        recommended: true,
        summary: '默认方案，戴耳机使用；手机接耳机或外接麦克风时自动选用。',
        points: [],
        cells: ['安静室内、日常会议与学习；手机接耳机时', '有线或蓝牙耳机、外接麦克风', '声音不做处理，识别最准、延迟最低'],
      },
      {
        name: '系统降噪',
        summary: '扬声器外放时使用；手机浏览器不接耳机时的默认方案，采集走系统通话链路。',
        points: [],
        cells: ['电脑外放、小型会议室；手机外放、走路、车里', '不戴耳机。电脑 Chrome 需开启系统级回声消除（首次有引导）；手机用自带麦克风', '消除译文外放回录；手机走系统通话级回声消除与降噪，音色略变'],
      },
    ],
  },
  translation: {
    title: '翻译模型',
    intro: 'Luna-Live Translation 系列（Luna-LT）。当前使用 Flash v2，面向实时同传优化。',
    columns: ['推荐', '输入', '输出', '速度'],
    rows: [
      // 翻译模型在页面里锁定为 Flash v2（MultilingualShowcasePage 的 translationModel 常量），
      // 说明表只展示这一行，不再列 Flash / Pro。
      {
        name: 'Flash v2',
        recommended: true,
        summary: '默认推荐，面向实时同传优化。',
        points: [],
        cells: ['默认', '自动 / 中 / 英 / 日 / 韩', '最多 18 种', '最快'],
      },
    ],
  },
  tts: {
    title: '使用场景',
    intro: '正式宣讲：默认，口音最自然；日常对话：出声最快。两者都支持 18 种输出语言与音色克隆。',
    columns: ['推荐', '输出'],
    rows: [
      {
        name: '正式宣讲',
        recommended: true,
        summary: '默认推荐，正式场景首选，口音最自然。',
        points: [],
        cells: ['默认 · 口音最自然', '18 种（中英日韩德法俄葡西意及阿拉伯语、越南语、泰语等）'],
      },
      {
        name: '日常对话',
        summary: '日常对话首选，轻量实时合成，出声最快。',
        points: [],
        cells: ['出声最快', '18 种（同上）'],
      },
    ],
  },
}
