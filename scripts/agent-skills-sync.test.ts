import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Codex/Pi discover repository skills under .agents/skills and Claude Code under
// .claude/skills. Both trees are committed copies; a drifted copy would give agents
// different rules depending on which tool they run.
const root = join(__dirname, '..')
const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name)
  return statSync(path).isDirectory() ? files(path) : [path]
})
const tree = (base: string) => Object.fromEntries(files(join(root, base)).filter(path => !path.includes('__pycache__'))
  .map(path => [relative(join(root, base), path), readFileSync(path, 'utf8')]))

describe('repository agent skills', () => {
  it('keeps .agents/skills and .claude/skills identical', () => {
    expect(tree('.claude/skills')).toEqual(tree('.agents/skills'))
  })
})
