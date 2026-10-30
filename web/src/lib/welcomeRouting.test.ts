import { describe, expect, it } from 'vitest'
import script from '../../public/welcome/welcome.js?raw'

const appStore = 'https://apps.apple.com/cn/app/id6806330215'
const android = '/api/downloads/android/latest'

function resolveExperienceLink(navigator: Record<string, unknown>) {
  const link = (href: string) => ({
    href,
    getAttribute() { return this.href },
    setAttribute(name: string, value: string) { if (name === 'href') this.href = value },
  })
  const experienceButton = link('/')
  const elements = {
    'experience-button': experienceButton,
    ios: link(appStore),
    'apk-button': link(android),
    'apk-meta': { textContent: '' },
  }
  new Function('navigator', 'document', 'fetch', script)(
    navigator,
    { getElementById: (id: keyof typeof elements) => elements[id] },
    // Routing must work immediately, even while download metadata is pending.
    () => new Promise(() => {}),
  )
  return experienceButton.href
}

describe('Welcome 立即体验 device routing', () => {
  it.each([
    ['Mac Safari', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', maxTouchPoints: 0 }, '/'],
    ['Windows touch laptop', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', maxTouchPoints: 10 }, '/'],
    ['Android phone', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' }, android],
    ['Android tablet', { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' }, android],
    ['Android desktop mode with client hints', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', userAgentData: { platform: 'Android' } }, android],
    ['iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' }, appStore],
    ['iPad mobile mode', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' }, appStore],
    ['iPad desktop mode', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', maxTouchPoints: 5 }, appStore],
    ['unknown device', {}, '/'],
  ])('%s opens the appropriate destination', (_name, navigator, expected) => {
    expect(resolveExperienceLink(navigator)).toBe(expected)
  })
})
