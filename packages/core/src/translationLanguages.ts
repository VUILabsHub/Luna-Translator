/** Explicit input languages cannot also be translation targets. Auto has no exclusion. */
export function translationTargets(source: string, selected: readonly string[], available: readonly string[]): string[] {
  const allowed = available.filter(code => code !== source && code !== 'auto')
  const retained = [...new Set(selected)].filter(code => allowed.includes(code))
  if (retained.length || selected.length === 0) return retained
  const fallback = ['en', 'zh', ...allowed].find(code => allowed.includes(code))
  return fallback ? [fallback] : []
}
