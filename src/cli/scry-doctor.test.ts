import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from '../core/turn-recorder/store'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { runScryCli } from './scry'
import { initWorkspace, integrationsRepair } from './workspace-init'
import { roots, workspace, captureStdout, gitWorkspace } from './scry.test-fixture.js'


describe('scry doctor schema and exit codes', () => {
  it('健康时输出稳定 schema 并退出 0', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ schemaVersion: 1, status: 'healthy', healthy: true, enabled: true })
    expect(report.checks.map((check: any) => check.id)).toEqual([
      'recorder.enabled', 'repositories.depth', 'hook.skips', 'hook.userBridgeSkips', 'store.integrity', 'turns.pending', 'hook.script', 'turns.stale', 'recorder.version', 'recorder.lastError'
    ])
    expect(report.checks.every((check: any) => check.status === 'pass')).toBe(true)
    expect(report.recorderVersion).toBe(RECORDER_VERSION)
  })

  it('升级后遗留的旧 hook 脚本被 doctor 报 warn，repair 后回到 pass', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'claude', cliPath: process.execPath })
    const script = join(root, '.scry', 'provider-hook.sh')
    const current = await readFile(script, 'utf8')

    const fresh = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(fresh.text()).hookScript).toBe('current')

    // 模拟旧版本写下的脚本：受管标记还在，内容已经不是这个 CLI 会写的了。
    await writeFile(script, current.replace('#!/bin/sh', '#!/bin/sh\n# 旧版本残留'), { mode: 0o700 })
    // 旧脚本仍能正确采集，只是拿不到新版本的快路径：warn 但不改退出码，与 recorder.version 一致。
    const stale = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stale.text()) as Record<string, any>
    expect(report).toMatchObject({ status: 'healthy', hookScript: 'outdated' })
    expect(report.checks.find((c: any) => c.id === 'hook.script')).toMatchObject({
      status: 'warn', remediation: 'run `scry integrations repair --yes`'
    })
    const diff = captureStdout()
    await runScryCli(['integrations', 'diff', '--workspace', root])
    expect(JSON.parse(diff.text()).artifacts.find((a: any) => a.kind === 'hook-script')).toMatchObject({ status: 'outdated' })

    await integrationsRepair({ workspace: root, cliPath: process.execPath })
    const repaired = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(repaired.text()).hookScript).toBe('current')
  })

  it('自建（非受管）hook 脚本不被 doctor 判为过期', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'claude', cliPath: process.execPath })
    await writeFile(join(root, '.scry', 'provider-hook.sh'), '#!/bin/sh\n# 团队自建桥接\nexit 0\n', { mode: 0o700 })
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.hookScript).toBe('unmanaged')
    expect(report.checks.find((c: any) => c.id === 'hook.script')).toMatchObject({ status: 'pass' })
  })

  it('记录由另一份安装写入时只 warn，不改变退出码', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'ver-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'x' }
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { session_id: 'ver-1', timestamp: '2026-07-19T12:00:01.000Z' }
    })
    // 模拟另一份更老的安装写下的记录。
    const [name] = await readdir(join(root, '.scry', 'records'))
    const file = join(root, '.scry', 'records', name)
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>
    await writeFile(file, JSON.stringify({ ...record, recorderVersion: '0.1.0' }))

    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    const check = report.checks.find((c: any) => c.id === 'recorder.version')
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('0.1.0')
    expect(check.remediation).toContain('SCRY_CLI_PATH')
    expect(report.recorderVersions).toMatchObject({ lastRecord: '0.1.0' })
    expect(report.status).toBe('healthy')
  })

  it('静默 open 轮次报诊断警告，但不引导用户伪造中断', async () => {
    const root = await workspace()
    // 三天前开始、没有 transcript：终态仍未知。
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: {
        session_id: 'stale-1',
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
        prompt: '开了就没结束'
      }
    })
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(5)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ status: 'degraded', healthy: false })
    const stale = report.checks.find((check: any) => check.id === 'turns.stale')
    expect(stale.status).toBe('warn')
    expect(stale.remediation).toContain('terminal evidence')
    expect(stale.detail).toContain('termination unconfirmed')
    expect(report.staleOpenTurns).toMatchObject([{ provider: 'claude', sessionId: 'stale-1' }])
    // pendingCount 只统计 managed/closing/quarantined，孤儿轮次不在其中，所以必须单独报。
    expect(report.health.pendingCount).toBe(0)
  })

  it('缺少配置退出 3，sentinel 关闭退出 2', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-cli-doctor-'))
    roots.push(missing)
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', missing])).resolves.toBe(3)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ schemaVersion: 1, status: 'unavailable', enabled: false, reason: 'missing_config' })
    expect(report.checks[0].remediation).toContain('scry init')

    const disabled = await workspace()
    await writeFile(join(disabled, '.scry-disabled'), '')
    await expect(runScryCli(['doctor', '--workspace', disabled])).resolves.toBe(2)
  })

  it('store 损坏退出 4', async () => {
    const degraded = await workspace()
    for (const session of ['doctor-a', 'doctor-b']) {
      await handleRecorderHook({
        provider: 'claude',
        event: 'UserPromptSubmit',
        workspace: degraded,
        payload: { session_id: session, timestamp: '2026-07-19T12:00:00.000Z', prompt: 'p' }
      })
      await handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: degraded,
        payload: { session_id: session, timestamp: '2026-07-19T12:00:01.000Z' }
      })
    }
    const records = join(degraded, '.scry', 'records')
    const [name] = (await readdir(records)).sort()
    // Removing a committed record leaves a sequence gap: doctor must report corrupt, not healthy.
    await rm(join(records, name))
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', degraded])).resolves.toBe(4)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.status).toBe('corrupt')
    const integrity = report.checks.find((check: any) => check.id === 'store.integrity')
    expect(integrity.status).toBe('fail')
    expect(integrity.remediation).toContain('do not delete individual record files')
  })
})
