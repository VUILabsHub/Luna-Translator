import { describe, expect, it, vi } from 'vitest'
import html from '../../public/welcome/index.html?raw'
import i18nScript from '../../public/welcome/welcome-i18n.js?raw'
import welcomeScript from '../../public/welcome/welcome.js?raw'

class Element {
  textContent = ''
  value = ''
  children: Element[] = []
  listeners: Record<string, () => void> = {}
  constructor(public attributes: Record<string, string> = {}) {}
  getAttribute(name: string) { return this.attributes[name] ?? null }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  removeAttribute(name: string) { delete this.attributes[name] }
  appendChild(child: Element) { this.children.push(child) }
  addEventListener(name: string, handler: () => void) { this.listeners[name] = handler }
}

function page(options: { languages?: string[], language?: string, saved?: string, query?: string, blockedStorage?: boolean, userAgent?: string } = {}) {
  const texts = Array.from(html.matchAll(/data-i18n="([^"]+)"/g), ([, key]) => new Element({ 'data-i18n': key }))
  const labels = Array.from(html.matchAll(/data-i18n-label="([^"]+)"/g), ([, key]) => new Element({ 'data-i18n-label': key }))
  const select = labels.find(element => element.getAttribute('data-i18n-label') === 'languageLabel')!
  const meta = new Element()
  const apkMeta = new Element({ hidden: '' })
  texts.push(apkMeta)
  const elements: Record<string, Element> = {
    'language-select': select,
    'experience-button': new Element({ href: '/' }),
    ios: new Element({ href: 'https://apps.apple.com/cn/app/id6806330215' }),
    'apk-button': new Element({ href: '/api/downloads/android/latest' }),
    'apk-meta': apkMeta,
    'ios-meta': new Element({ hidden: '' }),
    'footer-ios': new Element({ href: 'https://apps.apple.com/cn/app/id6806330215' }),
    'footer-apk': new Element({ href: '/api/downloads/android/latest' }),
    'footer-apk-meta': new Element({ hidden: '' }),
  }
  const storage = new Map(options.saved ? [['luna.welcome.language', options.saved]] : [])
  const window = {
    location: { href: 'https://example.test/welcome/' + (options.query || '') },
    history: { replaceState: (_state: unknown, _unused: string, url: string) => { window.location.href = url } },
    localStorage: {
      getItem: (key: string) => { if (options.blockedStorage) throw Error('blocked'); return storage.get(key) ?? null },
      setItem: (key: string, value: string) => { if (options.blockedStorage) throw Error('blocked'); storage.set(key, value) },
    },
  }
  const document = {
    documentElement: { lang: 'zh-CN' }, title: '',
    getElementById: (id: string) => elements[id],
    createElement: () => new Element(),
    querySelector: () => meta,
    querySelectorAll: (selector: string) => selector === '[data-i18n]'
      ? texts.filter(element => element.getAttribute('data-i18n')) : labels,
  }
  const navigator = { languages: options.languages, language: options.language, userAgent: options.userAgent || '', maxTouchPoints: 0 }
  new Function('window', 'document', 'navigator', i18nScript)(window, document, navigator)
  return {
    document, window, storage, texts, select, meta, apkMeta, apkButton: elements['apk-button'],
    iosButton: elements.ios, iosMeta: elements['ios-meta'], experienceButton: elements['experience-button'],
    text: (key: string) => texts.find(element => element.getAttribute('data-i18n') === key)?.textContent,
    choose: (locale: string) => { select.value = locale; select.listeners.change() },
    loadDownloads: (fetch: (url: string) => Promise<unknown>) => new Function('window', 'document', 'navigator', 'fetch', welcomeScript)(window, document, navigator, fetch),
  }
}

describe('Welcome language selection', () => {
  it.each([
    [['zh-CN'], 'zh-CN'], [['zh-SG'], 'zh-CN'], [['zh-Hans-HK'], 'zh-CN'],
    [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'], [['zh-Hant'], 'zh-TW'],
    [['en-US'], 'en'], [['en-GB'], 'en'], [['fr-FR', 'zh-TW', 'en'], 'zh-TW'],
    [['ja-JP'], 'en'], [[], 'en'],
  ])('matches browser preferences %j to %s', (languages, expected) => {
    expect(page({ languages }).document.documentElement.lang).toBe(expected)
  })

  it('uses navigator.language when the language preference list is unavailable', () => {
    expect(page({ language: 'zh-HK' }).document.documentElement.lang).toBe('zh-TW')
  })

  it('prioritizes the URL, then the saved choice, then the browser', () => {
    expect(page({ languages: ['en'], saved: 'zh-TW', query: '?lang=zh-CN' }).document.documentElement.lang).toBe('zh-CN')
    expect(page({ languages: ['en'], saved: 'zh-TW' }).document.documentElement.lang).toBe('zh-TW')
    expect(page({ languages: ['en'], saved: 'invalid', query: '?lang=invalid' }).document.documentElement.lang).toBe('en')
  })

  it('still selects and switches languages when browser storage is blocked', () => {
    const view = page({ languages: ['zh-TW'], blockedStorage: true })
    expect(view.document.documentElement.lang).toBe('zh-TW')
    view.choose('en')
    expect(view.text('tryNow')).toBe('Try now')
  })

  it.each(['zh-CN', 'zh-TW', 'en'])('translates all HTML keys, title, description and labels in %s', (locale) => {
    const view = page({ query: '?lang=' + locale })
    for (const element of view.texts) {
      if (!element.getAttribute('data-i18n')) continue
      expect(element.textContent).toBeTruthy()
      expect(element.textContent).not.toBe(element.getAttribute('data-i18n'))
    }
    expect(view.document.title).toContain('Luna')
    expect(view.meta.getAttribute('content')).toBeTruthy()
    expect(view.select.getAttribute('aria-label')).toBeTruthy()
  })

  it('updates the page immediately and remembers a manual selection', () => {
    const view = page({ languages: ['zh-CN'] })
    view.choose('en')
    expect(view.text('openWeb')).toBe('Open web app')
    expect(view.text('brandName')).toBe('Luna Translator')
    expect(view.document.title).toBe('Luna Translator')
    expect(view.document.documentElement.lang).toBe('en')
    expect(view.storage.get('luna.welcome.language')).toBe('en')
    expect(new URL(view.window.location.href).searchParams.get('lang')).toBe('en')
    expect(page({ saved: view.storage.get('luna.welcome.language') }).document.documentElement.lang).toBe('en')
  })

  it('keeps Android version metadata hidden when the language changes', async () => {
    const view = page()
    view.loadDownloads(async () => ({ ok: true, json: async () => ({ version: '1.0', bytes: 58720256 }) }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.apkMeta.getAttribute('hidden')).toBe('')
    view.choose('zh-TW')
    expect(view.apkMeta.textContent).toBe('')
  })

  it('translates the unavailable-download state after switching languages', async () => {
    const view = page({ languages: ['zh-CN'] })
    view.loadDownloads(async () => ({ ok: false, status: 404 }))
    await vi.waitFor(() => expect(view.apkMeta.textContent).toBe('即将提供'))
    expect(view.apkButton.getAttribute('aria-disabled')).toBe('true')
    expect(view.document.getElementById('footer-apk').getAttribute('aria-disabled')).toBe('true')
    expect(view.document.getElementById('footer-apk-meta').getAttribute('data-i18n')).toBe('apkUnavailable')
    view.choose('en')
    expect(view.apkMeta.textContent).toBe('Coming soon')
  })

  it.each(['network', 'server', 'json'])('keeps Android downloads available when metadata fails: %s', async (failure) => {
    const view = page({ languages: ['zh-CN'] })
    view.loadDownloads(async () => {
      if (failure === 'network') throw Error('network')
      return { ok: failure !== 'server', status: failure === 'server' ? 503 : 200, json: async () => { throw Error('invalid JSON') } }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.apkMeta.getAttribute('hidden')).toBe('')
    expect(view.apkButton.getAttribute('aria-disabled')).toBeNull()
    expect(view.apkButton.getAttribute('href')).toBe('/api/downloads/android/latest')
    view.choose('en')
    expect(view.apkMeta.textContent).toBe('')
  })

  describe('iOS App Store link', () => {
    const staticHref = 'https://apps.apple.com/cn/app/id6806330215'
    const routed = (ios: () => Promise<unknown>) => async (url: string) => url === '/api/downloads/ios/latest.json'
      ? ios() : { ok: false, status: 404 }

    it('hides the version and follows a valid App Store link across a language change', async () => {
      const view = page({ languages: ['zh-CN'] })
      view.loadDownloads(routed(async () => ({ ok: true, json: async () => ({ version: '1.0', trackViewUrl: 'https://apps.apple.com/us/app/id6806330215' }) })))
      await vi.waitFor(() => expect(view.iosButton.getAttribute('href')).toBe('https://apps.apple.com/us/app/id6806330215'))
      expect(view.iosMeta.getAttribute('hidden')).toBe('')
      expect(view.iosButton.getAttribute('href')).toBe('https://apps.apple.com/us/app/id6806330215')
      expect(view.document.getElementById('footer-ios').getAttribute('href')).toBe('https://apps.apple.com/us/app/id6806330215')
      // Desktop: 立即体验 stays on the web app.
      expect(view.experienceButton.getAttribute('href')).toBe('/')
      view.choose('en')
      expect(view.iosMeta.textContent).toBe('')
    })

    it('moves 立即体验 to the returned link on an iPhone', async () => {
      const view = page({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })
      view.loadDownloads(routed(async () => ({ ok: true, json: async () => ({ version: '1.0.1', trackViewUrl: 'https://apps.apple.com/us/app/id6806330215' }) })))
      await vi.waitFor(() => expect(view.experienceButton.getAttribute('href')).toBe('https://apps.apple.com/us/app/id6806330215'))
      expect(view.experienceButton.getAttribute('href')).toBe('https://apps.apple.com/us/app/id6806330215')
    })

    it.each([
      ['javascript link', { version: '1.0', trackViewUrl: 'javascript:alert(1)' }, ''],
      ['foreign host', { version: '1.0', trackViewUrl: 'https://evil.example/cn/app/id6806330215' }, ''],
      ['markup in version', { version: '<b>1.0</b>', trackViewUrl: staticHref }, ''],
    ])('rejects a bad answer: %s', async (_name, latest, shown) => {
      const view = page()
      let done = false
      view.loadDownloads(routed(async () => ({ ok: true, json: async () => { done = true; return latest } })))
      await vi.waitFor(() => expect(done).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(view.iosButton.getAttribute('href')).toBe(staticHref)
      expect(view.iosMeta.textContent).toBe(shown)
      expect(view.iosMeta.getAttribute('hidden')).toBe(shown ? null : '')
    })

    it.each(['unavailable', 'network'])('keeps the static link and no version line when the lookup fails: %s', async (failure) => {
      const view = page()
      let called = false
      view.loadDownloads(routed(async () => {
        called = true
        if (failure === 'network') throw Error('network')
        return { ok: false, status: 503 }
      }))
      await vi.waitFor(() => expect(called).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(view.iosButton.getAttribute('href')).toBe(staticHref)
      expect(view.iosMeta.textContent).toBe('')
      expect(view.iosMeta.getAttribute('hidden')).toBe('')
    })
  })
})
