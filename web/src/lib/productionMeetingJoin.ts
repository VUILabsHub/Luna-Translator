// Enabled only by the separately built invitation entry, never the old Web app.
let enabled = false
export function configureProductionMeetingJoin(value: boolean) { enabled = value }
export function productionMeetingJoinEnabled() { return enabled }
export function productionMeetingInviteURL(origin: string, code: string): string {
  const url = new URL(`/api/mobile/v1/meeting-invite/${code}`, origin)
  return url.toString()
}
export function productionMeetingError(value: string): string {
  return enabled && /qwen|dashscope|aliyun|omnivoice|cosyvoice|volcengine|vuilabs[-_]/i.test(value)
    ? '会议语音服务暂不可用，请稍后重试' : value
}

/** Bounded requests for this entry only; other Web pages retain their transport. */
export async function productionMeetingFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!enabled) return fetch(url, init)
  const controller = new AbortController()
  const caller = init.signal
  let timedOut = false
  const relay = () => controller.abort(caller?.reason)
  if (caller?.aborted) relay()
  else caller?.addEventListener('abort', relay, { once: true })
  const deadline = /\/(?:access|capabilities)(?:[?]|$)/.test(url) ? 15000 : 60000
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, deadline)
  try { return await fetch(url, { ...init, signal: controller.signal }) }
  catch (error) {
    if (caller?.aborted) throw error
    throw new Error(timedOut ? '连接会议服务超时，请检查网络后重试' : '暂时无法连接会议服务，请检查网络后重试')
  } finally { clearTimeout(timer); caller?.removeEventListener('abort', relay) }
}
