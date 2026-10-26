import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenRecorderDaemon, recorderDaemonStatus, recorderSocketPath, sendRecorderDaemonHook } from './daemon.js'
import { listRecords } from './store.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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

describe('turn recorder daemon transport', () => {
  it('深路径 workspace 自动使用短 socket 路径', () => {
    const workspace = join(tmpdir(), 'nested', 'x'.repeat(120))
    const path = recorderSocketPath(workspace, { ...process.env, SCRY_RECORDER_SOCKET: '' })
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100)
    expect(recorderSocketPath(workspace, { SCRY_RECORDER_SOCKET: '' })).toBe(path)
    expect(recorderSocketPath(`${workspace}-other`, {})).not.toBe(path)
  })

  it('显式长路径和超长 TMPDIR 仍返回稳定、不同且有界的 endpoint', () => {
    vi.stubEnv('TMPDIR', `/tmp/${'深'.repeat(80)}`)
    const workspace = `/tmp/${'workspace'.repeat(20)}`
    const env = { SCRY_RECORDER_SOCKET: `${workspace}/custom.sock` }
    const path = recorderSocketPath(workspace, env)
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100)
    expect(path.startsWith('/tmp/scry-')).toBe(true)
    expect(recorderSocketPath(workspace, env)).toBe(path)
    expect(recorderSocketPath(workspace, { SCRY_RECORDER_SOCKET: `${workspace}/other.sock` })).not.toBe(path)
    expect(recorderSocketPath(workspace, { SCRY_RECORDER_SOCKET: '/tmp/short.sock' })).toBe('/tmp/short.sock')
  })

  it('显式超长 socket 可真实监听并连接', async () => {
    const root = await workspace()
    const requested = join(root, 'x'.repeat(120), 'recorder.sock')
    const env = { SCRY_RECORDER_SOCKET: requested }
    const daemon = await listenRecorderDaemon({ workspace: root, socketPath: requested, env })
    try {
      expect(Buffer.byteLength(daemon.socketPath)).toBeLessThanOrEqual(100)
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true })
    } finally {
      await daemon.close()
    }
  })

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
      await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: true, protocol: '2', requestCount: 5, errorCount: 0 })
    } finally {
      await daemon.close()
    }
    await expect(recorderDaemonStatus(root, env)).resolves.toMatchObject({ running: false })
  })

})
