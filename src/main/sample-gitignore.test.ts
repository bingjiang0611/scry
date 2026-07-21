import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('OpenDesign adapter local samples', () => {
  it('keeps runtime evidence samples out of git by ignoring .local', () => {
    const lines = readFileSync(join(process.cwd(), '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
    expect(lines).toContain('.local/')
  })
})
