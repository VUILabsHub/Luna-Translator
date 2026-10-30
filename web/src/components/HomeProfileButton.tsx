import { useConsumerProfile } from '../hooks/useConsumerProfile'
import { MeetingAvatar } from './MeetingAvatar'

/** Same left-hand account entry as iOS; the right-hand menu remains mode settings. */
export function HomeProfileButton({ loginHref, onLogin }: { loginHref?: string; onLogin?: () => void }) {
  const { guest, name, avatarUrl } = useConsumerProfile()
  const currentPath = typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`
  return <a className={`canary-home-profile${guest ? ' is-guest' : ''}`}
    href={guest ? loginHref || currentPath : `/settings?from=${encodeURIComponent(currentPath)}`}
    onClick={guest && onLogin ? event => { event.preventDefault(); onLogin() } : undefined}
    aria-label={guest ? '登录' : '我的资料，打开通用设置'}>
    <MeetingAvatar name={guest ? '' : name} avatarUrl={guest ? undefined : avatarUrl} className="canary-profile-avatar" size={36} />
  </a>
}
