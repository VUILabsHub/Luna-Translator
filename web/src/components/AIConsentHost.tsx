import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AI_PROCESSOR, answerAIConsent, closeAIConsentSettings, ensureAIConsent, getAIConsentSnapshot, hasAIConsent, mountAIConsentHost, revokeAIConsent, subscribeAIConsent } from '../lib/aiConsent'
import { canaryDesignEnabled } from '../lib/canaryDesign'
import '../styles/ai-consent.css'

export function AIConsentHost() {
  return <CanaryAIConsentHost />
}
function CanaryAIConsentHost() {
  const snapshot = useSyncExternalStore(subscribeAIConsent, getAIConsentSnapshot, () => null)
  const dialog = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [withdrawalError, setWithdrawalError] = useState('')
  useEffect(mountAIConsentHost, [])
  useEffect(() => {
    if (snapshot && dialog.current) {
      if (!dialog.current.open) { previousFocus.current = document.activeElement as HTMLElement; dialog.current.showModal() }
      dialog.current.querySelector<HTMLButtonElement>('button')?.focus()
    } else if (dialog.current?.open) { dialog.current.close(); setWithdrawalError(''); if (previousFocus.current?.isConnected) previousFocus.current.focus() }
  }, [snapshot?.id])
  const allowed = hasAIConsent()
  return <dialog ref={dialog} className="ai-consent-dialog" aria-labelledby="ai-consent-title" onCancel={event => { event.preventDefault(); closeAIConsentSettings() }}>
    <div className="ai-consent-content"><h2 id="ai-consent-title">AI 数据授权</h2>
      <p>同传需要将您的语音、识别原文、目标语言，以及您配置的热词和自定义翻译提示词发送给 {AI_PROCESSOR}，用于语音识别、翻译和生成译音。</p>
      <p>处理仅用于完成本次同传；不会用于身份识别。拒绝授权仍可浏览页面和查看历史，无法发起真实 AI 同传。模拟模式的音频仅进入本机社区后端。</p>
      <p>声音克隆涉及音色特征处理，仍遵循对应模式的独立告知和选择；本授权不会代替或开启声音克隆。</p>
      <p>您可在「社区版设置 → AI 数据授权」撤销。撤销后正在发送的语音将立即停止，已有字幕和已接收音频会安全收尾。</p>
      <p>详见<a href="/legal/privacy-policy" target="_blank" rel="noreferrer">《隐私政策》</a>。</p>
      {withdrawalError && <p role="alert" className="ai-consent-error">{withdrawalError}</p>}
      <div className="ai-consent-actions">{snapshot?.kind === 'request' ? <><button type="button" onClick={() => answerAIConsent(false)}>暂不授权</button><button type="button" className="is-primary" onClick={() => answerAIConsent(true)}>同意并继续</button></> : <><button type="button" onClick={closeAIConsentSettings}>关闭</button>{allowed || withdrawalError ? <button type="button" className="is-primary" onClick={() => { if (!revokeAIConsent()) setWithdrawalError('本页面已停止发送，但撤销未保存。请在其他页面停止发送，检查浏览器存储后重试。') }}>{withdrawalError ? '重试撤销' : '撤销授权'}</button> : <button type="button" className="is-primary" onClick={() => { closeAIConsentSettings(); void ensureAIConsent() }}>前往授权</button>}</>}</div>
    </div>
  </dialog>
}
