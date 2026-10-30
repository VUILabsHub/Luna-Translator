// `end` is an exclusive UTF-16 offset, as used by String.slice.
export function numericBoundaryUnsafe(text: string, end: number, final = false) {
  const left = text.slice(0, end).trimEnd()
  const right = text.slice(end)
  const digit = (char: string) => /^[0-9０-９]$/u.test(char)
  const separator = (char: string) => /^[.,，．:：/\\\-−–—]$/u.test(char)
  const last = left.slice(-1)
  const next = right.slice(0, 1)
  if (digit(last) && digit(next) && !/\s$/u.test(text.slice(0, end))) return true
  const leadingDecimal = /[.．]/u.test(last)
    && (left.length === 1 || /[\s+\-−$€£¥(]/u.test(left.slice(-2, -1)))
  if (separator(last) && (digit(left.slice(-2, -1)) || leadingDecimal)) {
    return digit(next) || (!right.trim() && !final)
  }
  return digit(last) && separator(next)
    && (digit(right.slice(1, 2)) || (!right.slice(1).trim() && !final))
}
