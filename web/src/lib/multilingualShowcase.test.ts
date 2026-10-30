import { describe, expect, it } from 'vitest'
import type { MultilingualOutput } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import {
  buildDuoShowcaseBubbles,
  buildMultilingualShowcaseRows,
  buildPrimaryDrivenMultilingualRows,
  combineDuoStatus,
  featuredShowcaseRowId,
  selectDuoLanguageLayouts,
  type DuoShowcaseBubble,
  showcaseAudioEndMs,
  validateDuoMicrophones,
  validateDuoOutputDevices,
  validateDuoStereoMicrophone,
} from './multilingualShowcase'
import { emptyVadTranscriptPairState, reduceVadTranscriptPairEvent } from '@simultrans/ui-shared/src/lib/vadTranscriptPairs'

describe('duo speaker order', () => {
  const bubble = (id: string, side: 'a' | 'b', startMs: number, language = 'zh'): DuoShowcaseBubble => ({
    id, side, startMs, layoutLanguage: language, sourceLanguage: 'auto', targetLanguages: [language],
    source: id, committed: true, translations: { [language]: id }, outputAudioStarts: {}, outputAudioEnds: {},
  })

  it('keeps c5bd3a8e speaker B order while a merged live row temporarily inherits its parent time', () => {
    for (const startMs of [60864, 48480, 55648]) {
      const rows = [
        bubble('甲第一句', 'a', 49000),
        bubble('甲第二句', 'a', 62000),
        bubble('再大一点。', 'b', 53889.684),
        bubble('现在声音是一样的，就是', 'b', startMs),
        bubble('Another language', 'b', 1000, 'en'),
      ]
      const selected = selectDuoLanguageLayouts(rows, 'zh', 'zh')
      expect(selected.filter(row => row.side === 'b').map(row => row.id)).toEqual(['再大一点。', '现在声音是一样的，就是'])
      expect(selected.filter(row => row.side === 'a').map(row => row.id)).toEqual(['甲第一句', '甲第二句'])
      expect(rows[0].id).toBe('甲第一句')
    }
  })

  it('interleaves finished speakers by time without changing either speaker order', () => {
    const rows = [bubble('a1', 'a', 100), bubble('a2', 'a', 300), bubble('b1', 'b', 100), bubble('b2', 'b', 200)]
    expect(selectDuoLanguageLayouts(rows, 'zh', 'zh').map(row => row.id)).toEqual(['a1', 'b1', 'b2', 'a2'])
    expect(selectDuoLanguageLayouts([], 'zh', 'zh')).toEqual([])
  })

  it('also preserves speaker A order and an independent language selection', () => {
    const rows = [bubble('a1', 'a', 300, 'en'), bubble('a2', 'a', 100, 'en'), bubble('b1', 'b', 200)]
    expect(selectDuoLanguageLayouts(rows, 'en', 'zh').map(row => row.id)).toEqual(['b1', 'a1', 'a2'])
    expect(selectDuoLanguageLayouts(rows, 'en', 'ja').map(row => row.id)).toEqual(['a1', 'a2'])
  })
})

const output = (targetLanguage: string, speechEpoch: number, source: string, translation: string): MultilingualOutput => {
  let state = emptyVadTranscriptPairState()
  state = reduceVadTranscriptPairEvent(state, { type: 'source_vad_state', state: 'speech_start', speechEpoch, startMs: speechEpoch * 1000 })
  state = reduceVadTranscriptPairEvent(state, { type: 'source_done', speechEpoch, epochText: source })
  state = reduceVadTranscriptPairEvent(state, { type: 'translation_done', speechEpoch, epochText: translation })
  return {
    targetLanguage,
    translation,
    modelOutputTranslation: translation,
    segments: [],
    vadTranscriptPairs: state.pairs,
    status: 'recording',
    error: '',
    ttsWarning: '',
    audioBytes: 0,
    settledTranslationSegments: {},
    firstTextLatency: null,
    firstStableTextLatency: null,
    firstAudioByteLatency: null,
    firstAudioPlaybackLatency: null,
    engineModelFeedToFirstOutputMs: null,
    engineModelFeedToStableTextMs: null,
    engineModelFeedToTTSReadyMs: null,
    recordingToModelSubmitMs: null,
    ttsReadyToFirstPlaybackMs: null,
    playingTranslationSegmentId: null,
  }
}

describe('multilingual showcase helpers', () => {
  it('joins each target language by the shared VAD epoch', () => {
    const rows = buildMultilingualShowcaseRows('', [], ['en', 'ja'], {
      en: output('en', 1, '欢迎使用多语同传。', 'Welcome to multilingual interpretation.'),
      ja: output('ja', 1, '欢迎使用多语同传。', '多言語通訳へようこそ。'),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: '欢迎使用多语同传。',
      translations: {
        en: 'Welcome to multilingual interpretation.',
        ja: '多言語通訳へようこそ。',
      },
    })
  })

  it('leaves a new VAD row empty until that epoch has translation output', () => {
    const english = output('en', 1, '第一段。', 'First sentence. Previous trailing sentence.')
    english.vadTranscriptPairs.push(output('en', 2, '第二段。', '').vadTranscriptPairs[0])
    english.segments = [
      { id: 'en-1', text: 'First sentence.', startMs: 0, endMs: 500 },
      { id: 'en-2', text: 'Previous trailing sentence.', startMs: 500, endMs: 1_000 },
    ]

    const japanese = output('ja', 1, '第一段。', '最初の翻訳。')
    japanese.vadTranscriptPairs.push(output('ja', 3, '別の段落。', '前の翻訳。').vadTranscriptPairs[0])

    const rows = buildMultilingualShowcaseRows('', [], ['en', 'ja'], { en: english, ja: japanese })

    expect(rows[1]).toMatchObject({
      source: '第二段。',
      translations: { en: '', ja: '' },
    })
  })

  it('always features the latest row, including while it is streaming', () => {
    const stable = buildMultilingualShowcaseRows('', [], ['en'], {
      en: output('en', 1, '第一段。', 'The first segment.'),
    })[0]
    const rows = [
      { ...stable, id: 'stable', committed: true },
      { ...stable, id: 'live', source: '第二段', committed: false },
    ]

    expect(featuredShowcaseRowId(rows)).toBe('live')
  })

  it('uses the selected language layout and shows secondary text only on its latest row', () => {
    const layouts = {
      en: [
        { id: 'vad-1:first', source: '第一句。', translation: 'First sentence.', startMs: 100, playing: false },
        { id: 'vad-2:second', source: '第二句。', translation: 'Second sentence.', startMs: 300, playing: false },
      ],
      ja: [
        { id: 'vad-1:first', source: '第一句。', translation: '第一文です。', startMs: 100, playing: false },
        { id: 'vad-2:second', source: '第二句。', translation: '第二文です。', startMs: 300, playing: false },
      ],
    }

    const english = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'en', layouts, [], {})
    expect(english.map((row) => row.translations.en)).toEqual(['First sentence.', 'Second sentence.'])
    expect(english.map((row) => row.translations.ja)).toEqual(['', '第二文です。'])

    const japanese = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'ja', layouts, [], {})
    expect(japanese.map((row) => row.translations.ja)).toEqual(['第一文です。', '第二文です。'])
    expect(japanese.map((row) => row.translations.en)).toEqual(['', 'Second sentence.'])
  })

  it('keeps playback commitment independent of the underlying VAD commitment', () => {
    const layouts = { en: [
      { id: 'one', source: '历史。', translation: 'History.', startMs: 0, playing: false, playbackCommitted: true },
      { id: 'two', source: '待播放。', translation: 'Pending.', startMs: 100, playing: true, playbackCommitted: false },
    ] }
    const fallback = layouts.en.map(row => ({
      id: row.id, source: row.source, startMs: row.startMs, committed: true,
      translations: { en: row.translation }, outputAudioStarts: {}, outputAudioEnds: {},
    }))
    const rows = buildPrimaryDrivenMultilingualRows(['en'], 'en', layouts, fallback, {})
    expect(rows.map(row => row.committed)).toEqual([true, false])
    expect(featuredShowcaseRowId(rows)).toBe('en:two')
    // A revising live tail may disappear; history must not become featured again.
    expect(featuredShowcaseRowId(rows.slice(0, 1))).toBe('')
  })

  it('does not move a stale secondary translation into a new empty atomic row', () => {
    const layouts = {
      en: [
        { id: 'vad-1:frozen', source: '第一段。', translation: 'First.', startMs: 100, playing: false },
        { id: 'vad-2:semantic-live', source: '第二段。', translation: '', startMs: 300, playing: false, atomicLiveRow: true },
      ],
      ja: [
        { id: 'vad-1:frozen', source: '第一段。', translation: '最初の翻訳。', startMs: 100, playing: false },
      ],
    }
    const fallbackRows = [
      { id: 'vad-1', source: '第一段。', startMs: 100, committed: true, translations: { en: 'First.', ja: '最初の翻訳。' }, outputAudioStarts: {}, outputAudioEnds: {} },
      { id: 'vad-2', source: '第二段。', startMs: 300, committed: true, translations: { en: '', ja: '' }, outputAudioStarts: {}, outputAudioEnds: {} },
    ]

    const rows = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'en', layouts, fallbackRows, {})

    expect(rows.at(-1)?.translations).toEqual({ en: '', ja: '' })
    expect(rows.at(-1)?.atomicLiveRow).toBe(true)
    expect(rows.at(-1)?.committed).toBe(false)
  })

  it('keeps only the newest end of a long secondary translation visible', () => {
    const japaneseTranslation = 'これは一行には長すぎる翻訳で、先頭ではなく現在生成されている最後の部分を表示します。'
    const rows = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'en', {
      en: [{ id: 'vad-1:first', source: '原文。', translation: 'Source translation.', startMs: 100, playing: false }],
      ja: [{
        id: 'vad-1:first',
        source: '原文。',
        translation: japaneseTranslation,
        translationPlaybackFragments: [
          { text: 'これは一行には長すぎる翻訳で、先頭ではなく現在生成されている', segmentId: 'tts-ja-1', playing: false },
          { text: '最後の部分を表示します。', segmentId: 'tts-ja-2', playing: true },
        ],
        startMs: 100,
        playing: false,
      }],
    }, [], {})

    expect(rows[0].translations.ja.startsWith('…')).toBe(true)
    expect(rows[0].translations.ja.endsWith('最後の部分を表示します。')).toBe(true)
    expect(rows[0].translationPlaybackFragments?.ja.map(({ text }) => text).join('')).toBe(rows[0].translations.ja)
    expect(rows[0].translationPlaybackFragments?.ja.filter(({ playing }) => playing).map(({ text }) => text)).toEqual([
      '最後の部分を表示します。',
    ])
  })

  it('carries the primary row playback status and gives the leading ellipsis the first visible fragment status', () => {
    const japaneseTranslation = 'これは一行には長すぎる翻訳で、先頭ではなく現在生成されている最後の部分を表示します。'
    const rows = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'en', {
      en: [
        { id: 'vad-1:first', source: '原文。', translation: 'Played sentence.', startMs: 100, playing: false, playbackStatus: 'played' },
        { id: 'vad-2:first', source: '第二段。', translation: 'Unread sentence.', startMs: 200, playing: false, playbackStatus: 'pending' },
      ],
      ja: [{
        id: 'vad-2:first',
        source: '第二段。',
        translation: japaneseTranslation,
        translationPlaybackFragments: [
          { text: 'これは一行には長すぎる翻訳で、先頭ではなく現在生成されている', segmentId: 'tts-ja-1', playing: false, status: 'played' },
          { text: '最後の部分を表示します。', segmentId: 'tts-ja-2', playing: false, status: 'skipped' },
        ],
        startMs: 200,
        playing: false,
      }],
    }, [], {})

    expect(rows.map((row) => row.playbackStatus)).toEqual(['played', 'pending'])
    expect(rows[1].translationPlaybackFragments?.ja[0]).toEqual({ text: '…', playing: false, status: 'played' })
  })

  it('uses the primary semantic layout without merging its rows', () => {
    const fallbackRows = [{
      id: 'vad-1',
      source: '无数人只是前仆后继，成立了联合国。',
      startMs: 100,
      committed: true,
      translations: { en: '' },
      outputAudioStarts: {},
      outputAudioEnds: {},
    }]
    const layouts = {
      en: [
        { id: 'vad-1:matched', source: fallbackRows[0].source, translation: 'of the United Nations.', startMs: 100, playing: false },
        { id: 'vad-1:target-only', source: '', translation: "Some people are just shallow and ignorant. They've formed a group.", startMs: 500, playing: false },
      ],
    }

    const rows = buildPrimaryDrivenMultilingualRows(['en'], 'en', layouts, fallbackRows, {})

    expect(rows).toHaveLength(2)
    expect(rows[0].source).toBe(fallbackRows[0].source)
    expect(rows[0].translations.en).toBe('of the United Nations.')
    expect(rows[1]).toMatchObject({
      source: '',
      translations: { en: "Some people are just shallow and ignorant. They've formed a group." },
    })
  })

  it('preserves archived audio offsets without assigning one VAD audio range to every semantic child', () => {
    const fallbackRows = [{
      id: 'vad-1',
      source: '第一句。第二句。',
      startMs: 100,
      committed: true,
      translations: { en: 'First sentence. Second sentence.', ja: '第一文です。第二文です。' },
      outputAudioStarts: { en: 500, ja: 700 },
      outputAudioEnds: { en: 1_500, ja: 1_700 },
    }]
    const rows = buildPrimaryDrivenMultilingualRows(['en', 'ja'], 'en', {
      en: [
        { id: 'vad-1:first', source: '第一句。', translation: 'First sentence.', startMs: 100, playing: false },
        { id: 'vad-1:second', source: '第二句。', translation: 'Second sentence.', startMs: 300, playing: false },
      ],
      ja: [{ id: 'vad-1:first', source: '第一句。第二句。', translation: '第一文です。第二文です。', startMs: 100, playing: false }],
    }, fallbackRows, {})

    expect(rows[0].outputAudioStarts).toEqual({})
    expect(rows[0].outputAudioEnds).toEqual({})
    expect(rows[1].outputAudioStarts).toEqual({ ja: 700 })
    expect(rows[1].outputAudioEnds).toEqual({ ja: 1_700 })
  })

  it('keeps archived output-audio offsets on their corresponding language row', () => {
    const english = output('en', 1, '欢迎使用多语同传。', 'Welcome to multilingual interpretation.')
    english.segments = [{
      id: 'translation-en-1',
      text: 'Welcome to multilingual interpretation.',
      startMs: 100,
      endMs: 900,
      outputAudioStartMs: 1_240,
    }]

    const rows = buildMultilingualShowcaseRows('', [], ['en'], { en: english })

    expect(rows[0].outputAudioStarts.en).toBe(1_240)
  })

  it('maps semantic rows to actual TTS ids, including the last chunk end', () => {
    const en = output('en', 1, '第一句。第二句。', 'First. Second.')
    en.segments = [
      { id: 'tts-a', text: 'First.', startMs: 0, endMs: 500, outputAudioStartMs: 100, outputAudioEndMs: 700 },
      { id: 'tts-b', text: 'Second.', startMs: 500, endMs: 900, outputAudioStartMs: 700, outputAudioEndMs: 1300 },
    ]
    const rows = buildPrimaryDrivenMultilingualRows(['en'], 'en', { en: [
      { id: 'vad-1:first', source: '第一句', translation: 'First.', startMs: 0, playing: false, translationPlaybackFragments: [{ text: 'First.', segmentId: 'tts-a', playing: false }] },
      { id: 'vad-1:second', source: '第二句', translation: 'Second.', startMs: 500, playing: false, translationPlaybackFragments: [{ text: 'Second.', segmentId: 'tts-b', playing: false }] },
    ] }, [], { en })
    expect(rows.map(row => [row.outputAudioStarts.en, row.outputAudioEnds.en])).toEqual([[100, 700], [700, 1300]])
    // Text reconciliation may merge two TTS ids into one sentence. The PCM
    // ranges must remain independent rather than replaying that entire parent.
    en.segments = [{ id: 'merged', memberIds: ['tts-a', 'tts-b'], text: 'First. Second.', startMs: 0, endMs: 900, outputAudioStartMs: 100, outputAudioEndMs: 1300 }]
    en.audioRanges = { 'tts-a': { startMs: 100, endMs: 700 }, 'tts-b': { startMs: 700, endMs: 1300 } }
    const exact = buildPrimaryDrivenMultilingualRows(['en'], 'en', { en: [
      { id: 'second', source: '第二句', translation: 'Second.', startMs: 500, playing: false, translationPlaybackFragments: [{ text: 'Second.', segmentId: 'en\u001ftts-b', playing: false }] },
    ] }, [], { en })
    expect(exact[0].outputAudioStarts.en).toBe(700)
    expect(exact[0].outputAudioEnds.en).toBe(1300)
  })

  it('stops a row playback at the next available row on the same audio track', () => {
    const rows = [
      { id: 'one', source: '第一句', startMs: 1_000, committed: true, translations: { en: 'One.' }, outputAudioStarts: { en: 400 }, outputAudioEnds: {} },
      { id: 'two', source: '第二句', startMs: 2_500, committed: true, translations: { en: 'Two.' }, outputAudioStarts: { en: 1_800 }, outputAudioEnds: {} },
    ]

    expect(showcaseAudioEndMs(rows, 0)).toBe(2_500)
    expect(showcaseAudioEndMs(rows, 0, 'en')).toBe(1_800)
    expect(showcaseAudioEndMs(rows, 1, 'en')).toBeUndefined()
  })

  it('plays every TTS segment represented by one aggregated display row', () => {
    const first = output('en', 1, '今天天气怎么样？你打算做什么？', "Hello, hello! How's the weather today? What are you planning to do?")
    first.vadTranscriptPairs[0] = {
      ...first.vadTranscriptPairs[0],
      translationSegmentIds: ['segment-en-1', 'segment-en-2'],
    }
    const secondPair = output('en', 2, '我们出去走走。', "Let's go for a walk.").vadTranscriptPairs[0]
    secondPair.translationSegmentIds = ['segment-en-3']
    first.vadTranscriptPairs.push(secondPair)
    first.segments = [
      { id: 'segment-en-1', text: 'Hello, hello!', startMs: 0, endMs: 300, outputAudioStartMs: 0 },
      { id: 'segment-en-2', text: "How's the weather today? What are you planning to do?", startMs: 300, endMs: 1_400, outputAudioStartMs: 600 },
      { id: 'segment-en-3', text: "Let's go for a walk.", startMs: 1_400, endMs: 2_000, outputAudioStartMs: 2_200 },
    ]

    const rows = buildMultilingualShowcaseRows('', [], ['en'], { en: first })

    expect(rows[0].outputAudioStarts.en).toBe(0)
    expect(rows[0].outputAudioEnds.en).toBe(2_200)
    expect(showcaseAudioEndMs(rows, 0, 'en')).toBe(2_200)
    expect(rows[1].outputAudioStarts.en).toBe(2_200)

    first.vadTranscriptPairs.forEach((pair) => { pair.translationSegmentIds = [] })
    const textFallbackRows = buildMultilingualShowcaseRows('', [], ['en'], { en: first })
    expect(textFallbackRows[0].outputAudioEnds.en).toBe(2_200)
  })

  it('requires two explicit, distinct microphones', () => {
    expect(validateDuoMicrophones('default', 'mic-b')).toContain('明确')
    expect(validateDuoMicrophones('mic-a', 'mic-a')).toContain('同一支')
    expect(validateDuoMicrophones('mic-a', 'mic-b')).toBe('')
  })

  it('accepts one explicit stereo receiver for both speakers', () => {
    expect(validateDuoStereoMicrophone('default')).toContain('双声道接收器')
    expect(validateDuoStereoMicrophone('dji-mic-3')).toBe('')
  })

  it('requires browser support and two explicit, distinct output devices', () => {
    expect(validateDuoOutputDevices('speaker-a', 'speaker-b', false)).toContain('不支持')
    expect(validateDuoOutputDevices('default', 'speaker-b', true)).toContain('明确')
    expect(validateDuoOutputDevices('speaker-a', 'speaker-a', true)).toContain('同一个')
    expect(validateDuoOutputDevices('speaker-a', 'speaker-b', true)).toBe('')
  })

  it('builds every configured language into one speaker bubble', () => {
    const bubbles = buildDuoShowcaseBubbles('a', 'auto', ['en', 'ja'], '', [], {
      en: output('en', 2, '欢迎来到展台。', 'Welcome to the booth.'),
      ja: output('ja', 2, '欢迎来到展台。', 'ブースへようこそ。'),
    })

    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]).toMatchObject({
      side: 'a',
      sourceLanguage: 'auto',
      targetLanguages: ['en', 'ja'],
      translations: { en: 'Welcome to the booth.', ja: 'ブースへようこそ。' },
    })
  })

  it('keeps an active recorder visible when its peer errors', () => {
    expect(combineDuoStatus('recording', 'error')).toBe('recording')
    expect(combineDuoStatus('finished', 'finished')).toBe('finished')
  })
})
