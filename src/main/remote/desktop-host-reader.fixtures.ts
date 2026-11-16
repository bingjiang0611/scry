import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActiveRun } from '../../shared/trace'
import type { ScRead } from '../../shared/source-control'
import type { WorkspaceChoices, WorkspaceChoicesRequest } from '../../shared/workspace-selection'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { createDesktopHostReader } from './desktop-host-reader'
import { bindRemoteHistoryContext } from './history-context'

// Shared by the evidence suites that read through the same injected reader.
// Callers own cleanup through the returned root list.
export function desktopReaderFixture(options: {
  workspaceChoices?: (request: WorkspaceChoicesRequest) => Promise<ScRead<WorkspaceChoices>>
  validateWorkspaceBranch?: (request: { cwd: string; repositoryId: string; name: string }) => Promise<ScRead<{ name: string }>>
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scry-desktop-reader-'))
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const userDataDir = join(root, 'userData')
  let allowed = true
  let run: ActiveRun | null = null
  // A run that just left the live registry (RunRegistry.departedState), and how each read asked.
  let departed: ActiveRun | null = null
  const runReads: Array<{ departed: boolean } | undefined> = []
  const read = createDesktopHostReader({
    userDataDir, hostId: () => 'host-fixture',
    authorizeWorkspace: (path) => { if (!allowed || path !== cwd) throw new Error('workspace_not_authorized'); return cwd },
    authorizeSession: (value) => { bindRemoteHistoryContext({ ...value, externalSessionId: value.externalSessionId!, historyScope: 'session' },
      [{ sessionId: context.externalSessionId, cwd, providerId: 'codex' }], path => path) },
    getRun: (_runId, options) => { runReads.push(options); return run ?? (options?.departed ? departed : null) },
    ...options
  })
  const context = { cwd, providerId: 'codex', externalSessionId: 'native-session' }
  return { read, context, userDataDir, root, setRun: (value: ActiveRun) => { run = value },
    setDeparted: (value: ActiveRun) => { departed = value }, runReads, revoke: () => { allowed = false },
    // Archived turns sort by turn ts, then by the hashed turn file name. Without an
    // explicit ts, turns written in the same millisecond fall back to hash order, so
    // give each one the same deterministic time as its item.
    archive: (index: number, text = `answer ${index}`) => upsertTraceArchiveTurn({
      cwd, userDataDir, sessionId: context.externalSessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turn: { runId: `run-${index}`, agentProfileId: null, userText: `prompt ${index}`, done: true, ts: Date.UTC(2026, 9, 14, 0, 0, index), items: [{
        id: `event-${index}`, runId: `run-${index}`, ts: `2026-10-14T00:00:0${index}Z`, kind: 'model', stage: 'text', text
      }] }
    }) }
}

export function removeFixtureRoots(roots: string[]): void {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
}
