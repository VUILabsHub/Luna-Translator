// 反馈请求的幂等键（feedback-03），两端共用。
//
// 旧实现（移动端）用「sessionId + unitId + 时间戳 + 随机数」，于是一次失败重试
// 就会在后台留下两条内容完全相同的工单。改成**内容散列**：同一条反馈重发多少
// 次都是同一个 key，后端按 clientKey 去重即可。
//
// `hash36` 原本在 Web `web/src/components/SentenceFeedback.tsx` 里还有一份逐字
// 相同的实现，现在那边直接 import 这里，两端共用一份；**前缀必须不同**
// （Web 是 `web-v2-`，移动端用 Platform.OS），否则两端对同一句的同一评分会撞成
// 同一个 key。

/** djb2/xor 散列的 36 进制表示（与 Web 逐字相同，不要「顺手优化」）。 */
export function hash36(input: string): string {
  let h = 5381
  for (let index = 0; index < input.length; index += 1) {
    h = ((h * 33) ^ input.charCodeAt(index)) >>> 0
  }
  return h.toString(36)
}

export type FeedbackKeyPayload = {
  sessionId: string
  unitId: string
  rating: string
  category?: string
  comment?: string
}

/** 参与散列的内容（顺序固定，与 Web `makeWebFeedbackClientKey` 一致）。 */
export function feedbackKeySeed(payload: FeedbackKeyPayload): string {
  return JSON.stringify([
    payload.sessionId,
    payload.unitId,
    payload.rating,
    payload.category || 'other',
    payload.comment?.trim() || '',
  ])
}

/**
 * 幂等键：`<prefix>-<hash>-<hash2>`，远小于后端 64 字符上限。
 * 两个散列拼在一起是为了把碰撞概率压到可忽略（Web 同式）。
 */
export function feedbackClientKey(prefix: string, payload: FeedbackKeyPayload): string {
  const seed = feedbackKeySeed(payload)
  return `${prefix}-${hash36(seed)}-${hash36(`feedback:${seed}`)}`
}

// ---------------------------------------------------------------------------
// 上行 unitId 的规范化（feedback-05）
// ---------------------------------------------------------------------------

/**
 * 后端 `validFeedbackID` 的硬上限：`backend/server/consumer_feedback.go` 里
 * id 必须塞得进 MySQL 的 VARCHAR(128)，**按字节算**，超一个字节就是 400。
 */
export const FEEDBACK_ID_MAX_BYTES = 128

/**
 * UTF-8 字节数。**不用 TextEncoder**：Hermes 上它不一定存在，而这个函数在
 * 移动端是上行前的必经之路，缺了会直接崩在「提交反馈」那一下。
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const code = character.codePointAt(0) as number
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 按 UTF-8 字节数截断，**不切开码点**（中文不会截出半个字）。 */
export function utf8Prefix(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8ByteLength(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

/**
 * Cc 控制字符（U+0000–U+001F、U+007F–U+009F）。
 *
 * 与 Go `unicode.IsControl` 逐字等价（它只对 Latin-1 区间的 pC 返回 true），
 * 也与 Web 原来写的 `\p{Cc}` 等价 —— 改成显式区间是因为 Hermes 对 Unicode
 * 属性转义的支持没有保证，而这段代码两端共用。
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const CONTROL_CHARS_RUN = /[\u0000-\u001F\u007F-\u009F]+/g

/**
 * 界面内部的行 id → 后端反馈接口认的 unitId（feedback-05）。
 *
 * 界面会把两行并成一行（移动端 `rows.ts` 的 `a:merged:b`），id 因此线性增长，
 * 十几次连续合并就能越过 128 字节；多语分段的合成 id 还可能夹着分隔用的控制
 * 字符。两种情况后端都会 400 —— 而用户看到的只是「评分失败、已撤销标记」，
 * 那一票就这么没了。这里把超长 / 带控制字符的 id 折成一个**定长且稳定**的
 * 替身：清洗过的前缀 + 两个散列，同一个 id 永远折成同一个替身。
 *
 * 注意：这只保证「同一端的同一个 id 永远映射到同一个 unitId」，**不保证**
 * Web 与移动端对同一句算出同一个 id —— 两端的行 id 形状本来就不同。
 */
export function feedbackWireUnitId(unitId: string): string {
  if (
    unitId.trim()
    && utf8ByteLength(unitId) <= FEEDBACK_ID_MAX_BYTES
    && !CONTROL_CHARS.test(unitId)
  ) {
    return unitId
  }
  const suffix = `-${hash36(unitId)}${hash36(`feedback:${unitId}`)}`
  const sanitized = unitId.replace(CONTROL_CHARS_RUN, '-').trim() || 'unit'
  const prefix = utf8Prefix(sanitized, FEEDBACK_ID_MAX_BYTES - utf8ByteLength(suffix))
  return `${prefix}${suffix}`
}
