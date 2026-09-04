import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from './store'

describe('turn recorder version', () => {
  it('matches the published CLI package version and release target', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../packages/turn-recorder-cli/package.json', import.meta.url), 'utf8')
    ) as {
      version: string
      os: string[]
      publishConfig: { registry: string }
    }
    expect(RECORDER_VERSION).toBe(packageJson.version)
    // README 的安装命令必须跟着版本走，否则用户会复制到过期的安装行。
    const readme = readFileSync(new URL('../../../packages/turn-recorder-cli/README.md', import.meta.url), 'utf8')
    expect(readme).toContain(`scry-turn-recorder@${packageJson.version}`)
    expect(packageJson.os).toEqual(['darwin', 'linux'])
    expect(packageJson.publishConfig.registry).toBe('https://registry.npmjs.org')
  })
})
