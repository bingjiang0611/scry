import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from './store'

describe('turn recorder version', () => {
  it('matches the published CLI package version', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../packages/turn-recorder-cli/package.json', import.meta.url), 'utf8')
    ) as { version: string }
    expect(RECORDER_VERSION).toBe(packageJson.version)
  })
})
