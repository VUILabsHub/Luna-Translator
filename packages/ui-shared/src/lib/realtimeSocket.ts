export function waitForOpen(socket: WebSocket, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException('翻译服务连接已取消。', 'AbortError'))
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error('翻译服务连接已关闭。'))
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: number | null = null
    const cleanup = () => {
      if (timeout !== null) window.clearTimeout(timeout)
      if (socket.onopen === handleOpen) socket.onopen = null
      if (socket.onerror === handleError) socket.onerror = null
      signal?.removeEventListener('abort', handleAbort)
    }
    const resolveOnce = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const handleOpen = () => resolveOnce()
    const handleError = () => rejectOnce(new Error('无法连接翻译服务。'))
    const handleAbort = () => {
      rejectOnce(new DOMException('翻译服务连接已取消。', 'AbortError'))
      socket.close()
    }
    socket.onopen = handleOpen
    socket.onerror = handleError
    signal?.addEventListener('abort', handleAbort, { once: true })
    timeout = window.setTimeout(() => {
      rejectOnce(new Error(`翻译服务连接超过 ${Math.round(timeoutMs / 1000)} 秒。`))
      socket.close()
    }, timeoutMs)
    // Guard the state transition between the initial readyState check and
    // listener installation without leaving an orphaned timeout behind.
    if (socket.readyState === WebSocket.OPEN) resolveOnce()
    else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      rejectOnce(new Error('翻译服务连接已关闭。'))
    }
  })
}

export function decodeBase64(value: string) {
  const binary = window.atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
