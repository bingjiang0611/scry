import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const alignedStyles = readFileSync(join(__dirname, 'codex-alignment.css'), 'utf8')

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

  it('keeps the restored running and skeleton motion compositor-only', () => {
    expect(declaration(styles, '.sb-running')).toContain('animation: sb-running-spin')
    expect(declaration(styles, '.sk-line::after')).toContain('animation: skeleton-shimmer')
    expect(declaration(styles, '@keyframes sb-running-spin')).toContain('transform: rotate')
    expect(declaration(styles, '@keyframes skeleton-shimmer')).toContain('transform: translateX')
  })

  it('keeps background run status visible without frame-rate motion', () => {
    expect(declaration(styles, '.sb-sess:not(.active) .sb-running')).toContain('animation-play-state: paused')
    expect(declaration(styles, '.sb-sess.active .sb-running')).toContain('animation-timing-function: steps(12)')
    expect(declaration(styles, '.sb-sess.active .sb-running')).toContain('animation-duration: 1.5s')
  })

  it('pauses incidental animations when the Electron page is hidden', () => {
    expect(styles).toContain(":root[data-page-visibility='hidden'] *")
    expect(styles).toContain('animation-play-state: paused !important')
  })

  it('does not keep a full-width backdrop-filter surface on the persistent topbar', () => {
    expect(declaration(alignedStyles, '.topbar')).not.toContain('backdrop-filter')
  })
})
