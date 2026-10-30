import { PROFILE_AVATAR_GRADIENT, profileAvatarText } from '@simultrans/core/profile'
import { useState } from 'react'
import { apiURL } from '@simultrans/ui-shared/src/lib/apiBase'
import { canaryDesignEnabled } from '../lib/canaryDesign'
import { profileAvatarUrl } from '../lib/profile'

/**
 * 会议里的生成头像（Canary，与 App 的会议头像、通用设置资料头同一规则）：Canary 绿渐变圆 + 白字。
 * 字按 core profileAvatarText 取：名字里最后两个汉字 / 假名 / 谚文（李盛园 → 盛园），拉丁名取首末词首字母
 * （Yu Sheng → YS）；取不到字（纯数字、符号、emoji、空名字）画人形。小于 28 的尺寸只放一个字。
 * App 上传的头像只展示服务端图片地址，撤下或加载失败时退回生成头像。圆的尺寸和位置沿用调用方的 class，
 * 这里只盖底色、字色和字号；名字由旁边的文字读出，头像本身对读屏隐藏。
 */
export function MeetingAvatar({ name, avatarUrl, className, size = 32 }: { name: string; avatarUrl?: string; className: string; size?: number }) {
  const [failedUrl, setFailedUrl] = useState('')
  const safeUrl = profileAvatarUrl(avatarUrl)
  const imageUrl = safeUrl && safeUrl !== failedUrl ? apiURL(safeUrl) : ''
  const text = profileAvatarText(name, size < 28 ? 1 : 2)
  const fontSize = Math.round(size * (text && Array.from(text).length > 1 ? 0.35 : 0.375) * 10) / 10
  return <span className={className} aria-hidden="true" data-avatar={imageUrl ? 'image' : text ? 'text' : 'person'}
    style={{ background: PROFILE_AVATAR_GRADIENT, color: '#fff', fontSize, fontWeight: 600, lineHeight: 1 }}>
    {imageUrl ? <img src={imageUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(safeUrl)}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} /> : text ?? <PersonGlyph size={Math.round(size * 0.56)} />}
  </span>
}

/**
 * 参会成员列表里的头像：Canary 主机用上面的生成头像；其他环境（prod）原样保留首字圆（底色走 .meeting-avatar 的 CSS）。
 * 门控放在这里，测试能直接覆盖两条分支（成员面板是入会页内部状态，静态渲染打不开）。
 */
export function MeetingMemberAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return canaryDesignEnabled()
    ? <MeetingAvatar name={name} avatarUrl={avatarUrl} className="meeting-avatar" />
    : <span className="meeting-avatar" aria-hidden="true">{Array.from(name)[0]}</span>
}

function PersonGlyph({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <circle cx="12" cy="8" r="4.25" /><path d="M3.5 21c0-4.4 3.8-7.25 8.5-7.25s8.5 2.85 8.5 7.25z" />
  </svg>
}
