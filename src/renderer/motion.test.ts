import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from './motion'

const css = readFileSync(fileURLToPath(new URL('./motion.css', import.meta.url)), 'utf8')

function cssValue(name: string): string {
  return css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? ''
}

function transitionErrors(source: string): string[] {
  const errors: string[] = []
  for (const match of source.matchAll(/\btransition\s*:\s*([^;]+)/g)) {
    const value = match[1].trim()
    if (value !== 'none' && !value.includes('var(--ease-')) errors.push(`missing role curve: ${value}`)
    if (value.includes('linear')) errors.push(`linear transition: ${value}`)
  }
  return errors
}

describe('motion tokens', () => {
  it('keeps CSS and TypeScript token values aligned', () => {
    expect(MOTION).toEqual({
      durationHover: 120,
      durationSm: 200,
      durationMd: 250,
      durationLg: 400,
      durationExitSm: 150,
      durationExitMd: 200,
      durationReduced: 150,
      durationOvershoot: 300,
      easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
      easeOutStrong: 'cubic-bezier(0.22, 1, 0.36, 1)',
      easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
      easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
      easeOvershoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      easeSpring: 'linear(0, .32, .78, 1.04, 1.09, 1.06, 1.02, 1, .99, .99, 1)'
    })
    expect(cssValue('--duration-hover')).toBe(`${MOTION.durationHover}ms`)
    expect(cssValue('--duration-sm')).toBe(`${MOTION.durationSm}ms`)
    expect(cssValue('--duration-md')).toBe(`${MOTION.durationMd}ms`)
    expect(cssValue('--duration-lg')).toBe(`${MOTION.durationLg}ms`)
    expect(cssValue('--duration-exit-sm')).toBe(`${MOTION.durationExitSm}ms`)
    expect(cssValue('--duration-exit-md')).toBe(`${MOTION.durationExitMd}ms`)
    expect(cssValue('--duration-reduced')).toBe(`${MOTION.durationReduced}ms`)
    expect(cssValue('--duration-overshoot')).toBe(`${MOTION.durationOvershoot}ms`)
    expect(cssValue('--ease-out')).toBe(MOTION.easeOut)
    expect(cssValue('--ease-out-strong')).toBe(MOTION.easeOutStrong)
    expect(cssValue('--ease-in')).toBe(MOTION.easeIn)
    expect(cssValue('--ease-in-out')).toBe(MOTION.easeInOut)
    expect(cssValue('--ease-overshoot')).toBe(MOTION.easeOvershoot)
    expect(css).toContain(`--ease-spring: ${MOTION.easeSpring}`)
  })

  it('keeps every renderer CSS transition on a named role curve', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === 'string' && file.endsWith('.css'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(`${root}${file}`, 'utf8')
      expect(transitionErrors(source), file).toEqual([])
      expect(source, file).not.toMatch(/--dur-|--ease-struct|--ease-exit/)
      if (file !== 'motion.css') expect(source, file).not.toContain('cubic-bezier(')
    }
    expect(transitionErrors('.bad { transition: transform 100ms linear; }')).toEqual([
      'missing role curve: transform 100ms linear',
      'linear transition: transform 100ms linear'
    ])
  })

  it('reduces only existing transition durations instead of animating static elements', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const name of ['--duration-hover', '--duration-sm', '--duration-md', '--duration-lg', '--duration-exit-sm', '--duration-exit-md', '--duration-overshoot']) {
      expect(reduced).toContain(`${name}: var(--duration-reduced)`)
    }
    const globalCss = readFileSync(fileURLToPath(new URL('./styles-settings-inventory.css', import.meta.url)), 'utf8')
    const universal = globalCss.match(/\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/)
    expect(universal?.[1]).toBeDefined()
    expect(universal?.[1]).not.toContain('transition-duration')
  })

  it('tracks live reduced-motion media changes and unsubscribes', () => {
    let matches = false
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    const media = {
      get matches() { return matches },
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback },
      removeEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { if (listener === callback) listener = undefined }
    } as unknown as MediaQueryList
    vi.stubGlobal('window', { matchMedia: vi.fn(() => media) })
    try {
      expect(prefersReducedMotion()).toBe(false)
      const changed = vi.fn()
      const unsubscribe = subscribeReducedMotion(changed)
      matches = true
      listener?.({ matches: true, media: media.media } as MediaQueryListEvent)
      expect(prefersReducedMotion()).toBe(true)
      expect(changed).toHaveBeenCalledExactlyOnceWith(true)
      unsubscribe()
      matches = false
      listener?.({ matches: false, media: media.media } as MediaQueryListEvent)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
