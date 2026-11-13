import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listRecords, recordContentItems } from '../core/turn-recorder/store'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { appTraceContentRoot } from '../core/turn-recorder/app-trace-content'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { runScryCli } from './scry'
import { roots, workspace, captureStdout } from './scry.test-fixture.js'

describe('scry recorder content repair', () => {
  async function hookedRecordWithBodies(): Promise<{ root: string; dataRoot: string; appData: string; refs: number }> {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.capture.toolOutput = 'full'
    await writeFile(configPath, JSON.stringify(config))
    const base = { provider: 'claude' as const, workspace: root }
    const event = (extra: Record<string, unknown>) => ({ session_id: 'repair-1', timestamp: new Date().toISOString(), ...extra })
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: event({ prompt: 'capture' }) })
    await handleRecorderHook({ ...base, event: 'PreToolUse:Bash', payload: event({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'generate' } }) })
    await handleRecorderHook({ ...base, event: 'PostToolUse:Bash', payload: event({ tool_name: 'Bash', tool_use_id: 'call', tool_response: 'REPAIRABLE-OUTPUT' }) })
    await handleRecorderHook({ ...base, event: 'Stop', payload: event({ assistant_response: 'done' }) })
    const [record] = await listRecords(dataRoot)
    // 线上形态：记录还在本库，正文只在 App trace 库。把字节搬过去，再清空本库内容目录。
    const appData = await mkdtemp(join(tmpdir(), 'scry-cli-app-data-'))
    roots.push(appData)
    const appRoot = appTraceContentRoot(appData, root)
    for (const shard of await readdir(join(dataRoot, 'content', 'sha256'))) {
      await mkdir(join(appRoot, 'content', 'sha256', shard), { recursive: true })
      for (const name of await readdir(join(dataRoot, 'content', 'sha256', shard))) {
        await writeFile(join(appRoot, 'content', 'sha256', shard, name), await readFile(join(dataRoot, 'content', 'sha256', shard, name)))
      }
    }
    await rm(join(dataRoot, 'content'), { recursive: true, force: true })
    return { root, dataRoot, appData, refs: new Set(recordContentItems(record).map((item) => item.ref.sha256)).size }
  }

  it('演练报告可修复数且不写盘，--apply 后引用重新可解析', async () => {
    const { root, dataRoot, appData, refs } = await hookedRecordWithBodies()
    expect(refs).toBeGreaterThan(1)

    const planned = captureStdout()
    await expect(runScryCli(['recorder', 'content', 'repair', '--workspace', root, '--app-data', appData])).resolves.toBe(0)
    expect(JSON.parse(planned.text())).toMatchObject({
      action: 'content-repair',
      status: 'planned',
      applied: false,
      records: 1,
      refs,
      present: 0,
      repairable: refs,
      missing: 0,
      repaired: 0
    })
    await expect(readRecorderContent(dataRoot, { storage: 'recorder-content-v1', sha256: 'a'.repeat(64), bytes: 1, encoding: 'utf8' }))
      .rejects.toThrow()
    const stillEmpty = await readdir(join(dataRoot, 'content', 'sha256')).catch(() => [])
    expect(stillEmpty).toEqual([])

    const applied = captureStdout()
    await expect(runScryCli(['recorder', 'content', 'repair', '--workspace', root, '--app-data', appData, '--apply'])).resolves.toBe(0)
    expect(JSON.parse(applied.text())).toMatchObject({ status: 'applied', applied: true, repairable: refs, repaired: refs })

    const [record] = await listRecords(dataRoot)
    const output = record.tools.value![0].outputContent!.contentRef!
    await expect(readRecorderContent(dataRoot, output)).resolves.toContain('REPAIRABLE-OUTPUT')
    // 已修复后重复执行是幂等的：全部命中本库，没有可复制的正文。
    const idempotent = captureStdout()
    await expect(runScryCli(['recorder', 'content', 'repair', '--workspace', root, '--app-data', appData])).resolves.toBe(0)
    expect(JSON.parse(idempotent.text())).toMatchObject({ present: refs, repairable: 0, missing: 0 })
  })

  it('--record-id 可重复给出且只统计指定记录', async () => {
    const { root, dataRoot, appData } = await hookedRecordWithBodies()
    const [record] = await listRecords(dataRoot)
    const stdout = captureStdout()
    await expect(runScryCli([
      'recorder', 'content', 'repair', '--workspace', root, '--app-data', appData,
      '--record-id', record.recordId, '--record-id', record.recordId
    ])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ records: 1, missing: 0, present: 0 })
  })

  it('找不到的正文只列清单，退出码 3', async () => {
    const { root } = await hookedRecordWithBodies()
    const emptyAppData = await mkdtemp(join(tmpdir(), 'scry-cli-app-data-empty-'))
    roots.push(emptyAppData)
    const stdout = captureStdout()
    await expect(runScryCli(['recorder', 'content', 'repair', '--workspace', root, '--app-data', emptyAppData])).resolves.toBe(3)
    const report = JSON.parse(stdout.text()) as { status: string; missing: number; missingItems: Array<{ recordId: string; path: string }>; sources: string[] }
    expect(report.status).toBe('missing')
    expect(report.missing).toBeGreaterThan(0)
    expect(report.missingItems.map((item) => item.path)).toContain('tools.0.output')
    expect(report.sources).toEqual([])
  })
})
