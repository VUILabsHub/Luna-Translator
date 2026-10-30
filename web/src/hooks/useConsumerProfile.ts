import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DISPLAY_NAME_PROBLEM_MESSAGES, validateDisplayName } from '@simultrans/core/profile'
import { analyticsAccountId } from '@simultrans/ui-shared/src/lib/analyticsConsent'
import { usePublicConfig } from '@simultrans/ui-shared/src/lib/config'
import { consumerFetch, createConsumerSessionGuard, getConsumerSessionRevision, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'
import { CanaryGuestContext } from '../lib/canaryGuest'
import { CONSUMER_PROFILE_PATH, cachedProfileName, consumerProfile, fetchConsumerProfile, profileNamesEnabled, rememberProfileName } from '../lib/profile'

function subscribeAccount(onChange: () => void) {
  const unsubscribe = subscribeConsumerSession(onChange)
  window.addEventListener('consumer:session-changed', onChange)
  window.addEventListener('consumer:session-expired', onChange)
  return () => {
    unsubscribe()
    window.removeEventListener('consumer:session-changed', onChange)
    window.removeEventListener('consumer:session-expired', onChange)
  }
}
const accountSnapshot = () => JSON.stringify([analyticsAccountId(), getConsumerSessionRevision()])

/** Homepage and general settings use the account profile, never a meeting name or phone number. */
export function useConsumerProfile(active = true) {
  const snapshot = useSyncExternalStore(subscribeAccount, accountSnapshot, () => '["",0]')
  const [accountId] = JSON.parse(snapshot) as [string, number]
  const guest = useContext(CanaryGuestContext) || !accountId
  const { config } = usePublicConfig()
  const enabled = active && !guest && profileNamesEnabled(config)
  // Photos are not persisted in a browser cache: a replacement login starts without the old image.
  const [state, setState] = useState({ snapshot, name: cachedProfileName(accountId) ?? '', avatarUrl: '' })
  const generation = useRef(0)
  const savingController = useRef<AbortController | null>(null)

  useEffect(() => {
    ++generation.current
    savingController.current?.abort()
    if (!enabled) return
    const currentSession = createConsumerSessionGuard()
    let controller: AbortController | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      controller?.abort()
      clearTimeout(timeout)
      const pending = new AbortController()
      controller = pending
      const revision = ++generation.current
      timeout = setTimeout(() => pending.abort(), 8_000)
      void fetchConsumerProfile(consumerFetch, pending.signal).then(profile => {
        if (pending.signal.aborted || revision !== generation.current || !currentSession() || analyticsAccountId() !== accountId) return
        // A transient refresh failure does not mean the server removed this
        // profile. A successful empty avatar still clears it immediately.
        if (!profile) return
        if (profile.name) rememberProfileName(accountId, profile.name)
        setState({ snapshot, name: profile.name, avatarUrl: config?.profile?.avatar === true ? profile.avatarUrl : '' })
      }).finally(() => { if (controller === pending) clearTimeout(timeout) })
    }
    refresh()
    // Uploads happen in the App. Returning to Web refreshes immediately; an open page also observes replacements/removals.
    const interval = typeof window !== 'undefined' ? setInterval(refresh, 30_000) : undefined
    if (typeof window !== 'undefined') window.addEventListener('focus', refresh)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
    return () => {
      controller?.abort(); savingController.current?.abort(); clearTimeout(timeout); clearInterval(interval)
      if (typeof window !== 'undefined') window.removeEventListener('focus', refresh)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh)
    }
  }, [snapshot, accountId, enabled, config?.profile?.avatar])

  const saveName = useCallback(async (value: string): Promise<string | null> => {
    if (!enabled || analyticsAccountId() !== accountId) return '请登录后设置名字'
    const checked = validateDisplayName(value)
    if (!checked.ok) return DISPLAY_NAME_PROBLEM_MESSAGES[checked.reason]
    const currentSession = createConsumerSessionGuard()
    const controller = new AbortController()
    savingController.current?.abort()
    savingController.current = controller
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await consumerFetch(CONSUMER_PROFILE_PATH, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: checked.value }), signal: controller.signal })
      if (controller.signal.aborted || !currentSession() || analyticsAccountId() !== accountId) return '登录状态已变化，请重新打开设置'
      const body = await response.json().catch(() => null)
      if (controller.signal.aborted || !currentSession() || analyticsAccountId() !== accountId) return '登录状态已变化，请重新打开设置'
      if (!response.ok) {
        if (response.status === 429) return '今天修改次数过多，请明天再试'
        if (response.status === 404 || response.status === 405) return '当前环境暂不支持修改名字'
        if (response.status === 400 && body?.reason && Object.hasOwn(DISPLAY_NAME_PROBLEM_MESSAGES, body.reason)) return DISPLAY_NAME_PROBLEM_MESSAGES[body.reason as keyof typeof DISPLAY_NAME_PROBLEM_MESSAGES]
        return '保存失败，请稍后重试'
      }
      const profile = consumerProfile(body)
      const name = profile.name
      if (!name) return '保存失败，请稍后重试'
      ++generation.current // A read started before this rename cannot overwrite it.
      rememberProfileName(accountId, name)
      setState({ snapshot, name, avatarUrl: config?.profile?.avatar === true ? profile.avatarUrl : '' })
      return null
    } catch { return '保存失败，请检查网络后重试' }
    finally { clearTimeout(timeout) }
  }, [accountId, snapshot, enabled, config?.profile?.avatar])

  const current = enabled && state.snapshot === snapshot
  return { guest, enabled, identity: snapshot, name: current ? state.name : '', avatarUrl: current && config?.profile?.avatar === true ? state.avatarUrl : '', saveName }
}
