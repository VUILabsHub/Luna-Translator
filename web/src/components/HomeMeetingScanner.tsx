import { useEffect, useRef, useState } from 'react'
import '../styles/home-meeting-scanner.css'

/** Codes and official meeting invitations only; a QR can never navigate to an arbitrary site. */
export function meetingCodeFromScan(value: string): string | null {
  const code = value.trim().replace(/[\s-]/g, '')
  if (/^\d{9}$/.test(code)) return code
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['simultrans-canary.lunalabs.cn', 'simultrans.lunalabs.cn'].includes(url.hostname) || url.pathname !== '/meeting') return null
    const code = (url.searchParams.get('code') || url.searchParams.get('join') || '').replace(/[\s-]/g, '')
    return /^\d{9}$/.test(code) ? code : null
  } catch { return null }
}

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
type DetectorConstructor = new (options: { formats: string[] }) => Detector

export function HomeMeetingScanner({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [notice, setNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    ++generation.current
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
  }
  const close = () => { stop(); setScanning(false); setOpen(false) }
  useEffect(() => {
    if (open) { dialog.current?.showModal(); input.current?.focus() }
    else if (dialog.current?.open) { dialog.current.close(); opener.current?.focus() }
  }, [open])
  useEffect(() => stop, [])
  const join = (text: string) => {
    const code = meetingCodeFromScan(text)
    if (!code) { setNotice('请输入九位会议码或有效的 Luna 会议邀请链接。'); return false }
    stop(); setScanning(false)
    window.location.assign(`/meeting?code=${code}`)
    return true
  }
  const startCamera = async () => {
    stop(); setNotice('')
    const Detector = (window as typeof window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
    if (!Detector || !navigator.mediaDevices?.getUserMedia) { setNotice('当前浏览器不支持网页扫码，请输入会议码，或用微信扫一扫打开邀请二维码。'); return }
    const revision = generation.current
    setScanning(true)
    try {
      const detector = new Detector({ formats: ['qr_code'] })
      const capture = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      if (revision !== generation.current) { capture.getTracks().forEach(track => track.stop()); return }
      stream.current = capture
      if (!video.current) { stop(); setScanning(false); return }
      video.current.srcObject = capture
      await video.current.play()
      const detect = async () => {
        if (revision !== generation.current || !video.current) return
        try {
          if (video.current.readyState >= 2) {
            const values = await detector.detect(video.current)
            if (revision !== generation.current) return
            const invitation = values.find(item => meetingCodeFromScan(item.rawValue))
            if (invitation && join(invitation.rawValue)) return
            if (values.length) setNotice('这不是 Luna 会议二维码，请扫描会议邀请或输入会议码。')
          }
        } catch { /* Retry a frame while the camera is starting. */ }
        if (revision === generation.current) timer.current = setTimeout(() => { void detect() }, 250)
      }
      void detect()
    } catch {
      if (revision !== generation.current) return
      stop(); setScanning(false)
      setNotice('无法打开相机，请检查权限，或直接输入会议码加入。')
    }
  }
  return <>
    <button ref={opener} type="button" className="canary-home-scan" aria-label="扫一扫" disabled={disabled} onClick={() => { setNotice(''); setOpen(true) }}><img src="/showcase/canary-figma/home-scan.svg" alt="" /></button>
    <dialog ref={dialog} className="home-meeting-scanner" aria-labelledby="home-meeting-scanner-title" onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === dialog.current) close() }}>
      <div className="home-meeting-scanner-content">
        <header><h2 id="home-meeting-scanner-title">扫码加入会议</h2><button type="button" aria-label="关闭扫码" onClick={close}>×</button></header>
        <form onSubmit={event => { event.preventDefault(); join(value) }}>
          <label htmlFor="home-meeting-code">会议码或邀请链接</label>
          <input ref={input} id="home-meeting-code" autoComplete="off" value={value} placeholder="输入九位会议码" onChange={event => { setValue(event.target.value); setNotice('') }} />
          <button type="submit">前往加入会议</button>
        </form>
        <video ref={video} autoPlay playsInline muted hidden={!scanning} aria-label="扫码相机预览" />
        <button type="button" className="home-meeting-scanner-camera" disabled={scanning} onClick={() => { void startCamera() }}>{scanning ? '正在扫码…' : '开启相机扫码'}</button>
        <p role="status">{notice || '仅扫描会议邀请，不会自动开启会议麦克风。'}</p>
      </div>
    </dialog>
  </>
}
