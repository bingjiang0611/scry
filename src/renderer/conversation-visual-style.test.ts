import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const shell = readFileSync(join(__dirname, 'codex-alignment-shell.css'), 'utf8')
const editorial = readFileSync(join(__dirname, 'codex-alignment-editorial.css'), 'utf8')
const workspace = readFileSync(join(__dirname, 'components/workspace-picker.css'), 'utf8')

function declaration(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[1]
}

describe('conversation reading hierarchy', () => {
  it('keeps a long workspace identity compact and quiet', () => {
    const title = declaration(shell, '.tb-thread b')
    expect(title).toContain('max-width: min(28vw, 240px)')
    expect(title).toContain('font-weight: 500')
    expect(declaration(shell, '.tb-thread .execution-location:not(.is-remote)')).toContain('border-color: transparent')
  })

  it('limits the reading measure without narrowing tool evidence', () => {
    expect(declaration(editorial, '.chat-body .model-text')).toContain('max-width: 704px')
    expect(declaration(editorial, '.chat-body .model-text:not(.thinking)')).toContain('color: var(--fg)')
    expect(declaration(editorial, '.chat-body .transcript-turn')).not.toContain('max-width: 704px')
  })
})

describe('compact control hover language', () => {
  it('uses the same recessed hover and radius for workspace and topbar actions', () => {
    expect(declaration(workspace, '.workspace-context-strip button:not(:disabled):hover,\n.workspace-context-strip button[aria-expanded="true"]')).toContain('background: var(--surface-hover)')
    expect(declaration(workspace, '.workspace-context-strip button')).toContain('border-radius: var(--r-sm)')
    expect(declaration(shell, '.panel-pill:hover')).toContain('background: var(--surface-hover)')
    expect(declaration(shell, '.panel-pill .ico')).toContain('width: 16px')
  })
})

describe('quiet composer surface', () => {
  it('uses a compact input and single-layer focus indication', () => {
    expect(declaration(editorial, '.runtime-composer .input,\n.runtime-composer textarea')).toContain('height: 64px')
    // 浅色主题的静态阴影权重更高，必须排除焦点态，否则焦点描边永远不显示。
    expect(declaration(editorial, ":root[data-theme='light'] .runtime-composer .composer-shell:not(:focus-within)")).toContain('0 1px 2px')
    const focus = declaration(editorial, '.runtime-composer .composer-shell:focus-within')
    expect(focus).toContain('0 0 0 1px var(--accent-soft)')
    expect(focus).not.toContain('5px')
    expect(declaration(editorial, '.runtime-composer .send')).toContain('box-shadow: none')
  })

  it('aligns run controls and recesses the attached workspace strip', () => {
    const controls = declaration(editorial, '.runtime-composer .permission-mode-trigger,\n.runtime-composer .model-effort-trigger,\n.runtime-composer .composer-action-controls .clibtn')
    expect(controls).toContain('height: 32px')
    expect(controls).toContain('background: transparent')
    expect(declaration(workspace, '.workspace-composer-context')).toContain('background: var(--surface-faint)')
  })
})
