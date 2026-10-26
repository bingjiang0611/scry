import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenRecorderDaemon, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon'
import { RECORDER_VERSION, listRecords } from './store'

const roots: string[] = []
const socketDirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...socketDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  ])
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-daemon-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'daemon-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

function socketPath(root: string): string {
  return join(tmpdir(), `${basename(root)}.sock`)
}

function manualRecoveryTimeouts(): {
  schedule: (run: () => Promise<void>, delayMs: number) => () => void
  fireNext: () => Promise<number>
} {
  const tasks: Array<{ active: boolean; delayMs: number; run: () => Promise<void> }> = []
  return {
    schedule: (run, delayMs) => {
      const task = { active: true, delayMs, run }
      tasks.push(task)
      return () => { task.active = false }
    },
    fireNext: async () => {
      const task = tasks.find((candidate) => candidate.active)
      if (!task) throw new Error('no active recovery timeout')
      task.active = false
      await task.run()
      return task.delayMs
    }
  }
}

/** 独立目录，让 daemon.log 断言只看到本条测试写下的内容。 */
async function isolatedSocketDir(root: string): Promise<string> {
  const dir = join(tmpdir(), `${basename(root)}-d`)
  await rm(dir, { recursive: true, force: true })
  socketDirs.push(dir)
  return dir
}

describe('turn recorder daemon', () => {
  it('socket 接受 direct Pi lifecycle', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      const base = { workspace: root, provider: 'pi' as const, env }
      await sendRecorderDaemonHook({ ...base, event: 'UserPromptSubmit', payload: { session_id: 'pi-session', promptId: 'pi-turn', prompt: 'hello' } })
      await sendRecorderDaemonHook({ ...base, event: 'Stop', payload: { session_id: 'pi-session', promptId: 'pi-turn', assistant_response: 'done' } })
      await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
        { sessionId: 'pi-session', provider: { id: 'pi' }, providerTurnId: 'pi-turn', status: 'completed' }
      ])
    } finally {
      await daemon.close()
    }
  })

  it('闲置后自动退出，下次事件可由 launcher 再拉起', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 50, env })
    await daemon.closed
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
  })

  it.each(['sync', 'async'] as const)('logs %s background recovery failures without stopping the daemon', async (failure) => {
    const root = await workspace()
    const dir = await isolatedSocketDir(root)
    const env = { SCRY_RECORDER_SOCKET: join(dir, 'recorder.sock') }
    const timeouts = manualRecoveryTimeouts()
    const daemon = await listenRecorderDaemon({
      workspace: root, env, idleMs: 5_000,
      scheduleRecoveryTimeout: timeouts.schedule,
      recoveryProbe: () => {
        const error = new Error(`injected ${failure} recovery failure`)
        if (failure === 'sync') throw error
        return Promise.reject(error)
      }
    })
    try {
      await sendRecorderDaemonHook({ workspace: root, provider: 'pi', event: 'UserPromptSubmit', env,
        payload: { session_id: 'recovery-error', prompt: 'keep recovery eligible' } })
      await expect(timeouts.fireNext()).resolves.toBeGreaterThan(0)
      expect(await readFile(join(dir, 'logs', 'daemon.log'), 'utf8')).toContain(`injected ${failure} recovery failure`)
      expect(await recorderDaemonStatus(root, env)).toMatchObject({ running: true })
    } finally {
      await daemon.close()
    }
  })

  it('无 open turn 时不运行 recovery poll', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    let recoveryRuns = 0
    const recoveryTimeouts = manualRecoveryTimeouts()
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 5_000,
      env,
      recoveryPollMs: 20,
      maxRecoveryPollMs: 80,
      recoveryProbe: () => { recoveryRuns++ },
      scheduleRecoveryTimeout: recoveryTimeouts.schedule
    })
    try {
      await expect(recoveryTimeouts.fireNext()).resolves.toBe(20)
      expect(recoveryRuns).toBe(0)
    } finally {
      await daemon.close()
    }
  })

  it('存在未终态 open turn 时跨过 idle timeout 仍保持运行', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 50, env })
    try {
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'claude',
        event: 'UserPromptSubmit',
        payload: { session_id: 'long-running', prompt: 'still working' },
        env
      })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true })
    } finally {
      await daemon.close()
    }
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
  })

  it('空闲退出前触发更新，装完即退出，让下一个事件跑上新版本', async () => {
    const root = await workspace()
    // daemon.log 跟随 socket 所在目录（daemon.ts 的 daemonLog），所以这里用独立目录避免串台。
    const dir = await isolatedSocketDir(root)
    const env = { ...process.env, SCRY_RECORDER_SOCKET: join(dir, 'x.sock') }
    const calls: string[] = []
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 50,
      env,
      idleUpdate: async () => { calls.push('update'); return '9.9.9' }
    })
    await daemon.closed
    expect(calls).toEqual(['update'])
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
    const log = await readFile(join(dir, 'logs', 'daemon.log'), 'utf8')
    expect(log).toContain(`idle update installed ${RECORDER_VERSION} -> 9.9.9`)
  })

  it('轮次未结束时不触发更新，避免同一轮跨两个版本', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    let attempts = 0
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 50,
      env,
      idleUpdate: async () => { attempts++; return '9.9.9' }
    })
    try {
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'claude',
        event: 'UserPromptSubmit',
        payload: { session_id: 'mid-turn', prompt: '一轮开始了' },
        env
      })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
      expect(attempts).toBe(0)
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true })
    } finally {
      await daemon.close()
    }
  })

  it('更新失败不影响 daemon 退出，也不声称装上了东西', async () => {
    const root = await workspace()
    const dir = await isolatedSocketDir(root)
    const env = { ...process.env, SCRY_RECORDER_SOCKET: join(dir, 'x.sock') }
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 50,
      env,
      idleUpdate: async () => { throw new Error('registry unreachable') }
    })
    await daemon.closed
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
    const log = await readFile(join(dir, 'logs', 'daemon.log'), 'utf8').catch(() => '')
    expect(log).not.toContain('idle update installed')
  })

  it('idle close 检查期间到达新 start 时不会关闭已写入 open 的 daemon', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    let releaseProbe = (): void => {}
    let enterProbe = (): void => {}
    const probeEntered = new Promise<void>((resolvePromise) => { enterProbe = resolvePromise })
    const probeRelease = new Promise<void>((resolvePromise) => { releaseProbe = resolvePromise })
    let probed = false
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 50,
      env,
      idleCloseProbe: async () => {
        if (probed) return
        probed = true
        enterProbe()
        await probeRelease
      }
    })
    try {
      await probeEntered
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'claude',
        event: 'UserPromptSubmit',
        payload: { session_id: 'idle-race', prompt: 'arrived during idle close' },
        env
      })
      releaseProbe()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true })
    } finally {
      releaseProbe()
      await daemon.close()
    }
  })

  it('无终态 hook 时轮询 Codex rollout 并提交 turn_aborted', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const rollout = join(root, '.codex', 'sessions', '2026', '07', '19', 'aborted.jsonl')
    await mkdir(join(rollout, '..'), { recursive: true })
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'aborted-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'stop me' } }
    ].map((line) => JSON.stringify(line)).join('\n'))
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'codex',
        event: 'turn.started',
        payload: {
          session_id: 'codex-session',
          turn_id: 'aborted-turn',
          prompt: 'stop me',
          rollout_path: rollout,
          timestamp: '2026-07-19T12:00:00.000Z'
        },
        env
      })
      await appendFile(rollout, `\n${JSON.stringify({
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'aborted-turn', reason: 'interrupted' }
      })}\n`)

      await expect.poll(async () => (await listRecords(join(root, '.scry'))).length, { timeout: 4_000 }).toBe(1)
      await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
        { providerTurnId: 'aborted-turn', status: 'interrupted' }
      ])
    } finally {
      await daemon.close()
    }
  })

  it('未观测到终态时继续 recovery poll，rollout 变为终态后提交', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const rollout = join(root, '.codex', 'sessions', '2026', '07', '19', 'delayed-abort.jsonl')
    await mkdir(join(rollout, '..'), { recursive: true })
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'delayed-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'wait for abort' } }
    ].map((line) => JSON.stringify(line)).join('\n'))
    let recoveryRuns = 0
    const recoveryTimeouts = manualRecoveryTimeouts()
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 5_000,
      env,
      recoveryPollMs: 50,
      maxRecoveryPollMs: 100,
      recoveryProbe: () => { recoveryRuns++ },
      scheduleRecoveryTimeout: recoveryTimeouts.schedule
    })
    try {
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'codex',
        event: 'turn.started',
        payload: {
          session_id: 'delayed-session',
          turn_id: 'delayed-turn',
          prompt: 'wait for abort',
          rollout_path: rollout,
          timestamp: '2026-07-19T12:00:00.000Z'
        },
        env
      })

      await expect(recoveryTimeouts.fireNext()).resolves.toBe(50)
      expect(recoveryRuns).toBe(1)
      await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])

      await appendFile(rollout, `\n${JSON.stringify({
        timestamp: '2026-07-19T12:00:02.500Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'delayed-turn', reason: 'interrupted' }
      })}\n`)
      await expect(recoveryTimeouts.fireNext()).resolves.toBe(100)
      await expect(listRecords(join(root, '.scry'))).resolves.toHaveLength(1)
      expect(recoveryRuns).toBe(2)
      await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
        { providerTurnId: 'delayed-turn', status: 'interrupted' }
      ])
    } finally {
      await daemon.close()
    }
  })

  it('daemon recovery 提交 Codex turn_aborted 后触发 commit callback', async () => {
    const root = await workspace()
    const hook = join(root, 'commit-hook.sh')
    const capture = join(root, 'commit-hook.jsonl')
    await writeFile(hook, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
    await chmod(hook, 0o700)
    const env = {
      ...process.env,
      SCRY_RECORDER_SOCKET: socketPath(root),
      SCRY_RECORDER_COMMIT_HOOK: hook
    }
    const rollout = join(root, '.codex', 'sessions', '2026', '07', '19', 'callback-aborted.jsonl')
    await mkdir(join(rollout, '..'), { recursive: true })
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'callback-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'interrupt me' } }
    ].map((line) => JSON.stringify(line)).join('\n'))
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      await sendRecorderDaemonHook({
        workspace: root,
        provider: 'codex',
        event: 'turn.started',
        payload: {
          session_id: 'callback-session',
          turn_id: 'callback-turn',
          prompt: 'interrupt me',
          rollout_path: rollout,
          timestamp: '2026-07-19T12:00:00.000Z'
        },
        env
      })
      await appendFile(rollout, `\n${JSON.stringify({
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'callback-turn', reason: 'interrupted' }
      })}\n`)

      // 全量/CLI release 门禁并行构建时 recovery + callback 可能超过 4 秒；等待可观测提交文件，不用固定 sleep。
      await expect.poll(async () => JSON.parse((await readFile(capture, 'utf8')).trim()), { timeout: 10_000 })
        .toMatchObject({ event: 'record-committed', provider: 'codex', sessionId: 'callback-session', sequence: 1 })
    } finally {
      await daemon.close()
    }
  })

  it('不会用第二个 serve 覆盖仍在运行的 socket', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      await expect(listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })).rejects.toThrow('owned by live process')
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true })
    } finally {
      await daemon.close()
    }
  })

  it('daemon 整个生命周期保留所有权标记，关闭后只清理自己的标记', async () => {
    const root = await workspace()
    const socket = socketPath(root)
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socket }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    const markerPath = `${socket}.owner.json`
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      state: 'running',
      socketPath: socket
    })
    await daemon.close()
    await expect(access(markerPath)).rejects.toThrow()
  })

  it('Socket 仍在但无响应时拒绝 unlink，避免把活进程变成孤儿', async () => {
    const root = await workspace()
    const socket = socketPath(root)
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socket }
    const connections = new Set<Socket>()
    const blocker = createNetServer((connection) => {
      connections.add(connection)
      connection.once('close', () => connections.delete(connection))
    })
    await new Promise<void>((resolvePromise, reject) => {
      blocker.once('error', reject)
      blocker.listen(socket, resolvePromise)
    })
    try {
      await expect(listenRecorderDaemon({ workspace: root, idleMs: 5_000, env }))
        .rejects.toThrow('ownership cannot be proven stale')
      await expect(access(socket)).resolves.toBeUndefined()
    } finally {
      for (const connection of connections) connection.destroy()
      await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()))
      await rm(socket, { force: true })
      await rm(`${socket}.owner.json`, { force: true })
    }
  })

  it('拒绝超过 8 MiB 的请求并返回失败而不是假 ACK', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      await expect(sendRecorderDaemonHook({
        workspace: root,
        provider: 'claude',
        event: 'UserPromptSubmit',
        payload: { session_id: 'large', prompt: 'x'.repeat(8 * 1024 * 1024) },
        env
      })).rejects.toThrow('413')
    } finally {
      await daemon.close()
    }
  })
})
