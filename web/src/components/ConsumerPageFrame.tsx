// C 端「设置」「历史记录」等二级页共用的 9:16 页框：桌面居中手机框、手机竖屏
// 撑满视口（媒体查询与 styles/root-scale.css 一致），顶部 89 高白条 + 「‹ 返回」。
// 尺寸全部按设计稿 521 宽画板写成 N/100 rem（见 styles/consumer-page.css）。
// 返回控件：给 backHref 渲染 <a>，给 onBack 渲染 <button>（历史页的 Playwright
// 用 getByRole('button', { name: '返回' }) 找它）。
import type { ReactNode } from 'react'

type ConsumerPageFrameProps = {
  children: ReactNode
  /** 返回控件跳转地址（渲染 <a>）。 */
  backHref?: string
  /** 返回控件点击回调（渲染 <button>）；与 backHref 同时给时以 backHref 为准。 */
  onBack?: () => void
  /** 外层 section 的 aria-labelledby（页标题 id）。 */
  labelledBy?: string
  /** 追加到外层 section 的类名，页面据此覆写内容列布局。 */
  className?: string
  title?: ReactNode
  footer?: ReactNode
}

export default function ConsumerPageFrame({ children, backHref, onBack, labelledBy, className, title, footer }: ConsumerPageFrameProps) {
  const backContent = (
    <>
      <img src="/showcase/chevron-left.svg" alt="" aria-hidden="true" />
      返回
    </>
  )
  return (
    <section className={`consumer-page${className ? ` ${className}` : ''}`} aria-labelledby={labelledBy}>
      <div className="consumer-page-device">
        <header className="consumer-page-topbar">
          {backHref ? (
            <a className="consumer-page-back" href={backHref}>{backContent}</a>
          ) : (
            <button type="button" className="consumer-page-back" onClick={onBack}>{backContent}</button>
          )}
          {title}
        </header>
        <div className="consumer-page-scroll">
          <div className="consumer-page-content">{children}</div>
        </div>
        {footer && <footer className="consumer-page-footer">{footer}</footer>}
      </div>
    </section>
  )
}
