import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync)
  }
})

import { createAppSessionStore, createProjectStore, createRecentFoldersStore } from './app-store'

// Fixed local send/identity/terminal catalog workload, not a real Provider run.
// Keep both clocks: a same-millisecond notification can be an exact no-op;
// distinct activity timestamps must still be persisted.
it.each(['same-ms', 'advancing-ms'] as const)('counts one controlled catalog turn (%s)', (clock) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'scry-a2-counts-'))
  let now = 1000
  const time = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const recent = createRecentFoldersStore(dir)
    const projects = createProjectStore(dir)
    const sessions = createAppSessionStore(dir)
    const request = { providerId: 'claude' as const, runtimeProvider: 'claude_sdk' as const,
      runId: 'controlled-run', cwd: '/fixture/project', prompt: 'fixture' }
    const tick = (): void => { if (clock === 'advancing-ms') now++ }
    vi.mocked(fs.readFileSync).mockClear()
    vi.mocked(fs.writeFileSync).mockClear()
    vi.mocked(fs.fsyncSync).mockClear()
    recent.push(request.cwd)
    projects.remember(request.cwd)
    sessions.recordPending(request)
    tick()
    sessions.recordPending(request)
    tick()
    sessions.record({ ...request, externalSessionId: 'native-fixture' })
    tick()
    sessions.record({ ...request, externalSessionId: 'native-fixture' })
    tick()
    sessions.record({ ...request, externalSessionId: 'native-fixture', lastRunOutcome: 'completed' })
    tick()
    sessions.record({ ...request, externalSessionId: 'native-fixture', lastRunOutcome: 'completed' })
    for (let index = 0; index < 3; index++) {
      recent.load()
      projects.load()
      sessions.listProjects()
    }
    const counts = { reads: vi.mocked(fs.readFileSync).mock.calls.length,
      writes: vi.mocked(fs.writeFileSync).mock.calls.length,
      fsyncs: vi.mocked(fs.fsyncSync).mock.calls.length }
    console.log('A2 catalog workload', JSON.stringify({ clock, ...counts }))
    expect(sessions.listSessions(request.cwd)[0]).toMatchObject({
      runId: request.runId, externalSessionId: 'native-fixture', lastRunOutcome: 'completed', mtime: now
    })
    expect(projects.load()[0].cwd).toBe(request.cwd)
    expect(recent.load()).toEqual([request.cwd])
  } finally {
    time.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
