import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScryCli } from './scry'
import { workspace, captureStdout } from './scry.test-fixture.js'


describe('scry commit-hook', () => {
  async function hookWorkspace(): Promise<{ root: string; grantDir: string }> {
    const root = await workspace()
    const grantDir = join(root, 'grants')
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, unknown>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    process.env.SCRY_GRANT_DIR = grantDir
    return { root, grantDir }
  }

  afterEach(() => {
    delete process.env.SCRY_GRANT_DIR
  })

  it('未配置 commitHook 时 status 退出 0 并显式说明 backlog 不可观测', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    const payload = JSON.parse(stdout.text()) as Record<string, any>
    expect(payload.configured).toBe(false)
    expect(payload.activation.status).toBe('not-configured')
    expect(payload.notifications.notifyBacklog).toBeNull()
    expect(payload.notifications.backlogEvidence).toContain('unavailable')
  })

  it('status 和不带 --yes 的 trust 都会自动授权有效 bundle', async () => {
    const { root, grantDir } = await hookWorkspace()
    const statusOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    expect((JSON.parse(statusOut.text()) as Record<string, any>).activation.status).toBe('trusted')
    await expect(access(join(grantDir))).resolves.toBeUndefined()

    vi.restoreAllMocks()
    const trustOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--workspace', root])).resolves.toBe(0)
    const payload = JSON.parse(trustOut.text()) as Record<string, any>
    expect(payload).toMatchObject({ status: 'trusted', source: 'auto' })
  })

  it('兼容 --yes，且脚本变化后自动更新指纹', async () => {
    const { root } = await hookWorkspace()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)

    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\necho tampered\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    expect((JSON.parse(stdout.text()) as Record<string, any>).activation.status).toBe('trusted')

    await expect(runScryCli(['commit-hook', 'revoke', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
  })

  it('entry 缺少可执行位时退出 5', async () => {
    const { root } = await hookWorkspace()
    await chmod(join(root, 'uploader.sh'), 0o644)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(5)
    expect((JSON.parse(stdout.text()) as Record<string, any>).detail).toContain('executable')
  })
})

describe('scry recorder notify-drain', () => {
  it('未配置时不投递，配置有效 hook 后自动激活', async () => {
    const root = await workspace()
    await expect(runScryCli(['recorder', 'notify-drain', '--workspace', root])).resolves.toBe(0)

    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, unknown>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    process.env.SCRY_GRANT_DIR = join(root, 'grants')
    try {
      const stdout = captureStdout()
      await expect(runScryCli(['recorder', 'notify-drain', '--workspace', root])).resolves.toBe(0)
      expect((JSON.parse(stdout.text()) as Record<string, any>).activation).toBe('trusted')
    } finally {
      delete process.env.SCRY_GRANT_DIR
    }
  })
})

describe('scry integrations diff/uninstall', () => {
  const managed = "SCRY_HANDLER_ID=turn-recorder-v1 sh -c 'exec ./.scry/provider-hook.sh claude Stop'"
  const foreign = 'echo user-hook'

  async function claudeWorkspace(hooks: Record<string, unknown>): Promise<string> {
    const root = await workspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks }, null, 2))
    await mkdir(join(root, '.scry'), { recursive: true })
    await writeFile(join(root, '.scry', 'provider-hook.sh'), '#!/bin/sh\nexport SCRY_HANDLER_ID=turn-recorder-v1\n')
    await writeFile(join(root, '.scry', 'cli-path'), '/usr/local/bin/scry\n')
    return root
  }

  it('diff 零副作用，并按 handler id 报告托管条目与外部条目', async () => {
    const root = await claudeWorkspace({
      Stop: [{ hooks: [{ type: 'command', command: managed }, { type: 'command', command: foreign }] }]
    })
    const before = await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'diff', '--workspace', root])).resolves.toBe(3)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    const claude = result.providers.find((row: any) => row.provider === 'claude')
    expect(claude).toMatchObject({ present: true, managedEvents: ['Stop'], foreignEntries: 1 })
    expect(claude.missingEvents).toContain('UserPromptSubmit')
    expect(result.pi.scope).toBe('user-global')
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(before)
  })

  it('diff 检出命令形状漂移造成的重复托管条目', async () => {
    const root = await claudeWorkspace({
      Stop: [
        { hooks: [{ type: 'command', command: managed }] },
        { hooks: [{ type: 'command', command: `${managed} --legacy` }] }
      ]
    })
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'diff', '--workspace', root])).resolves.toBe(3)
    const claude = (JSON.parse(stdout.text()) as Record<string, any>).providers.find((row: any) => row.provider === 'claude')
    expect(claude.duplicateEvents).toEqual(['Stop'])
  })

  it('uninstall 不带 --yes 只打印计划', async () => {
    const root = await claudeWorkspace({ Stop: [{ hooks: [{ type: 'command', command: managed }] }] })
    const before = await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(stdout.text()) as Record<string, any>).status).toBe('approval-required')
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(before)
    await expect(access(join(root, '.scry', 'provider-hook.sh'))).resolves.toBeUndefined()
  })

  it('uninstall --yes 只删托管条目，保留用户 hook、records 与配置', async () => {
    const root = await claudeWorkspace({
      Stop: [{ hooks: [{ type: 'command', command: managed }, { type: 'command', command: foreign }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: managed }] }]
    })
    await mkdir(join(root, '.scry', 'records'), { recursive: true })
    await writeFile(join(root, '.scry', 'records', 'keep.json'), '{}')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>

    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')) as Record<string, any>
    expect(settings.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: foreign }])
    // A group that only held our entry is dropped, and an empty event key is removed.
    expect(settings.hooks.PreToolUse).toBeUndefined()
    await expect(access(join(root, '.scry', 'provider-hook.sh'))).rejects.toThrow()
    await expect(access(join(root, '.scry', 'cli-path'))).rejects.toThrow()
    await expect(access(join(root, '.scry', 'records', 'keep.json'))).resolves.toBeUndefined()
    await expect(access(join(root, 'scry.config.json'))).resolves.toBeUndefined()
    expect(result.retained.map((item: any) => item.path)).toContain(join(root, '.scry', 'records'))
    expect(result.rewritten).toContain(join(root, '.claude', 'settings.local.json'))
  })

  it('坏 JSON 与非托管 OpenCode 插件被跳过而不是破坏', async () => {
    const root = await workspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ not json')
    await mkdir(join(root, '.opencode', 'plugins'), { recursive: true })
    await writeFile(join(root, '.opencode', 'plugins', 'scry-recorder.js'), '// hand written\n')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result.skipped.map((item: any) => item.path)).toEqual([
      join(root, '.claude', 'settings.local.json'),
      join(root, '.opencode', 'plugins', 'scry-recorder.js')
    ])
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe('{ not json')
    await expect(access(join(root, '.opencode', 'plugins', 'scry-recorder.js'))).resolves.toBeUndefined()
  })
})
