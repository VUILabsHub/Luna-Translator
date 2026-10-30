/** A persistent cue for available audio; the active icon also describes the stop action. */
export function SentencePlaybackIcon({ playing = false, fullTrack = false }: { playing?: boolean; fullTrack?: boolean }) {
  return (
    <span className="showcase-sentence-playback-state" title={playing ? '正在播放，点击停止' : fullTrack ? '缺少逐句时间，点击播放完整译文音频' : '可播放'}>
    <svg className={`showcase-sentence-playback-icon${playing ? ' is-playing' : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 2.5v11L13 8z" />}
    </svg>
    <span aria-hidden="true">{playing ? '正在播放' : fullTrack ? '播放完整译文' : '可播放'}</span>
    </span>
  )
}
