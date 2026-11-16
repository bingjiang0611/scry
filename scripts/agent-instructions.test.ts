import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('canonical agent instructions', () => {
  it('uses a root discovery symlink to the only project rule body', () => {
    const entry = resolve(root, 'AGENTS.md')
    const canonical = resolve(root, '.agents/AGENTS.md')
    expect(lstatSync(entry).isSymbolicLink()).toBe(true)
    expect(realpathSync(entry)).toBe(canonical)
    expect(lstatSync(canonical).isFile()).toBe(true)
    expect(readFileSync(entry, 'utf8')).toBe(readFileSync(canonical, 'utf8'))
    expect(existsSync(resolve(root, 'CLAUDE.md'))).toBe(false)
  })

  it.each(['contribution-triage', 'scry-design-system', 'scry-performance-climb'])(
    'keeps %s only in the shared skills directory',
    (name) => {
      expect(lstatSync(resolve(root, '.agents/skills', name, 'SKILL.md')).isFile()).toBe(true)
      expect(existsSync(resolve(root, '.claude/skills', name))).toBe(false)
    },
  )
})
