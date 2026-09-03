import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDER_VERSION } from '../core/turn-recorder/store'
import { parseArgs, runScryCli } from './scry'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-cli-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'cli-test',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

function captureStdout(): { text: () => string } {
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write)
  return { text: () => output }
}

describe('Scry CLI arguments', () => {
  it('支持等号参数且布尔参数不吞 positional', () => {
    const parsed = parseArgs(['turns', 'summary', '--all', 'session-1', '--workspace=/repo', '--providers=claude,codex'])
    expect(parsed.positionals).toEqual(['turns', 'summary', 'session-1'])
    expect(parsed.flags.get('all')).toBe(true)
    expect(parsed.flags.get('workspace')).toBe('/repo')
    expect(parsed.flags.get('providers')).toBe('claude,codex')
  })

  it('拒绝未知参数和缺失值', () => {
    expect(() => parseArgs(['doctor', '--workspce', '/repo'])).toThrow('unknown option')
    expect(() => parseArgs(['doctor', '--workspace'])).toThrow('missing value')
  })

  it('help 使用 stdout 并成功退出', async () => {
    const stdout = captureStdout()
    await expect(runScryCli(['--help'])).resolves.toBe(0)
    expect(stdout.text()).toContain('Usage:')
  })

  it('--version 不会被空 positional 误判成 help', async () => {
    const stdout = captureStdout()
    await expect(runScryCli(['--version'])).resolves.toBe(0)
    expect(stdout.text()).toBe(`${RECORDER_VERSION}\n`)
  })
})

describe('Scry CLI health and lookup contracts', () => {
  it('历史累计错误不让当前 doctor 永久 degraded', async () => {
    const root = await workspace()
    await mkdir(join(root, '.scry'), { recursive: true })
    await writeFile(join(root, '.scry', 'health.json'), JSON.stringify({
      schemaVersion: 1,
      droppedEvents: 3,
      orphanEvents: 2,
      pendingCount: 0,
      oldestPendingAgeMs: 0,
      recoveredRecords: 0,
      lastSuccessAt: new Date().toISOString()
    }))
    const stdout = captureStdout()

    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ healthy: true })
  })

  it('记录不存在时输出可解析结果并退出 1', async () => {
    const root = await workspace()
    const stdout = captureStdout()

    await expect(runScryCli(['turns', 'show', '999', '--workspace', root])).resolves.toBe(1)
    expect(JSON.parse(stdout.text())).toEqual({ found: false, selector: '999' })
  })
})

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

  it('已配置未授权时 status 退出 3，trust 不带 --yes 只打印待授权 bundle', async () => {
    const { root, grantDir } = await hookWorkspace()
    const statusOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(statusOut.text()) as Record<string, any>).activation.status).toBe('configured-not-trusted')

    vi.restoreAllMocks()
    const trustOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--workspace', root])).resolves.toBe(3)
    const payload = JSON.parse(trustOut.text()) as Record<string, any>
    expect(payload.status).toBe('approval-required')
    expect(payload.files).toHaveLength(1)
    expect(payload.warning).toContain('read every record')
    await expect(access(join(grantDir))).rejects.toThrow()
  })

  it('--yes 授权后 status 退出 0，篡改后退出 4', async () => {
    const { root } = await hookWorkspace()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)

    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\necho tampered\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(4)
    expect((JSON.parse(stdout.text()) as Record<string, any>).activation.status).toBe('fingerprint-mismatch')

    await expect(runScryCli(['commit-hook', 'revoke', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(3)
  })

  it('entry 缺少可执行位时退出 5', async () => {
    const { root } = await hookWorkspace()
    await chmod(join(root, 'uploader.sh'), 0o644)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(5)
    expect((JSON.parse(stdout.text()) as Record<string, any>).detail).toContain('executable')
  })
})
