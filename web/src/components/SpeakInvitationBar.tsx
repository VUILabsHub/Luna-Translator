export function SpeakInvitationBar({ shared, stopped, busy, error, onSelect }: {
  shared: boolean; stopped: boolean; busy: boolean; error?: string; onSelect: (method: 'qr' | 'link') => void
}) {
  return <div className="speak-invitation-bar is-compact">
    <span className="speak-invitation-status" role={error ? 'alert' : undefined} aria-label={error || undefined} title={error}>{stopped ? '分享已结束' : error ? shared ? '分享连接异常' : '分享未开启' : busy ? '正在创建…' : shared ? '分享已开启' : '邀请听众'}</span>
    <div className="speak-invitation-actions">
      <button type="button" disabled={busy} aria-label="展示二维码" onClick={() => onSelect('qr')}>二维码</button>
      <button type="button" disabled={busy} aria-label="分享链接" onClick={() => onSelect('link')}>分享链接</button>
    </div>
  </div>
}
