import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCssManifest } from './css-test-reader'

const styles = readCssManifest(join(__dirname, 'styles.css'))
const alignedStyles = readCssManifest(join(__dirname, 'codex-alignment.css'))

function declaration(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`missing CSS selector: ${selector}`)
  return match[1]
}

describe('chat scroll stability', () => {
  it('disables native anchoring so opening a replaced transcript stays at the requested bottom', () => {
    expect(declaration(styles, '.chat')).toContain('overflow-anchor: none')
  })
})

describe('idle renderer paint budget', () => {
  it('keeps nonessential persistent indicators free of infinite animation', () => {
    for (const selector of ['.who .spin', '.model-text.streaming::after', '.run-status-dot']) {
      expect(declaration(styles, selector)).not.toContain('animation:')
    }
  })

  it('keeps skeleton motion compositor-only', () => {
    expect(declaration(styles, '.sk-line::after')).toContain('animation: skeleton-shimmer')
    expect(declaration(styles, '@keyframes skeleton-shimmer')).toContain('transform: translateX')
  })

  it('shows running sessions as neutral rotating rings', () => {
    expect(declaration(styles, '.sb-running')).toContain('border: 2px solid var(--dim2)')
    expect(declaration(styles, '.sb-running')).toContain('border-top-color: transparent')
    expect(declaration(styles, '.sb-running')).toContain('animation: sb-running-spin 900ms linear infinite')
    expect(declaration(styles, '@keyframes sb-running-spin')).toContain('transform: rotate(360deg)')
  })

  it('does not display-lock interactive transcript turns', () => {
    expect(styles).not.toMatch(/[^{}]*\.transcript-turn[^{}]*\{[^}]*content-visibility:/s)
  })

  it('pauses incidental animations when the Electron page is hidden', () => {
    expect(styles).toContain(":root[data-page-visibility='hidden'] *")
    expect(styles).toContain('animation-play-state: paused !important')
  })

  it('does not keep a full-width backdrop-filter surface on the persistent topbar', () => {
    expect(declaration(alignedStyles, '.topbar')).not.toContain('backdrop-filter')
  })
})
