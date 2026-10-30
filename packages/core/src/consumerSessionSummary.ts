/** Consumer-facing history summary. Detailed snapshots remain unchanged. */
export function consumerSessionSummaryRows(
  settings: Record<string, unknown> | undefined,
  modeLabel: string,
  languageName: (code: string) => string,
): Array<[string, string]> {
  if (!settings) return []
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const source = text(settings.sourceLanguage)
  const targets = Array.isArray(settings.targetLanguages)
    ? [...new Set(settings.targetLanguages.map(text).filter(Boolean))] : []
  const voice = settings.voiceMode === 'clone' ? '保留原声音色'
    : settings.voiceMode === 'default' ? '系统音色'
    : typeof settings.voiceClone === 'boolean' ? settings.voiceClone ? '保留原声音色' : '系统音色' : ''
  return [
    ['模式', text(settings.mode) || text(settings.scene) ? modeLabel : ''],
    ['输入语言', source ? languageName(source) : ''],
    ['输出语言', targets.map(languageName).join(' / ')],
    ['译音', voice],
  ].filter((row): row is [string, string] => Boolean(row[1]))
}
