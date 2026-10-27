import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActiveRun } from '../../shared/trace'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { createDesktopHostReader } from './desktop-host-reader'
import { bindRemoteHistoryContext } from './history-context'

// Shared by the evidence suites that read through the same injected reader.
// Callers own cleanup through the returned root list.
export function desktopReaderFixture() {
  const root = mkdtempSync(join(tmpdir(), 'scry-desktop-reader-'))
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const userDataDir = join(root, 'userData')
  let allowed = true
  let run: ActiveRun | null = null
  const read = createDesktopHostReader({
    userDataDir, hostId: () => 'host-fixture',
    authorizeWorkspace: (path) => { if (!allowed || path !== cwd) throw new Error('workspace_not_authorized'); return cwd },
    authorizeSession: (value) => { bindRemoteHistoryContext({ ...value, externalSessionId: value.externalSessionId!, historyScope: 'session' },
      [{ sessionId: context.externalSessionId, cwd, providerId: 'codex' }], path => path) },
    getRun: () => run
  })
  const context = { cwd, providerId: 'codex', externalSessionId: 'native-session' }
  return { read, context, userDataDir, root, setRun: (value: ActiveRun) => { run = value }, revoke: () => { allowed = false },
    archive: (index: number, text = `answer ${index}`) => upsertTraceArchiveTurn({
      cwd, userDataDir, sessionId: context.externalSessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turn: { runId: `run-${index}`, agentProfileId: null, userText: `prompt ${index}`, done: true, items: [{
        id: `event-${index}`, runId: `run-${index}`, ts: `2026-10-14T00:00:0${index}Z`, kind: 'model', stage: 'text', text
      }] }
    }) }
}

export function removeFixtureRoots(roots: string[]): void {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
}
