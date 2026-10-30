// Keep the live wire contract aligned with history: all audio offsets are integer milliseconds.
function milliseconds(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}
function offsets(values?: Record<string, number>) {
  return Object.fromEntries(Object.entries(values || {}).flatMap(([language, value]) => {
    const ms = milliseconds(value)
    return language && ms !== undefined ? [[language, ms]] : []
  }))
}
export function normalizeLiveShareSnapshot<T extends { durationMs: number; units: { startMs?: number; outputAudioStarts?: Record<string, number>; outputAudioEnds?: Record<string, number> }[] }>(snapshot: T) {
  return { ...snapshot, durationMs: milliseconds(snapshot.durationMs) ?? 0,
    units: snapshot.units.map(unit => ({ ...unit, startMs: milliseconds(unit.startMs),
      outputAudioStarts: offsets(unit.outputAudioStarts), outputAudioEnds: offsets(unit.outputAudioEnds) })) }
}
export async function liveShareRequestError(response: Response): Promise<Error> {
  const messages: Record<number, string> = { 400: '分享内容格式不正确，请刷新页面后重试', 401: '登录已过期，请重新登录后分享', 403: '当前账号无权分享此会话', 404: '同传会话不存在或已失效，请重新开始同传后分享', 410: '分享链接已失效', 413: '分享内容过大，请结束同传后分享记录', 429: '分享创建过于频繁，请稍后再试', 500: '分享存储暂不可用，请稍后重试', 502: '分享服务暂不可用，请稍后重试', 503: '分享服务暂不可用，请稍后重试' }
  return new Error(`${messages[response.status] || '暂时无法创建分享，请稍后重试'}（${response.status}）`)
}
