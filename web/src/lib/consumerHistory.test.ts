import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionSettings } from './sessionSettings'
import {
  buildConsumerHistoryInput,
  checkpointConsumerHistory,
  clearConsumerHistoryCheckpoint,
  consumerHistoryAudioRange,
  consumerHistoryCheckpointOwner,
  createConsumerShareLink,
  activeConsumerHistoryShare,
  revokeConsumerShareLink,
  deleteConsumerHistory,
  listConsumerHistory,
  loadConsumerHistoryAudio,
  loadConsumerHistory,
  lookupConsumerHistoryId,
  retryConsumerHistoryCheckpoints,
  saveConsumerHistory,
  type ConsumerFetcher,
} from './consumerHistory'

const response = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('consumer history snapshots', () => {
  it('accepts only unexpired owner links with the expected public path', () => {
    const share = { token: 'existing', path: '/s/existing', expiresAt: '2030-01-01T00:00:00Z' }
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(activeConsumerHistoryShare(share, now)).toEqual(share)
    expect(activeConsumerHistoryShare({ ...share, expiresAt: '2020-01-01T00:00:00Z' }, now)).toBeUndefined()
    expect(activeConsumerHistoryShare({ ...share, path: 'https://other.invalid/s/existing' }, now)).toBeUndefined()
    expect(activeConsumerHistoryShare({ ...share, expiresAt: 'invalid' }, now)).toBeUndefined()
    expect(activeConsumerHistoryShare(null, now)).toBeUndefined()
  })

  it('revokes all sibling links for a record and does not hide server errors', async () => {
    const fetcher = vi.fn<ConsumerFetcher>().mockResolvedValue(response(200, { status: 'revoked' }))
    await revokeConsumerShareLink('token/with slash', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/consumer/shares/token%2Fwith%20slash?scope=history', { method: 'DELETE' })
    fetcher.mockResolvedValue(response(500, { error: 'share_revoke_failed' }))
    await expect(revokeConsumerShareLink('existing', fetcher)).rejects.toThrow()
  })

  it('serializes every language and speaker into JSON-backed history units', () => {
    const input = buildConsumerHistoryInput({
      sessionId: 'left:right',
      provider: 'flash',
      sourceLanguage: 'auto',
      targetLanguages: ['en', 'ja', 'zh'],
      durationMs: 12_345,
      devices: {
        inputs: [{ side: 'shared', label: 'DJI MIC 3' }],
        outputs: [{ side: 'a', label: 'USB Headphones' }, { side: 'b', label: 'Display Audio' }],
      },
      rows: [
        {
          id: 'a-1', side: 'a', primaryLanguage: 'en', source: '你好。', startMs: 100, translations: { en: 'Hello.', ja: 'こんにちは。' },
          outputAudioStarts: { en: 12.4, ja: 20.6 }, outputAudioEnds: { en: 612.7, ja: 701.2 },
        },
        { id: 'b-1', side: 'b', primaryLanguage: 'zh', source: 'Welcome.', startMs: 900, translations: { zh: '欢迎。', ja: 'ようこそ。' } },
      ],
    })

    expect(input).toMatchObject({
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      sourceText: '你好。\nWelcome.',
      translationText: 'Hello.\n欢迎。',
      devices: {
        inputs: [{ side: 'shared', label: 'DJI MIC 3' }],
        outputs: [{ side: 'a', label: 'USB Headphones' }, { side: 'b', label: 'Display Audio' }],
      },
    })
    expect(input.units).toEqual([
      {
        id: 'a-1', text: 'Hello.', source: '你好。', translations: { en: 'Hello.', ja: 'こんにちは。' }, side: 'a', startMs: 100,
        outputAudioStarts: { en: 12, ja: 21 }, outputAudioEnds: { en: 613, ja: 701 },
      },
      { id: 'b-1', text: '欢迎。', source: 'Welcome.', translations: { zh: '欢迎。', ja: 'ようこそ。' }, side: 'b', startMs: 900 },
    ])
  })

  it('carries the session settings snapshot and trace id into the upload payload', () => {
    const input = buildConsumerHistoryInput({
      sessionId: 'session-settings',
      provider: 'vuilabs-qwen3simul-qwen17b',
      sourceLanguage: 'auto',
      targetLanguages: ['en'],
      durationMs: 1_000,
      rows: [{ id: 'row-1', primaryLanguage: 'en', source: '你好。', startMs: 0, translations: { en: 'Hello.' } }],
      settings: buildSessionSettings({
        mode: 'solo',
        sourceLanguage: 'auto',
        targetLanguages: ['en'],
        translationModel: 'flash-v2',
        voiceMode: 'default',
      }),
      traceId: ' 4c05aa76bcba154e206497088857c1e1 ',
    })

    expect(input.settings).toEqual({
      client: { platform: 'web' },
      mode: 'solo',
      sourceLanguage: 'auto',
      targetLanguages: ['en'],
      translationModel: 'flash-v2',
      voiceMode: 'default',
    })
    expect(input.traceId).toBe('4c05aa76bcba154e206497088857c1e1')
  })

  it('leaves settings and trace id out when the session did not report them', () => {
    const input = buildConsumerHistoryInput({
      sessionId: 'session-plain',
      provider: 'flash',
      sourceLanguage: 'zh',
      targetLanguages: ['en'],
      durationMs: 1_000,
      rows: [{ id: 'row-1', primaryLanguage: 'en', source: '你好。', startMs: 0, translations: { en: 'Hello.' } }],
      traceId: '   ',
    })

    expect('settings' in input).toBe(false)
    expect('traceId' in input).toBe(false)
  })

  it('keeps every primary-language layout while deriving the summary from the selected layout', () => {
    const input = buildConsumerHistoryInput({
      sessionId: 'session-layouts',
      provider: 'flash-v2',
      sourceLanguage: 'zh',
      targetLanguages: ['ja', 'en'],
      durationMs: 2_000,
      rows: [
        { id: 'en-1', source: '第一句。', startMs: 0, translations: { en: 'First.' }, layoutLanguage: 'en' },
        { id: 'en-2', source: '第二句。', startMs: 1_000, translations: { en: 'Second.' }, layoutLanguage: 'en' },
        { id: 'ja-1', source: '第一句。第二句。', startMs: 0, translations: { ja: '第一文と第二文。' }, layoutLanguage: 'ja' },
      ],
    })

    expect(input.targetLanguage).toBe('ja')
    expect(input.sourceText).toBe('第一句。第二句。')
    expect(input.translationText).toBe('第一文と第二文。')
    expect(input.units.map((unit) => unit.layoutLanguage)).toEqual(['en', 'en', 'ja'])
  })

  it('builds input and per-language output ranges without crossing speakers', () => {
    const units = [
      { id: 'a-1', text: 'One.', side: 'a' as const, startMs: 0, outputAudioStarts: { en: 100 }, outputAudioEnds: { en: 700 } },
      { id: 'b-1', text: 'Two.', side: 'b' as const, startMs: 50, outputAudioStarts: { en: 200 } },
      { id: 'a-2', text: 'Three.', side: 'a' as const, startMs: 1_500, outputAudioStarts: { en: 900 } },
      { id: 'b-2', text: 'Four.', side: 'b' as const, startMs: 1_800, outputAudioStarts: { en: 1_200 } },
    ]

    expect(consumerHistoryAudioRange(units, 0)).toEqual({ startMs: 0, endMs: 1_500 })
    expect(consumerHistoryAudioRange(units, 0, 'en')).toEqual({ startMs: 100, endMs: 700 })
    expect(consumerHistoryAudioRange(units, 1, 'en')).toEqual({ startMs: 200, endMs: 1_200 })
    expect(consumerHistoryAudioRange(units, 2, 'ja')).toBeNull()
  })

  it('uses the authenticated consumer endpoints to save, list, load, delete and share', async () => {
    const fetcher = vi.fn<ConsumerFetcher>()
      .mockResolvedValueOnce(response(201, { id: 'history-1', createdAt: '2026-09-01T00:00:00Z' }))
      .mockResolvedValueOnce(response(200, { records: [{ id: 'history-1', targetLanguages: ['en', 'ja'], mode: 'solo' }] }))
      .mockResolvedValueOnce(response(200, { id: 'history-1', units: [] }))
      .mockResolvedValueOnce(response(200, { ok: 'true' }))
      .mockResolvedValueOnce(response(200, { token: 'share-1', path: '/s/share-1', expiresAt: '2026-10-01T00:00:00Z' }))
    const input = buildConsumerHistoryInput({
      sessionId: 'session-1', provider: 'flash', sourceLanguage: 'zh', targetLanguages: ['en'], durationMs: 1000,
      rows: [{ id: 'row-1', source: '你好', startMs: 0, translations: { en: 'Hello' } }],
    })

    expect(await saveConsumerHistory(input, fetcher)).toMatchObject({ id: 'history-1' })
    expect(await listConsumerHistory(fetcher)).toEqual([
      { id: 'history-1', targetLanguages: ['en', 'ja'], mode: 'solo' },
    ])
    expect(await loadConsumerHistory('history-1', fetcher)).toMatchObject({ id: 'history-1' })
    await expect(deleteConsumerHistory('history-1', fetcher)).resolves.toBeUndefined()
    expect(await createConsumerShareLink('history-1', 'https://simultrans-canary.lunalabs.cn', fetcher))
      .toMatchObject({ url: 'https://simultrans-canary.lunalabs.cn/s/share-1' })

    expect(fetcher.mock.calls[0][0]).toBe('/api/consumer/history')
    expect(fetcher.mock.calls[1][0]).toBe('/api/consumer/history')
    expect(fetcher.mock.calls[2][0]).toBe('/api/consumer/history/history-1')
    expect(fetcher.mock.calls[3]).toEqual(['/api/consumer/history/history-1', { method: 'DELETE' }])
    expect(fetcher.mock.calls[4][0]).toBe('/api/consumer/shares')
  })

  it('keeps a synchronous checkpoint until a later authenticated retry succeeds', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    values.set('consumer_access_token', `e30.${btoa(JSON.stringify({ sub: 'owner-a' }))}.signature`)
    const input = buildConsumerHistoryInput({
      sessionId: 'cs-interrupted', provider: 'flash-v2', sourceLanguage: 'zh', targetLanguages: ['en'], durationMs: 1000,
      rows: [{ id: 'row-1', source: '你好', startMs: 0, translations: { en: 'Hello' } }],
    })
    checkpointConsumerHistory(input)
    const failed = vi.fn<ConsumerFetcher>().mockRejectedValue(new Error('offline'))
    await retryConsumerHistoryCheckpoints(failed)
    const recovered = vi.fn<ConsumerFetcher>().mockResolvedValue(response(201, { id: 'history-1' }))
    await retryConsumerHistoryCheckpoints(recovered)
    await retryConsumerHistoryCheckpoints(recovered)

    expect(failed).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(failed.mock.calls[0][1]?.body))).toMatchObject({
      sessionId: 'cs-interrupted',
      abnormalExit: true,
      completionReason: 'client_checkpoint',
    })
    expect(recovered).toHaveBeenCalledTimes(1)
    clearConsumerHistoryCheckpoint(input.sessionId)
  })

  it('keeps interrupted checkpoints isolated to the JWT subject', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    const token = (subject: string) => `e30.${btoa(JSON.stringify({ sub: subject }))}.signature`
    values.set('consumer_access_token', token('owner-a'))
    expect(consumerHistoryCheckpointOwner()).toBe('owner-a')
    checkpointConsumerHistory(buildConsumerHistoryInput({
      sessionId: 'cs-owner-a', provider: 'flash-v2', sourceLanguage: 'zh', targetLanguages: ['en'], durationMs: 1000,
      rows: [{ id: 'row-1', source: '私有原文', startMs: 0, translations: { en: 'Private text' } }],
    }))

    values.set('consumer_access_token', token('owner-b'))
    const fetcher = vi.fn<ConsumerFetcher>().mockResolvedValue(response(201, { id: 'history-b' }))
    await retryConsumerHistoryCheckpoints(fetcher)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('upgrades a legacy checkpoint to an abnormal exit before retrying it', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    values.set('consumer_access_token', `e30.${btoa(JSON.stringify({ sub: 'owner-legacy' }))}.signature`)
    const legacy = buildConsumerHistoryInput({
      sessionId: 'cs-legacy', provider: 'flash-v2', sourceLanguage: 'zh', targetLanguages: ['en'], durationMs: 1000,
      rows: [{ id: 'row-1', source: '旧缓存', startMs: 0, translations: { en: 'Legacy cache' } }],
    })
    values.set('simultrans.consumerHistoryCheckpoints.v2:owner-legacy', JSON.stringify([legacy]))
    const fetcher = vi.fn<ConsumerFetcher>().mockResolvedValue(response(201, { id: 'history-legacy' }))

    await retryConsumerHistoryCheckpoints(fetcher)

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      sessionId: 'cs-legacy',
      abnormalExit: true,
      completionReason: 'client_checkpoint',
    })
  })

  it('looks up the saved history id by session id and treats a missing record as not saved yet', async () => {
    const calls: string[] = []
    const fetcher: ConsumerFetcher = async (path) => {
      calls.push(path)
      if (path.includes('sess-saved')) return response(200, { id: 'history-1', sessionId: 'sess-saved' })
      if (path.includes('sess-old-backend')) return response(405, null)
      if (path.includes('sess-broken')) return response(500, { error: '存储不可用' })
      return response(404, { error: '历史记录尚未保存', code: 'history_not_found' })
    }
    await expect(lookupConsumerHistoryId('sess-saved', fetcher)).resolves.toBe('history-1')
    await expect(lookupConsumerHistoryId('left:right', fetcher)).resolves.toBe('')
    await expect(lookupConsumerHistoryId('sess-old-backend', fetcher)).resolves.toBe('')
    await expect(lookupConsumerHistoryId('sess-broken', fetcher)).rejects.toThrow('存储不可用')
    await expect(lookupConsumerHistoryId('', fetcher)).resolves.toBe('')
    expect(calls).toEqual([
      '/api/consumer/history/lookup?sessionId=sess-saved',
      '/api/consumer/history/lookup?sessionId=left%3Aright',
      '/api/consumer/history/lookup?sessionId=sess-old-backend',
      '/api/consumer/history/lookup?sessionId=sess-broken',
    ])
  })

  it('loads authenticated server audio for a recovered session', async () => {
    const blob = new Blob(['wav'], { type: 'audio/wav' })
    const fetcher = vi.fn<ConsumerFetcher>().mockResolvedValue({
      ok: true, status: 200, blob: async () => blob,
    } as Response)

    await expect(loadConsumerHistoryAudio('history-1', 'cs-1', 'output-en', fetcher)).resolves.toBe(blob)
    expect(fetcher.mock.calls[0][0]).toBe('/api/consumer/history/history-1/audio/output-en?sessionId=cs-1')
  })
})
