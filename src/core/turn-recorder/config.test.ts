import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverRepositories, resolveRecorderEnablement, resolveRecorderLocation, type RecorderConfig } from './config'

const config: RecorderConfig = {
  schemaVersion: 1,
  enabled: true,
  workspaceId: 'fixture',
  dataDir: '.scry',
  repositories: { mode: 'discover-nested-git', maxDepth: 2, exclude: ['excluded'] },
  capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
}

describe('discoverRepositories', () => {
  it('发现完整 nested Git 集合并套用 exclude，不依赖易漏仓 allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-nested-git-'))
    try {
      for (const path of [root, join(root, 'service-platform'), join(root, 'plugin-commerce-app'), join(root, 'group', 'service-detail'), join(root, 'excluded')]) {
        await mkdir(join(path, '.git'), { recursive: true })
        await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      }
      await expect(discoverRepositories(root, config)).resolves.toEqual([
        root,
        join(root, 'group', 'service-detail'),
        join(root, 'plugin-commerce-app'),
        join(root, 'service-platform')
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('recorder storage location', () => {
  it('采集熔断不阻塞只读定位，dataDir 符号链接则拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-location-'))
    const outside = await mkdtemp(join(tmpdir(), 'scry-location-outside-'))
    try {
      await writeFile(join(root, 'scry.config.json'), JSON.stringify({ ...config, enabled: false }))
      await writeFile(join(root, '.scry-disabled'), '')
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: true, dataRoot: join(root, '.scry') })
      await expect(resolveRecorderEnablement(root)).resolves.toMatchObject({ enabled: false, reason: 'sentinel' })

      await writeFile(join(root, 'scry.config.json'), JSON.stringify({ ...config, dataDir: '.' }))
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: false, reason: 'invalid_config' })

      await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
      await symlink(outside, join(root, '.scry'))
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: false, reason: 'invalid_config' })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('commitHook 只接受 entry 在显式 files 清单中的 workspace 相对路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-commit-hook-config-'))
    try {
      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        ...config,
        commitHook: {
          entry: '.claude/hooks/notify.py',
          files: ['.claude/hooks/notify.py', '.claude/hooks/uploader.py']
        }
      }))
      const enabled = await resolveRecorderEnablement(root)
      expect(enabled).toMatchObject({
        enabled: true,
        config: { commitHook: { entry: '.claude/hooks/notify.py', files: expect.any(Array) } }
      })

      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        ...config,
        commitHook: { entry: '../notify.py', files: ['../notify.py'] }
      }))
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: false, reason: 'invalid_config' })

      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        ...config,
        commitHook: { entry: '.claude/hooks/notify.py', files: ['.claude/hooks/uploader.py'] }
      }))
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: false, reason: 'invalid_config' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('读取 patch basename 排除规则并拒绝路径规则', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-patch-policy-config-'))
    try {
      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        ...config,
        capture: { ...config.capture, patchExcludeBasenames: [' .factorypath ', '.factorypath', '*.lock'] }
      }))
      await expect(resolveRecorderEnablement(root)).resolves.toMatchObject({
        enabled: true,
        config: { capture: { patchExcludeBasenames: ['.factorypath', '*.lock'] } }
      })

      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        ...config,
        capture: { ...config.capture, patchExcludeBasenames: ['config/.factorypath'] }
      }))
      await expect(resolveRecorderLocation(root)).resolves.toMatchObject({ valid: false, reason: 'invalid_config' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
