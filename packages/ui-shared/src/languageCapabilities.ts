// Change record (2026-08-13): expose zh/en/ja/ko for Omni S2ST, use only auto
// as the Qwen2.5 source choice, and require an explicit Qwen3 source language.
export type LanguageOption = {
  code: string
  name: string
  disabled?: boolean
  limitation?: string
}

const options = (entries: Array<[string, string]>): LanguageOption[] => entries.map(([code, name]) => ({ code, name }))

export const qwenAudioLanguages = options([
  ['zh', '中文'], ['en', 'English'], ['ar', '阿拉伯语'], ['de', 'Deutsch'], ['fr', 'Français'],
  ['es', 'Español'], ['pt', 'Português'], ['id', 'Bahasa Indonesia'], ['it', 'Italiano'], ['ko', '한국어'],
  ['ru', 'Русский'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['ja', '日本語'], ['tr', 'Türkçe'],
  ['hi', 'हिन्दी'], ['ms', 'Bahasa Melayu'], ['nl', 'Nederlands'], ['ur', 'اردو'], ['nb', 'Norsk bokmål'],
  ['sv', 'Svenska'], ['da', 'Dansk'], ['he', 'עברית'], ['fi', 'Suomi'], ['pl', 'Polski'],
  ['is', 'Íslenska'], ['cs', 'Čeština'], ['fil', 'Filipino'], ['fa', 'فارسی'],
])

export const qwenTextOnlyLanguages: LanguageOption[] = options([
  ['yue', '粤语'], ['el', 'Ελληνικά'], ['af', 'Afrikaans'], ['ast', 'Asturianu'], ['be', 'Беларуская'],
  ['bg', 'Български'], ['bn', 'বাংলা'], ['bs', 'Bosanski'], ['ca', 'Català'], ['ceb', 'Cebuano'],
  ['et', 'Eesti'], ['gl', 'Galego'], ['gu', 'ગુજરાતી'], ['hr', 'Hrvatski'], ['hu', 'Magyar'],
  ['jv', 'Basa Jawa'], ['kk', 'Қазақша'], ['kn', 'ಕನ್ನಡ'], ['ky', 'Кыргызча'], ['lv', 'Latviešu'],
  ['mk', 'Македонски'], ['ml', 'മലയാളം'], ['mr', 'मराठी'], ['pa', 'ਪੰਜਾਬੀ'], ['ro', 'Română'],
  ['sk', 'Slovenčina'], ['sl', 'Slovenščina'], ['sw', 'Kiswahili'], ['tg', 'Тоҷикӣ'], ['az', 'Azərbaycanca'],
  ['uk', 'Українська'],
]).map((language) => ({ ...language, disabled: true, limitation: '仅文本输出' }))

export const qwenSourceLanguages = [...qwenAudioLanguages, ...qwenTextOnlyLanguages.map(({ disabled: _disabled, limitation: _limitation, ...language }) => language)]
export const qwenTargetLanguages = [...qwenAudioLanguages, ...qwenTextOnlyLanguages]
export const qwenSourceCodes = new Set(qwenSourceLanguages.map(({ code }) => code))
export const qwenAudioTargetCodes = new Set(qwenAudioLanguages.map(({ code }) => code))

export const geminiLanguages = options([
  ['zh', '中文（简体）'], ['zh-Hant', '中文（繁体）'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'],
  ['id', 'Bahasa Indonesia'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['it', 'Italiano'], ['ru', 'Русский'],
  ['ar', 'العربية'], ['hi', 'हिन्दी'], ['tr', 'Türkçe'], ['nl', 'Nederlands'], ['pl', 'Polski'],
  ['af', 'Afrikaans'], ['ak', 'Akan'], ['sq', 'Shqip'], ['am', 'አማርኛ'], ['hy', 'Հայերեն'],
  ['az', 'Azərbaycanca'], ['eu', 'Euskara'], ['be', 'Беларуская'], ['ms', 'Bahasa Melayu'], ['bn', 'বাংলা'],
  ['ml', 'മലയാളം'], ['bg', 'Български'], ['mr', 'मराठी'], ['my', 'မြန်မာဘာသာ'], ['mn', 'Монгол'],
  ['ca', 'Català'], ['ne', 'नेपाली'], ['no', 'Norsk'], ['nb', 'Norsk bokmål'], ['fa', 'فارسی'],
  ['hr', 'Hrvatski'], ['cs', 'Čeština'], ['da', 'Dansk'], ['pa', 'ਪੰਜਾਬੀ'], ['ro', 'Română'],
  ['et', 'Eesti'], ['fil', 'Filipino'], ['sr', 'Српски'], ['fi', 'Suomi'], ['sd', 'سنڌي'],
  ['si', 'සිංහල'], ['gl', 'Galego'], ['sk', 'Slovenčina'], ['ka', 'ქართული'], ['sl', 'Slovenščina'],
  ['el', 'Ελληνικά'], ['su', 'Basa Sunda'], ['gu', 'ગુજરાતી'], ['sw', 'Kiswahili'], ['ha', 'Hausa'],
  ['sv', 'Svenska'], ['he', 'עברית'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'], ['hu', 'Magyar'],
  ['is', 'Íslenska'], ['uk', 'Українська'], ['ur', 'اردو'], ['uz', 'Oʻzbekcha'], ['jv', 'Basa Jawa'],
  ['kn', 'ಕನ್ನಡ'], ['zu', 'isiZulu'], ['kk', 'Қазақша'], ['km', 'ភាសាខ្មែរ'], ['rw', 'Kinyarwanda'],
  ['lo', 'ລາວ'], ['lv', 'Latviešu'], ['lt', 'Lietuvių'], ['mk', 'Македонски'],
])
export const geminiLanguageCodes = new Set(geminiLanguages.map(({ code }) => code))

export const volcCloneLanguages = options([
  ['zh', '中文'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'],
  ['es', 'Español'], ['id', 'Bahasa Indonesia'], ['ja', '日本語'], ['pt', 'Português'],
])
export const volcCloneLanguageCodes = new Set(volcCloneLanguages.map(({ code }) => code))

export const volcPresetSourceLanguages = options([
  ['zh', '中文'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'],
  ['id', 'Bahasa Indonesia'], ['ja', '日本語'], ['pt', 'Português'], ['ko', '한국어'], ['tr', 'Türkçe'],
  ['ms', 'Bahasa Melayu'], ['nl', 'Nederlands'], ['ro', 'Română'], ['pl', 'Polski'], ['cs', 'Čeština'],
  ['ar', 'العربية'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['ru', 'Русский'], ['it', 'Italiano'],
  ['yue-CN', '粤语'], ['sh-CN', '上海话'],
])

export const chineseEnglishLanguages = options([['zh', '中文'], ['en', 'English']])
export const chineseEnglishCodes = new Set(chineseEnglishLanguages.map(({ code }) => code))
export const qwenTTSTargetLanguages = options([
  ['zh', '中文'], ['en', 'English(英语)'], ['ja', '日本語(日语)'], ['ko', '한국어(韩语)'],
  ['de', 'Deutsch(德语)'], ['fr', 'Français(法语)'], ['ru', 'Русский(俄语)'], ['pt', 'Português(葡萄牙语)'],
  ['es', 'Español(西班牙语)'], ['it', 'Italiano(意大利语)'],
])
export const omniTargetLanguages = options([
  ...qwenTTSTargetLanguages.map(({ code, name }) => [code, name] as [string, string]),
  ['ar', 'العربية(阿拉伯语)'], ['id', 'Bahasa Indonesia(印尼语)'], ['vi', 'Tiếng Việt(越南语)'], ['th', 'ไทย(泰语)'],
  ['ms', 'Bahasa Melayu(马来语)'], ['ur', 'اردو(乌尔都语)'], ['tr', 'Türkçe(土耳其语)'], ['sw', 'Kiswahili(斯瓦希里语)'],
])
export const omniTargetCodes = new Set(omniTargetLanguages.map(({ code }) => code))
export const qwen25OmniSourceLanguages = options([['auto', '自动识别']])
export const qwen3OmniSourceLanguages = options([['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어']])
export const qwen3SimulSourceLanguages = [
  ...qwen25OmniSourceLanguages,
  ...qwen3OmniSourceLanguages,
]
export const qwen3OmniSourceCodes = new Set(qwen3OmniSourceLanguages.map(({ code }) => code))
export const isLunaProvider = (provider: string) => provider === 'luna' || provider === 'luna-qwen' || provider === 'luna-cosyvoice'
export const isQwen25OmniProvider = (provider: string) => provider.startsWith('vuilabs-qwen25-omni-')
export const isQwen3SimulProvider = (provider: string) => provider.startsWith('vuilabs-qwen3simul-')
export const isQwen3OmniProvider = (provider: string) => provider === 'qwen3-omni-qwen'
  || provider === 'qwen3-omni-cosyvoice'
  || provider.startsWith('vuilabs-qwen3-omni-')
  || isQwen3SimulProvider(provider)
export const isVUILabsOmniProvider = (provider: string) => provider.startsWith('vuilabs-qwen25-omni-')
  || provider.startsWith('vuilabs-qwen3-omni-')
  || provider.startsWith('vuilabs-qwen3simul-')
export const isOmniS2STProvider = (provider: string) => isQwen25OmniProvider(provider) || isQwen3OmniProvider(provider)
export const isOfficialQwen17BProvider = (provider: string) => provider.includes('qwen17b')
export const isMultilingualS2STProvider = (provider: string) => isOmniS2STProvider(provider)
  && (provider.endsWith('-qwen') || provider.endsWith('-qwen17b') || provider.endsWith('-qwentts-sc') || (provider.endsWith('-omnivoice') || provider.endsWith('-omnivoice-xc')))
export const isFixedCloneProvider = (provider: string) => isLunaProvider(provider)
  || (isOmniS2STProvider(provider) && !isOfficialQwen17BProvider(provider))
export const usesExperimentalWorkspaceUI = (provider: string) => isVUILabsOmniProvider(provider)
  || provider === 'luna-qwen'
  || provider === 'luna-cosyvoice'
  || provider === 'qwen3-omni-qwen'
  || provider === 'qwen3-omni-cosyvoice'

export const tencentSourceLanguages = options([
  ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['yue', '粤语'], ['id', 'Bahasa Indonesia'], ['th', 'ไทย'],
])
export const tencentSourceLanguageCodes = new Set(tencentSourceLanguages.map(({ code }) => code))

export const youdaoTargetLanguages = options([
  ['zh', '中文'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['ar', 'العربية'],
  ['ru', 'Русский'], ['pt', 'Português'], ['de', 'Deutsch'], ['ja', '日本語'], ['hi', 'हिन्दी'],
  ['ko', '한국어'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['sv', 'Svenska'], ['pl', 'Polski'],
  ['tr', 'Türkçe'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
])
export const youdaoSourceLanguages = [{ code: 'auto', name: '自动识别' }, ...youdaoTargetLanguages]
export const youdaoSourceLanguageCodes = new Set(youdaoSourceLanguages.map(({ code }) => code))
export const youdaoTargetLanguageCodes = new Set(youdaoTargetLanguages.map(({ code }) => code))

const tencentTargetCodesBySource: Record<string, string[]> = {
  zh: ['zh', 'en', 'ja', 'ko', 'yue', 'id', 'th'],
  en: ['zh', 'en', 'ja', 'ko', 'yue', 'id', 'th'],
  ja: ['zh', 'en', 'ja', 'ko', 'yue'],
  ko: ['zh', 'en', 'ja', 'ko', 'yue'],
  yue: ['zh', 'en', 'ja', 'ko', 'yue'],
  id: ['zh', 'en', 'id'],
  th: ['zh', 'en', 'th'],
}

const languageNameMap = new Map<string, string>()
for (const language of [...omniTargetLanguages, ...qwenSourceLanguages, ...geminiLanguages, ...volcPresetSourceLanguages, ...tencentSourceLanguages, ...youdaoSourceLanguages]) {
  if (!languageNameMap.has(language.code)) languageNameMap.set(language.code, language.name)
}

export function providerSourceLanguages(provider: string, voiceClone: boolean): LanguageOption[] {
  if (isQwen25OmniProvider(provider)) return qwen25OmniSourceLanguages
  if (isQwen3SimulProvider(provider)) return qwen3SimulSourceLanguages
  if (isQwen3OmniProvider(provider)) return qwen3OmniSourceLanguages
  if (provider === 'aliyun') return qwenSourceLanguages
  if (provider === 'gemini') return geminiLanguages
  if (provider === 'volcengine') return voiceClone ? volcCloneLanguages : volcPresetSourceLanguages
  if (provider === 'iflytek') return options([['zh', '中文']])
  if (isLunaProvider(provider)) return chineseEnglishLanguages
  if (provider === 'tencent') return tencentSourceLanguages
  if (provider === 'youdao') return youdaoSourceLanguages
  return chineseEnglishLanguages
}

export function providerTargetLanguages(provider: string, voiceClone: boolean, sourceLanguage: string): LanguageOption[] {
  if (isOmniS2STProvider(provider) && provider.endsWith("-qwentts-sc")) return omniTargetLanguages
  if (isOmniS2STProvider(provider)) return (provider.endsWith('-omnivoice') || provider.endsWith('-omnivoice-xc')) ? omniTargetLanguages : qwenTTSTargetLanguages
  if (provider === 'aliyun') return qwenTargetLanguages
  if (provider === 'gemini') return geminiLanguages
  if (provider === 'volcengine') {
    if (!voiceClone || !chineseEnglishCodes.has(sourceLanguage)) return chineseEnglishLanguages
    return volcCloneLanguages
  }
  if (provider === 'iflytek') return options([['en', 'English']])
  if (isLunaProvider(provider)) return chineseEnglishLanguages
  if (provider === 'tencent') {
    const codes = tencentTargetCodesBySource[sourceLanguage] || ['zh', 'en']
    return codes.map((code) => ({
      code,
      name: languageNameMap.get(code) || code,
      disabled: !chineseEnglishCodes.has(code),
      limitation: chineseEnglishCodes.has(code) ? undefined : '仅文本输出，当前产品要求语音',
    }))
  }
  if (provider === 'youdao') return youdaoTargetLanguages
  return chineseEnglishLanguages
}

export function languageName(code: string) {
  return languageNameMap.get(code) || code
}

export function selectableLanguageCount(languages: LanguageOption[]) {
  return languages.filter(({ disabled }) => !disabled).length
}
