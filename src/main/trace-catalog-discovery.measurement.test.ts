import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'

// B2 L1 collector: work done by trace-archive catalog discovery when the catalog index is dirty.
// At baseline `agent:listProjects` awaits this whole discovery before it returns the first project
// list. Counting happens at the fs boundary so baseline and candidate use the same collector.
const probe = vi.hoisted(() => ({
  active: false,
  root: '',
  indexPath: '',
  turnReads: 0,
  turnBytes: 0,
  indexWrites: { sync: 0, async: 0 }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const renameSync = ((...args: Parameters<typeof actual.renameSync>) => {
    if (probe.active && String(args[1]) === probe.indexPath) probe.indexWrites.sync++
    return actual.renameSync(...args)
  }) as typeof actual.renameSync
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args)
    if (probe.active && String(args[0]).startsWith(probe.root)) {
      probe.turnReads++
      probe.turnBytes += typeof value === 'string' ? Buffer.byteLength(value) : (value as Buffer).length
    }
    return value
  }) as typeof actual.readFile
  const rename = (async (...args: Parameters<typeof actual.rename>) => {
    if (probe.active && String(args[1]) === probe.indexPath) probe.indexWrites.async++
    return actual.rename(...args)
  }) as typeof actual.rename
  return { ...actual, readFile, rename, default: { ...actual, readFile, rename } }
})

const archive = await import('./transcript-archive')

const PROVIDERS: Array<[ProviderId, RuntimeProvider]> = [
  ['claude', 'claude_sdk'], ['codex', 'codex_cli'], ['qoder', 'qoder_cli'], ['opencode', 'opencode_server'], ['pi', 'pi_rpc']
]
const SESSIONS_PER_PROVIDER = 10
const TURNS_PER_SESSION = 4

const roots: string[] = []
afterEach(() => {
  probe.active = false
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b2-user-data-'))
  roots.push(userDataDir)
  for (const [providerId, runtimeProvider] of PROVIDERS) {
    for (let session = 0; session < SESSIONS_PER_PROVIDER; session++) {
      for (let turn = 0; turn < TURNS_PER_SESSION; turn++) {
        const ok = archive.upsertTraceArchiveTurn({
          cwd: `/repo-${session % 3}`,
          sessionId: `${providerId}-session-${session}`,
          providerId,
          runtimeProvider,
          userDataDir,
          turn: { runId: `${providerId}-${session}-${turn}`, userText: `prompt ${turn} ${'x'.repeat(200)}`, items: [], done: true, status: 'completed', ts: turn + 1 }
        })
        if (!ok) throw new Error('fixture archive write failed')
      }
    }
  }
  probe.root = join(userDataDir, 'trace-archive-turns-v1')
  probe.indexPath = join(userDataDir, 'trace-archive-index-v1.json')
  return userDataDir
}

async function collect(scenario: string, providers?: ProviderId[]) {
  const userDataDir = fixture()
  const parse = vi.spyOn(JSON, 'parse')
  probe.turnReads = 0
  probe.turnBytes = 0
  probe.indexWrites = { sync: 0, async: 0 }
  probe.active = true
  const summaries = await archive.discoverTraceArchiveSessionsAsync(userDataDir, providers)
  probe.active = false
  const result = {
    scenario,
    files: PROVIDERS.length * SESSIONS_PER_PROVIDER * TURNS_PER_SESSION,
    qoderFiles: SESSIONS_PER_PROVIDER * TURNS_PER_SESSION,
    turnFileReads: probe.turnReads,
    turnBytesRead: probe.turnBytes,
    jsonParseCalls: parse.mock.calls.length,
    indexPublishes: probe.indexWrites,
    summaries: summaries.length,
    qoderSummaries: summaries.filter((summary) => summary.providerId === 'qoder').length
  }
  console.log('B2 discovery', JSON.stringify(result))
  return result
}

describe('B2 catalog discovery work with a dirty index (L1 collector)', () => {
  it('counts an all-Provider discovery (the baseline startup call)', async () => {
    expect((await collect('all-providers')).qoderSummaries).toBe(SESSIONS_PER_PROVIDER)
  })

  it('counts the Qoder-scoped discovery used by background startup recovery', async () => {
    expect((await collect('qoder-scoped', ['qoder'])).qoderSummaries).toBe(SESSIONS_PER_PROVIDER)
  })
})
