/** Shared return control for active sessions and finished/history views. */
export function ShowcaseBackButton({ href, ariaLabel = '返回', disabled, onClick }: {
  href?: string
  ariaLabel?: string
  disabled?: boolean
  onClick?: () => void
}) {
  const content = <><span aria-hidden="true">‹</span> 返回</>
  return href
    ? <a className="showcase-back" href={href} aria-label={ariaLabel} onClick={onClick}>{content}</a>
    : <button type="button" className="showcase-back" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>{content}</button>
}
