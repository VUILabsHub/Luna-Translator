// Slice PCM samples before playback rather than relying on timeupdate (which
// can fire hundreds of milliseconds late and play the next sentence).
export async function slicePlaybackWav(blob: Blob, startMs: number, endMs?: number): Promise<Blob> {
  if (!Number.isFinite(startMs) || startMs < 0 || (endMs !== undefined && (!Number.isFinite(endMs) || endMs <= startMs))) {
    throw new Error('音频片段时间范围无效')
  }
  const bytes = await blob.arrayBuffer()
  const view = new DataView(bytes)
  const text = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(bytes, offset, length))
  if (bytes.byteLength < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('回放音频不是 WAV')
  let format: Uint8Array | undefined
  let offset = 0
  let size = 0
  for (let pos = 12; pos + 8 <= bytes.byteLength;) {
    const length = view.getUint32(pos + 4, true)
    if (pos + 8 + length > bytes.byteLength) throw new Error('回放音频不完整')
    if (text(pos, 4) === 'fmt ' && length >= 16) format = new Uint8Array(bytes.slice(pos + 8, pos + 24))
    if (text(pos, 4) === 'data') { offset = pos + 8; size = length }
    pos += 8 + length + (length % 2)
  }
  if (!format || !offset) throw new Error('回放音频缺少 PCM 数据')
  const fmt = new DataView(format.buffer)
  const rate = fmt.getUint32(4, true)
  const align = fmt.getUint16(12, true)
  if (fmt.getUint16(0, true) !== 1 || fmt.getUint16(14, true) !== 16 || !rate || !align) throw new Error('不支持的回放音频格式')
  const frames = Math.floor(size / align)
  const start = Math.min(frames, Math.floor(startMs * rate / 1000))
  const end = endMs === undefined ? frames : Math.min(frames, Math.ceil(endMs * rate / 1000))
  if (end <= start) throw new Error('该片段没有可播放的音频')
  const length = (end - start) * align
  const header = new ArrayBuffer(44)
  const output = new DataView(header)
  const write = (pos: number, value: string) => [...value].forEach((char, i) => output.setUint8(pos + i, char.charCodeAt(0)))
  write(0, 'RIFF'); output.setUint32(4, 36 + length, true); write(8, 'WAVE'); write(12, 'fmt ')
  output.setUint32(16, 16, true); new Uint8Array(header, 20, 16).set(format)
  write(36, 'data'); output.setUint32(40, length, true)
  return new Blob([header, bytes.slice(offset + start * align, offset + end * align)], { type: 'audio/wav' })
}
