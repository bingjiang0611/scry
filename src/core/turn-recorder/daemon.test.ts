import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenRecorderDaemon, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon'
import { listRecords } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
  return join('/private/tmp', `${basename(root)}.sock`)
}

describe('turn recorder daemon', () => {
  it('通过 workspace socket 复用 recorder core 并提交完整轮次', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      const base = { workspace: root, provider: 'claude' as const, env }
      await sendRecorderDaemonHook({ ...base, event: 'UserPromptSubmit', payload: { session_id: 's1', prompt: 'hello' } })
      await sendRecorderDaemonHook({ ...base, event: 'PreToolUse', payload: { session_id: 's1', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a.txt' } } })
      await sendRecorderDaemonHook({ ...base, event: 'PostToolUse', payload: { session_id: 's1', tool_name: 'Read', tool_use_id: 't1', tool_response: 'ok' } })
      await sendRecorderDaemonHook({ ...base, event: 'Stop', payload: { session_id: 's1', assistant_response: 'done' } })

      const [record] = await listRecords(join(root, '.scry'))
      expect(record).toMatchObject({ sessionId: 's1', provider: { id: 'claude' }, status: 'completed' })
      expect(record.tools.value).toEqual([expect.objectContaining({ id: 't1', status: 'success' })])
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true, protocol: '1', requestCount: 5, errorCount: 0 })
    } finally {
      await daemon.close()
    }
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
  })

  it('闲置后自动退出，下次事件可由 launcher 再拉起', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 50, env })
    await daemon.closed
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
  })

  it('无 open turn 时不运行 recovery poll', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    let recoveryRuns = 0
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 5_000,
      env,
      recoveryProbe: () => { recoveryRuns++ }
    })
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200))
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

  it('未观测到终态时退避 recovery poll，rollout 变为终态后仍会提交', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const rollout = join(root, '.codex', 'sessions', '2026', '07', '19', 'delayed-abort.jsonl')
    await mkdir(join(rollout, '..'), { recursive: true })
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'delayed-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'wait for abort' } }
    ].map((line) => JSON.stringify(line)).join('\n'))
    let recoveryRuns = 0
    const daemon = await listenRecorderDaemon({
      workspace: root,
      idleMs: 5_000,
      env,
      recoveryProbe: () => { recoveryRuns++ }
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

      await expect.poll(() => recoveryRuns, { timeout: 2_000 }).toBe(1)
      await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200))
      expect(recoveryRuns).toBe(1)

      await appendFile(rollout, `\n${JSON.stringify({
        timestamp: '2026-07-19T12:00:02.500Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'delayed-turn', reason: 'interrupted' }
      })}\n`)
      await expect.poll(async () => (await listRecords(join(root, '.scry'))).length, { timeout: 2_500 }).toBe(1)
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

      await expect.poll(async () => JSON.parse((await readFile(capture, 'utf8')).trim()), { timeout: 4_000 })
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
