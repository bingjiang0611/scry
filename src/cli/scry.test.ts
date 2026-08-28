import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const parsed = parseArgs(['turns', 'summary', '--all', 'session-1', '--workspace=/repo'])
    expect(parsed.positionals).toEqual(['turns', 'summary', 'session-1'])
    expect(parsed.flags.get('all')).toBe(true)
    expect(parsed.flags.get('workspace')).toBe('/repo')
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
