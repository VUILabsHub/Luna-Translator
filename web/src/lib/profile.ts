// 账号资料一期（只在 Canary 候选环境开：/api/config 的 profile.name 为 true；prod 没有会议，不收资料名）。
// 首页与通用设置读取账号资料，入会页用资料名预填；本场会议临时改名不回写资料。
// 名字规则与取字规则都在 core 的 profile.ts（与 App、后端同一份向量）。
import { DISPLAY_NAME_PROBLEM_MESSAGES, validateDisplayName } from '@simultrans/core/profile'
import type { PublicConfig } from '@simultrans/ui-shared/src/lib/config'

/** 资料接口（backend/server/consumer_profile.go）：只在隔离候选上注册，开关见 profileNamesEnabled。 */
export const CONSUMER_PROFILE_PATH = '/api/consumer/profile'

export type ProfileFetcher = (path: string, init?: RequestInit) => Promise<Response>

/** Only server-owned opaque image paths may be rendered. Never send readers to an arbitrary image host. */
export function profileAvatarUrl(value: unknown): string {
  return typeof value === 'string' && /^\/api\/avatars\/[a-f0-9]{48}\.jpg$/.test(value) ? value : ''
}

export type ConsumerProfile = { name: string; avatarUrl: string }
export function consumerProfile(body: unknown): ConsumerProfile {
  return {
    name: profileDisplayName(body) ?? '',
    avatarUrl: profileAvatarUrl(body && typeof body === 'object' ? (body as { avatarUrl?: unknown }).avatarUrl : undefined),
  }
}

export async function fetchConsumerProfile(fetcher: ProfileFetcher, signal?: AbortSignal): Promise<ConsumerProfile | null> {
  try {
    const response = await fetcher(CONSUMER_PROFILE_PATH, { signal })
    return response.ok ? consumerProfile(await response.json()) : null
  } catch { return null }
}

/** /api/config 是否下发了 profile.name = true。缺字段、老服务端、配置没加载完都当作没开（不请求资料接口）。 */
export function profileNamesEnabled(config: Pick<PublicConfig, 'profile'> | null | undefined): boolean {
  // 只认严格的 true：JSON 里写成 "true"、profile 不是对象（老服务端 / 配置写错）都算没开。
  return config?.profile?.name === true
}

/**
 * 资料接口返回体里能拿来预填的名字：按 core 规则规整、校验通过才算。没设过名字（空串）、字段缺失、
 * 不合规（规则收紧后的老名字）都返回 null，入会页退回本机记住的名字，不预填一个服务端会拒的名字。
 */
export function profileDisplayName(body: unknown): string | null {
  const raw = body && typeof body === 'object' ? (body as { displayName?: unknown }).displayName : undefined
  if (typeof raw !== 'string') return null
  const result = validateDisplayName(raw)
  return result.ok ? result.value : null
}

/** GET /api/consumer/profile 拿资料名；请求失败、非 2xx、返回体不是 JSON 都是 null（不能挡住手填）。 */
export async function fetchProfileDisplayName(fetcher: ProfileFetcher, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetcher(CONSUMER_PROFILE_PATH, { signal })
    if (!response.ok) return null
    return profileDisplayName(await response.json())
  } catch {
    return null
  }
}

/**
 * 入会页名字从哪来：none 空 / loading 资料名请求中（留空）/ saved 本机记住的（上次在入会页填的）/ profile 资料名 /
 * typed 本页用户刚输入的。优先级：资料名 > 本机记住的 > 空；用户在本页动过就不再被晚到的资料名覆盖。
 * loading 时名字是空的（提交按钮因空名不可点）：不先显示本机记住的名字，免得它闪一下就被资料名换掉，
 * 或者在请求那几百毫秒里被提交出去。
 */
export type MeetingNameSource = 'none' | 'loading' | 'saved' | 'profile' | 'typed'
export type MeetingNameState = { accountId: string; name: string; source: MeetingNameSource }

/**
 * 资料请求结束时：拿到资料名就换掉同一账号下还没被用户动过的名字；没拿到（没设过、不合规、失败、超时）只把
 * 还在 loading 的空名字落回本机记住的 saved（没有就保持空）。换了账号、用户已经在输的一律不动。
 */
export function applyProfileName(previous: MeetingNameState, accountId: string, profileName: string | null, saved: string | null = null): MeetingNameState {
  if (previous.accountId !== accountId || previous.source === 'typed') return previous
  if (profileName) {
    if (previous.source === 'profile' && previous.name === profileName) return previous
    return { accountId, name: profileName, source: 'profile' }
  }
  if (previous.source !== 'loading') return previous
  return saved ? { accountId, name: saved, source: 'saved' } : { accountId, name: '', source: 'none' }
}

/**
 * 本页（内存里）最近一次拿到的资料名，按账号存。Web 每个路径都是整页加载（main.tsx 按 pathname 选页面，
 * 进入会页是 window.location.assign），所以它只在同一页里换账号再换回来时省一次等待；整页打开入会页时
 * 这里总是空的，名字先留空等资料请求（见 MeetingNameSource 的 loading）。
 * 不落 localStorage——资料名以服务端为准，每次打开入会页都会重新取。
 */
const profileNames = new Map<string, string>()
export function rememberProfileName(accountId: string, name: string): void {
  if (accountId) profileNames.set(accountId, name)
}
export function cachedProfileName(accountId: string): string | null {
  return (accountId && profileNames.get(accountId)) || null
}
export function clearCachedProfileNames(): void { profileNames.clear() }

const DISPLAY_NAME_MESSAGES = new Set<string>(Object.values(DISPLAY_NAME_PROBLEM_MESSAGES))

/**
 * 建会 / 入会 / 游客入会时服务端回 400 display_name_invalid，error 就是 core DISPLAY_NAME_PROBLEM_MESSAGES 里
 * 的那几句（后端同字），入会页据此把它放到名字输入框下面。不是名字问题返回 null，照旧放在页面顶部的提示里。
 */
export function displayNameErrorMessage(error: string | null | undefined): string | null {
  return error && DISPLAY_NAME_MESSAGES.has(error) ? error : null
}
