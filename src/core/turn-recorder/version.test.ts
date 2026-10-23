import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from './store'

describe('turn recorder version', () => {
  it('matches the published CLI package version and release target', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../packages/turn-recorder-cli/package.json', import.meta.url), 'utf8')
    ) as {
      name: string
      version: string
      os: string[]
      publishConfig?: { registry?: string }
    }
    expect(RECORDER_VERSION).toBe(packageJson.version)
    // README 的安装命令必须跟着版本走，否则用户会复制到过期的安装行。
    const readme = readFileSync(new URL('../../../packages/turn-recorder-cli/README.md', import.meta.url), 'utf8')
    expect(readme).toContain(`${packageJson.name}@${packageJson.version}`)
    expect(packageJson.os).toEqual(['darwin', 'linux'])
    // 发布目标由执行者的 npm 配置或 --registry 决定，不能把某个部署方的 registry 固化进包。
    expect(packageJson.publishConfig?.registry).toBeUndefined()
  })
})
