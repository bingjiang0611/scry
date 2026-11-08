import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./electron-security-restart.mjs', import.meta.url), 'utf8')

describe('cold terminal replay workbench ownership', () => {
  it('does not activate retained terminal tabs in an inactive session workbench', () => {
    expect(source).not.toContain("document.querySelectorAll('.surface-tab-activate')")
    expect(source).toContain("panel.querySelectorAll('.surface-tab-activate')")
    for (const selector of ['button[aria-label="添加 Surface"]', '.terminal-state.running', 'button[aria-label="终端录制历史"]', '.terminal-pane:not([hidden]) .xterm-rows', 'button[aria-label="重新启动终端"]']) {
      expect(source).toContain(`current('${selector}')`)
    }
  })

  it('resolves controls through the current session root, not the first document match', () => {
    const match = source.match(/const current = (.+)\n/)
    expect(match).not.toBeNull()
    const selected = { id: 'selected-workbench-control' }
    const querySelector = vi.fn().mockReturnValue(selected)
    const document = { querySelector: vi.fn((selector: string) => selector === '[data-session-surface-current="true"]' ? { querySelector } : { id: 'hidden-workbench-control' }) }
    const current = runInNewContext(`(${match![1]})`, { document }) as (selector: string) => unknown
    expect(current('.terminal-state.running')).toBe(selected)
    expect(document.querySelector).toHaveBeenCalledExactlyOnceWith('[data-session-surface-current="true"]')
    expect(querySelector).toHaveBeenCalledExactlyOnceWith('.terminal-state.running')
  })
})
