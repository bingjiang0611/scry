import 'reflect-metadata'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon, type TestDaemon } from './host-process.harness'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'
import { writeRecorderContentCopies } from '../core/turn-recorder/content-store'
import { appTraceContentRoot } from '../main/trace-tool-content'

afterEach(cleanupTempDirs)

// Recorder content and the Provider command catalog through a real daemon's App endpoint
// (B4-L4). Recorder content is read for the workspace the App appends (its window's
// selection); the daemon re-validates it against its own project authority, so a
// directory it does not know is refused as main refuses a read without a workspace.

async function withDaemon(test: (daemon: TestDaemon) => Promise<void>): Promise<void> {
  const daemon = await startTestDaemon()
  try { await test(daemon) } finally { await daemon.dispose() }
}

async function record(workspace: string): Promise<{ sha256: string; bytes: number; encoding: string }> {
  writeFileSync(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'daemon-content', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }))
  const payload = (extra: Record<string, unknown>) => ({ session_id: 'session', timestamp: '2026-01-01T00:00:00.000Z', ...extra })
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace, payload: payload({ prompt: 'p' }) })
  await handleRecorderHook({ provider: 'claude', event: 'PreToolUse', workspace, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'echo' } }) })
  await handleRecorderHook({ provider: 'claude', event: 'PostToolUse', workspace, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_response: 'recorded body' }) })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace, payload: payload({ assistant_response: 'done' }) })
  const [first] = await listRecords(join(workspace, '.scry'))
  return first.tools.value![0].outputContent!.contentRef!
}

const text = (page: { dataBase64: string }): string => Buffer.from(page.dataBase64, 'base64').toString('utf8')

describe('daemon recorder content and command local ops', () => {
  it('serves recorder content for its known workspace and refuses any other', async () => {
    await withDaemon(async (daemon) => {
      const ref = await record(daemon.workspace)
      const served = await daemon.localOp('recorderContent', 'recorderContentPage', [{ ref }, daemon.workspace])
      expect(text(served.result)).toBe('recorded body')
      expect(served.result).toMatchObject({ offset: 0, totalBytes: ref.bytes, hasMore: false })

      // The same recorded workspace, unknown to the daemon's project authority.
      mkdirSync(join(daemon.root, 'outside'))
      const outside = realpathSync(join(daemon.root, 'outside'))
      await record(outside)
      for (const cwd of [outside, join(daemon.workspace, '..', 'outside'), 'relative', 42]) {
        expect(await daemon.localOp('recorderContent', 'recorderContentPage', [{ ref }, cwd])).toEqual({ error: 'recorder_workspace_unavailable' })
      }
      // An App that sends no workspace gets main's refusal for a read without one.
      expect(await daemon.localOp('recorderContent', 'recorderContentPage', [{ ref }])).toEqual({ error: 'recorder_workspace_unavailable' })
      expect(await daemon.localOp('recorderContent', 'recorderContentPage', [{ ref }, ''])).toEqual({ error: 'recorder_workspace_unavailable' })
    })
  }, 30_000)

  it('reads app trace bodies from the daemon userData for the validated workspace', async () => {
    await withDaemon(async (daemon) => {
      const ref = await writeRecorderContentCopies([appTraceContentRoot(daemon.userDataDir, daemon.workspace)], 'trace body', 'utf8')
      const served = await daemon.localOp('recorderContent', 'recorderContentPage', [{ source: 'app-trace', ref }, daemon.workspace])
      expect(text(served.result)).toBe('trace body')
      const outside = join(daemon.root, 'elsewhere')
      mkdirSync(outside)
      expect(await daemon.localOp('recorderContent', 'recorderContentPage', [{ source: 'app-trace', ref }, realpathSync(outside)]))
        .toEqual({ error: 'recorder_workspace_unavailable' })
    })
  }, 30_000)

  it('answers the command catalog as the Provider reports it, never an empty list for unavailable', async () => {
    await withDaemon(async (daemon) => {
      const listed = await daemon.localOp('providerCommands', 'listCommands', [{ providerId: 'codex', cwd: daemon.workspace }])
      // The fixture Provider has no command facet: main's envelope whole, not the device
      // op's `{ commands: [] }` and never a bare empty list.
      expect(listed).toEqual({ result: {
        providerId: 'codex', cwd: daemon.workspace, mode: 'none', state: 'unsupported', data: null, reason: '该 Provider 没有可嵌入的命令目录'
      } })
      // A Provider the daemon does not run is an error, not an empty catalog.
      expect(await daemon.localOp('providerCommands', 'listCommands', [{ providerId: 'claude', cwd: daemon.workspace }])).toEqual({ error: expect.stringContaining('not registered') })
    })
  }, 30_000)
})
