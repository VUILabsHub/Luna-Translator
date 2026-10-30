// 会话结束原因（completionReason）——三个宿主一份真相。
//
// 取值口径完全以后端为准：
//   - 服务端在 WS 会话循环里写入的六个值见 `backend/server/server.go`
//     （`session_time_limit` / `client_disconnected` / `input_audio_limit_exceeded`
//     / `session_context_done` / `client_stopped` / `provider_failed` /
//     `provider_stop_timeout` / `backfill_busy`）；
//   - 客户端额外产出两个：`client_checkpoint`（录音中途快照，见
//     `backend/server/consumer_history.go` 的 checkpoint 保护分支）与
//     `quota_exhausted`（duo-x6：额度耗尽自动收尾）。后者也是服务端
//     `closeWSWithError` 写出去的 WS close reason（`consumer_quota.go:302,440`），
//     以前落到「不认识 → client_disconnected」，现在两条路径收敛到同一个值。
//
// 「是否正常结束」必须与后端 `normalSessionEnd`（server.go）逐字一致，否则
// 客户端补存的历史会把服务端已经写好的 `session_time_limit` 覆盖成异常退出。

/** 后端 `normalSessionEnd(reason)` 的等价集合（server.go）。只加不改。 */
export const NORMAL_SESSION_END_REASONS = ['client_stopped', 'session_time_limit'] as const

/** 后端与客户端会写入历史的全部结束原因。 */
export const SESSION_COMPLETION_REASONS = [
  'client_stopped',
  'client_checkpoint',
  'session_time_limit',
  'client_disconnected',
  'client_error',
  'provider_failed',
  'provider_stop_timeout',
  'session_context_done',
  'input_audio_limit_exceeded',
  'backfill_busy',
  // duo-x6：额度耗尽。客户端按分钟计量拿到 429 时自己收尾（此刻 WS 还没关，
  // 会话层给不出原因），服务端在 WS 侧则用同一个串当 close reason。
  'quota_exhausted',
] as const

export type SessionCompletionReason = (typeof SESSION_COMPLETION_REASONS)[number]

/** 与 `backend/server/server.go:normalSessionEnd` 一一对应。 */
export function isNormalSessionEnd(reason: string | undefined): boolean {
  return (NORMAL_SESSION_END_REASONS as readonly string[]).includes(reason || '')
}

/**
 * 屏幕层收尾时的结束原因（duo-x6）。
 *
 * 额度耗尽这条路上**会话层给不出原因**：客户端按分钟计量拿到 429、或者收到
 * 服务端 `{"type":"error","code":"quota_exhausted"}` 那一帧时，屏幕层立刻调
 * `session.stop()`，而 `stop()` 第一句就把结束原因 latch 成 `client_stopped`
 * （`noteSessionCompletionReason` 是先到先得），随后到达的 4402 关闭帧带的
 * `quota_exhausted` 一律被丢弃。落库于是变成「用户正常结束」，还会顺手把
 * 服务端已经写好的 `quota_exhausted` 覆盖掉——`consumer_history.go` 的保护
 * 分支正是拿 `client_stopped` 放行的。
 *
 * 只在「会话层确实没拿到原因」（兜底值 `client_stopped`）时才覆写：服务端
 * 已经下发 `session_time_limit` 之类真实原因时，那个才是事实源头。
 *
 * 单人页与双人页必须走同一份（此前只有 DuoScreen 有这段覆写，LiveScreen 漏
 * 了，单麦额度耗尽仍按 client_stopped / abnormalExit=false 落库）。
 */
export function resolveStopCompletionReason<Reason extends string>(
  sessionReason: Reason,
  stopReason?: 'quota',
): Reason | 'quota_exhausted' {
  return stopReason === 'quota' && sessionReason === 'client_stopped'
    ? 'quota_exhausted'
    : sessionReason
}

/**
 * 未知字符串收敛成闭集。
 *
 * **空 vs. 未知要分开处理**：
 *   - 空/空白 = 「没人告诉我为什么结束」，按调用方给的 fallback（默认
 *     `client_stopped`）；
 *   - 非空但不认识 = 服务端确实给了一个原因，只是不在本表里 —— 这**只会**
 *     发生在异常关闭上（`closeWSWithError` 把 `ws_ticket_invalid` /
 *     `provider_not_allowlisted` 这类 code 当作 WS close reason 写出去，见
 *     `backend/server/consumer_ws.go`；`quota_exhausted` 已经进闭集，见上），
 *     所以必须收敛
 *     到**异常**侧。收敛成正常值会让客户端补存的历史把服务端刚写好的
 *     `client_disconnected` / `abnormalExit=true` 覆盖成「用户正常结束」
 *     （`consumer_history.go` 的保护分支正是拿 `client_stopped` 放行的）。
 */
export function normalizeSessionCompletionReason(
  reason: string | undefined,
  fallback: SessionCompletionReason = 'client_stopped',
): SessionCompletionReason {
  const trimmed = (reason || '').trim()
  if (trimmed === '') return fallback
  return (SESSION_COMPLETION_REASONS as readonly string[]).includes(trimmed)
    ? (trimmed as SessionCompletionReason)
    : 'client_disconnected'
}

/**
 * 服务端限时结束的结束页文案。Web `web/src/lib/sessionRecovery.ts` 现在从这里
 * re-export（曾经是两份逐字相同的实现），这里是唯一出处。
 */
export const sessionTimeLimitNotice = '本次同传已满 15 分钟，已自动结束。'

/**
 * 结束原因的短标签（只描述已知事实，断连不等于崩溃）。Web
 * `sessionRecovery.sessionExitLabel` 是这里的 re-export。
 */
export function sessionExitLabel(reason?: string): string {
  switch (reason) {
    case 'provider_failed': return '翻译服务失败'
    case 'provider_stop_timeout': return '服务结束超时'
    case 'client_disconnected': return '客户端连接中断'
    case 'client_checkpoint': return '会话恢复记录'
    case 'client_error': return '客户端会话异常'
    case 'session_context_done': return '会话超时或被中断'
    case 'input_audio_limit_exceeded': return '音频超过会话上限'
    case 'quota_exhausted': return '今日额度已用尽'
    default: return '会话未正常结束'
  }
}

/**
 * 结束页顶部的一句话说明：正常收尾不出提示，限时结束出 15 分钟文案，其余
 * 按 `sessionExitLabel` 说明「为什么结束」。移动端结束页与 Web
 * `finishedSessionData.infoNotice` 用同一套口径。
 */
export function sessionCompletionNotice(reason: string | undefined, errorMessage?: string): string {
  const message = (errorMessage || '').trim()
  if (message) {
    if (message === sessionTimeLimitNotice) return message
    // A session_closed warning is already a complete notice. History may also
    // contain an older duplicated suffix; normalize it without losing its cause.
    const cause = message
      .replace(/(?:[，,。.!！\s]*本次同传已结束[，,。.!！\s]*)+$/u, '')
      .replace(/[，,。.!！\s]+$/u, '')
    return cause ? `${cause}，本次同传已结束。` : '本次同传已结束。'
  }
  if (reason === 'session_time_limit') return sessionTimeLimitNotice
  if (!reason || isNormalSessionEnd(reason)) return ''
  return `${sessionExitLabel(reason)}，本次同传已结束。`
}

/**
 * 异常结束的会话**恢复**提示（protocol-08）。Web
 * `web/src/lib/sessionRecovery.ts` 从这里 re-export，由
 * `finishedSessionData.ts:56` 在「把一条后端记录渲染成结束页」时调用 ——
 * 也就是说它描述的是**已保存记录**的恢复情况，不是刚刚结束的那一场。
 *
 * 三段结构：结束原因短标签 + 为什么会这样 + 下面能看到什么（finished-04 同题）。
 *
 * @param abnormal 记录的 `abnormalExit`（正常收尾直接返回空串）
 * @param reason 记录的 `completionReason`
 * @param hasSource 恢复出来的行里有没有原文
 * @param hasTranslation 恢复出来的行里有没有译文
 */
export function sessionRecoveryNotice(
  abnormal: boolean | undefined,
  reason: string | undefined,
  hasSource: boolean,
  hasTranslation: boolean,
): string {
  if (!abnormal) return ''
  const explanation = reason === 'client_disconnected'
    ? '可能是页面关闭、网络中断或客户端异常退出，后台无法区分具体原因。'
    : reason === 'provider_failed'
      ? '翻译服务未能正常完成。'
      : reason === 'client_checkpoint'
        ? '会话未正常完成保存，已从暂存内容恢复。'
        : reason === 'quota_exhausted'
          ? '今日免费额度已用尽，会话到此自动结束。'
          : '会话未能正常完成。'
  const content = hasTranslation
    ? '以下为已保存的转录或译文，末尾内容可能不完整。'
    : hasSource
      ? '以下为已保存的原文转录，尚无可展示的译文。'
      : '尚未读取到已保存的转录或译文，可尝试重新读取后台记录；如有音频，可在下方回放。'
  return `${sessionExitLabel(reason)}。${explanation}${content}`
}

/**
 * 源 ASR 降级告警（`asr_error` 帧）的两个阶段。
 *
 * 后端 `backend/providers/qwenasr/sidecar.go` 的 `runResettableSource` 在每次
 * 源 ASR 连接失败时发一帧 `asr_error`，正文是
 * 「ASR 会话中断，正在自动重连（n/5）：<原始错误>」（`:916`）；重试次数用尽
 * （n == sourceReconnectAttempts）之后 `reportedSourceError` 会让循环退出、
 * `stopSource` 判定 `alreadyReported` 不再补发 —— 也就是说**客户端看到的最后
 * 一帧就是 (5/5)**，此后源 ASR 永久停摆，但 S2ST / 译文 / TTS 仍在跑。
 *
 * 还有一条不走重连的路径（`:1566`），正文是裸的错误字符串，同样表示源已停。
 */
export type AsrWarningPhase = 'reconnecting' | 'stopped'

export type AsrWarning = {
  phase: AsrWarningPhase
  /** 第几次重连（无法解析时 0）。 */
  attempt: number
  /** 总重连次数（无法解析时 0）。 */
  attempts: number
  /** 面向用户的一句话（不含后端拼进去的原始错误）。 */
  text: string
}

/** 源 ASR 重试用尽后的常驻提示：识别停了，但翻译还在继续。 */
export const ASR_SOURCE_STOPPED_NOTICE = '源 ASR 已停止，译文继续'

/**
 * 「正在自动重连（n/m）」。全角括号是后端现用的写法，半角一并认，免得后端
 * 换个 fmt 就整条提示掉档成「已停止」。
 */
const ASR_RECONNECT_PATTERN = /正在自动重连\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/

/** 面向用户的重连提示（不带原始错误，n/m 逐字来自后端）。 */
export function asrReconnectingNotice(attempt: number, attempts: number): string {
  return `ASR 会话中断，正在自动重连（${attempt}/${attempts}）`
}

/**
 * `asr_error` 正文 → 结构化告警。**只有**「重连中且次数未用尽」算可恢复，
 * 其余（用尽、解析不出、空正文）一律按「源已停止」处理 —— 宁可多提示一次
 * 「译文继续」，也不能让用户以为原文还会回来。
 */
export function parseAsrWarning(detail?: string): AsrWarning {
  const matched = ASR_RECONNECT_PATTERN.exec((detail || '').trim())
  const attempt = matched ? Number(matched[1]) : 0
  const attempts = matched ? Number(matched[2]) : 0
  if (attempts > 0 && attempt > 0 && attempt < attempts) {
    return { phase: 'reconnecting', attempt, attempts, text: asrReconnectingNotice(attempt, attempts) }
  }
  return { phase: 'stopped', attempt, attempts, text: ASR_SOURCE_STOPPED_NOTICE }
}

/**
 * 源 ASR 抖动（`asr_error` 帧）：非致命，只给一条提示条的文案。
 *
 * 以前是 `原文识别不可用：<detail>` —— 直接把后端 `：%v` 拼进来的 Go 错误
 * （`dial tcp …`）甩到用户脸上，而且重连中与已停摆看起来一模一样。
 */
export function asrWarningNotice(detail?: string): string {
  return parseAsrWarning(detail).text
}

/**
 * 这条告警还有救吗？重连中 = 有救（下一帧原文到了就该把提示条撤掉）；
 * 「源 ASR 已停止」= 没救，提示条常驻到会话结束。
 */
export function isRecoverableAsrWarning(text: string): boolean {
  return ASR_RECONNECT_PATTERN.test(text || '')
}

// ---------------------------------------------------------------------------
// 会话结束状态机（protocol-09 的可回放部分）
//
// 「结束原因 + 非致命告警」这两件事以前只活在 mobile 的 useMultilingualSession
// 里，是个 React hook —— 三个宿主没法回放同一份真相，goldens/v1 对
// `session_ending` 生命周期也就零覆盖。下面把这段**纯**状态机搬出来，
// `goldens/v1/session-lifecycle.json` 直接回放它，会话层则原样消费。
// ---------------------------------------------------------------------------

/** 会话层对外暴露的两个结束态字段。 */
export type SessionCompletionState = {
  /** 后端 completionReason 口径；会话进行中为空串。 */
  reason: SessionCompletionReason | ''
  /** 非致命告警（asr_error 的提示条、异常关闭的说明）；没有则为空串。 */
  warning: string
}

/** 状态机认识的生命周期帧（字段名与 BridgeEvent 一致，只取用得上的那几个）。 */
export type SessionCompletionEvent = {
  type: string
  reason?: string
  warning?: string
  text?: string
  segmentText?: string
}

export function emptySessionCompletionState(): SessionCompletionState {
  return { reason: '', warning: '' }
}

/**
 * 结束原因**只写一次**：先到的那个是事实源头（服务端 `session_ending` 的
 * reason 优先于随后关闭帧折算出来的那个），后到的不覆盖。
 */
export function noteSessionCompletionReason(
  state: SessionCompletionState,
  reason: string | undefined,
): SessionCompletionState {
  if (state.reason !== '') return state
  return { ...state, reason: normalizeSessionCompletionReason(reason) }
}

/**
 * 生命周期帧 → 新状态。认识四类帧，其余原样返回（同一个对象，调用方可按引用
 * 判断有没有变化）：
 *
 *  - `session_ending`：服务端宣告本场即将结束，记下原因；
 *  - `session_closed`：WS 已关闭，记下原因；异常结束且还没有告警时，把
 *    `sessionCompletionNotice` 当告警挂上去（用户得知道为什么断的）；
 *  - `warning`：非致命告警（今天只有 `asr_error` 折过来的那条）；
 *  - `source_*` 且带非空文本：源 ASR 恢复了，撤掉**可恢复**的重连提示；
 *    「源 ASR 已停止」不可恢复，不撤。
 */
export function reduceSessionCompletionEvent(
  state: SessionCompletionState,
  event: SessionCompletionEvent,
): SessionCompletionState {
  if (event.type === 'session_ending') return noteSessionCompletionReason(state, event.reason)
  if (event.type === 'session_closed') {
    const next = noteSessionCompletionReason(state, event.reason)
    if (isNormalSessionEnd(next.reason)) return next
    const notice = sessionCompletionNotice(next.reason)
    if (notice === '' || next.warning !== '') return next
    return { ...next, warning: notice }
  }
  if (event.type === 'warning') {
    const warning = (event.warning || '').trim()
    return warning === '' ? state : { ...state, warning: event.warning as string }
  }
  if (event.type.startsWith('source')) {
    const text = (event.text || event.segmentText || '').trim()
    if (text === '' || !isRecoverableAsrWarning(state.warning)) return state
    return { ...state, warning: '' }
  }
  return state
}
