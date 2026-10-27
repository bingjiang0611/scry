import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRunDiagnostics, type PiRunDiagnosticPhase } from './pi-run-diagnostics'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scry-pi-diagnostics-'))
  directories.push(directory)
  const path = join(directory, 'diagnostics.json')
  return { directory, path, diagnostics: new PiRunDiagnostics(path) }
}

describe('Pi stage-only diagnostics', () => {
  it('persists private, bounded snapshots without confusing native idle with completion', async () => {
    const { path, diagnostics } = await fixture()
    diagnostics.record('run-1', 'prompt_response', { rpcPid: 123, agentStarted: true })
    diagnostics.record('run-1', 'agent_settlement', {
      agentEnded: true, agentSettled: false, nativeIdle: true, backgroundPending: true
    })
    await diagnostics.flush()
    const data = JSON.parse(await readFile(path, 'utf8'))
    expect(data).toMatchObject({ schemaVersion: 1, appPid: process.pid, coverage: 'partial', maxRuns: 64, maxPhaseChanges: 16 })
    expect(data.runs).toEqual([expect.objectContaining({
      runId: 'run-1', phase: 'agent_settlement', rpcPid: 123,
      agentStarted: true, agentEnded: true, agentSettled: false, nativeIdle: true, backgroundPending: true,
      history: [expect.objectContaining({ phase: 'prompt_response' }), expect.objectContaining({ phase: 'agent_settlement' })]
    })])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('coalesces updates, retaining at most 64 recently updated runs and 16 phase changes', async () => {
    const { path, diagnostics } = await fixture()
    for (let index = 0; index < 80; index++) diagnostics.record(`run-${index}`, 'profile_lookup')
    for (let index = 0; index < 40; index++) {
      const phase: PiRunDiagnosticPhase = index % 2 ? 'prompt_response' : 'initial_state'
      diagnostics.record('run-79', phase)
    }
    await diagnostics.flush()
    const data = JSON.parse(await readFile(path, 'utf8'))
    expect(data.runs).toHaveLength(64)
    expect(data.runs[0].runId).toBe('run-16')
    expect(data.runs.at(-1)).toMatchObject({ runId: 'run-79', phase: 'prompt_response' })
    expect(data.runs.at(-1).history).toHaveLength(16)
  })

  it('reports unavailable storage without throwing into Provider execution or retrying the failed write', async () => {
    const { directory } = await fixture()
    const parent = join(directory, 'not-a-directory')
    await writeFile(parent, '')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const diagnostics = new PiRunDiagnostics(join(parent, 'diagnostics.json'))
    expect(() => diagnostics.record('run-1', 'initial_state')).not.toThrow()
    await diagnostics.flush()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0][0]).toContain('diagnostics unavailable')
  })
})
