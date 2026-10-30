// 手机浏览器判定：只用于决定是否展示「手机通话模式」这类仅对手机有意义的选项。
type NavigatorWithUAData = Navigator & { userAgentData?: { mobile?: boolean } }

export function isMobileBrowser(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false
  // Client Hints 明确说是手机就信；说不是手机时仍看 UA（Playwright / 桌面模式站点等会改 UA 但不改 hints）。
  const uaData = (nav as NavigatorWithUAData).userAgentData
  if (uaData?.mobile === true) return true
  const userAgent = nav.userAgent || ''
  if (/iPad|iPhone|iPod|Android/i.test(userAgent)) return true
  // iPadOS 13+ 的 Safari 伪装成 Mac，用触点数兜底。
  return /Macintosh/.test(userAgent) && typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1
}
