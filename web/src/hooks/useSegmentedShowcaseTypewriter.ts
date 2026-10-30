import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MultilingualShowcaseRow } from '../lib/multilingualShowcase'
import { translationUnitSeparator } from '@simultrans/ui-shared/src/lib/transcript'

const typewriterStepMs = 18

type Cursor = {
  language: string
  target: string
  visibleCount: number
}

function characters(value: string) {
  return [...value]
}

export function primaryShowcaseText(
  rows: MultilingualShowcaseRow[],
  primaryLanguage: string,
) {
  return rows.reduce((value, row) => {
    const text = row.translations[primaryLanguage] || ''
    return text ? value + translationUnitSeparator(value, text) + text : value
  }, '')
}

export function projectPrimaryShowcaseText<T extends MultilingualShowcaseRow>(
  rows: T[],
  primaryLanguage: string,
  visibleCount: number,
): T[] {
  let joined = ''
  let offset = 0
  const projected = rows.map((row) => {
    const text = row.translations[primaryLanguage] || ''
    const separator = text ? translationUnitSeparator(joined, text) : ''
    const textCharacters = characters(text)
    offset += characters(separator).length
    const visibleLength = Math.max(0, Math.min(textCharacters.length, visibleCount - offset))
    offset += textCharacters.length
    if (text) joined += separator + text
    return {
      row: visibleLength === textCharacters.length ? row : {
        ...row,
        translations: {
          ...row.translations,
          [primaryLanguage]: textCharacters.slice(0, visibleLength).join(''),
        },
      },
      visibleLength,
    }
  })
  return projected.map(({ row }) => row)
}

export function reconcileSegmentedShowcaseCursor(
  previous: Cursor,
  language: string,
  target: string,
  enabled: boolean,
): Cursor {
  const targetLength = characters(target).length
  if (!enabled || previous.language !== language || (!previous.target && target)) {
    return { language, target, visibleCount: targetLength }
  }
  const visible = characters(previous.target).slice(0, previous.visibleCount).join('')
  return {
    language,
    target,
    visibleCount: target.startsWith(visible)
      ? Math.min(previous.visibleCount, targetLength)
      : targetLength,
  }
}

export function useSegmentedShowcaseTypewriter<T extends MultilingualShowcaseRow>(
  rows: T[],
  primaryLanguage: string,
  enabled: boolean,
  onProgress: () => void,
) {
  const target = useMemo(
    () => primaryShowcaseText(rows, primaryLanguage),
    [primaryLanguage, rows],
  )
  const [cursor, setCursor] = useState<Cursor>(() => ({
    language: primaryLanguage,
    target,
    visibleCount: characters(target).length,
  }))
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  const reconciled = reconcileSegmentedShowcaseCursor(cursor, primaryLanguage, target, enabled)

  useLayoutEffect(() => {
    setCursor((current) => {
      const next = reconcileSegmentedShowcaseCursor(current, primaryLanguage, target, enabled)
      return current.language === next.language
        && current.target === next.target
        && current.visibleCount === next.visibleCount
        ? current
        : next
    })
  }, [enabled, primaryLanguage, target])

  useEffect(() => {
    if (!enabled || cursor.language !== primaryLanguage || cursor.target !== target) return undefined
    const targetLength = characters(target).length
    if (cursor.visibleCount >= targetLength) return undefined
    const timer = window.setTimeout(() => {
      setCursor((current) => (
        current.language === primaryLanguage && current.target === target
          ? { ...current, visibleCount: Math.min(targetLength, current.visibleCount + 1) }
          : current
      ))
      onProgressRef.current()
    }, typewriterStepMs)
    return () => window.clearTimeout(timer)
  }, [cursor, enabled, primaryLanguage, target])

  return useMemo(
    () => projectPrimaryShowcaseText(rows, primaryLanguage, reconciled.visibleCount),
    [primaryLanguage, reconciled.visibleCount, rows],
  )
}
