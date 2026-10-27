import { describe, expect, it, vi } from 'vitest'

const pageReads = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../transcript-archive', async importOriginal => {
  const actual = await importOriginal<typeof import('../transcript-archive')>()
  return {
    ...actual,
    readTraceArchivePageAsync: async (_args: unknown, request: Record<string, unknown>) => {
      pageReads.push(request)
      return { archive: null, offset: 0, totalTurns: 0, hasOlder: false, turnFilesRead: 0, readMode: 'indexed', sourceComplete: true }
    },
    readTraceArchiveAsync: async () => null
  }
})

const { DEFAULT_LOAD_SESSION_TURNS, readSessionArchive } = await import('./history-archive')

const base = {
  userDataDir: '/tmp/does-not-matter',
  cwd: '/tmp/workspace',
  sessionId: 'session-1',
  providerId: 'pi' as const,
  transcriptPath: null,
  runs: [],
  signal: new AbortController().signal
}

describe('session archive read for a load', () => {
  it('reads only the first page when the caller does not ask for a size', async () => {
    pageReads.length = 0
    await readSessionArchive(base)
    expect(pageReads).toHaveLength(1)
    expect(pageReads[0]).toMatchObject({ limit: DEFAULT_LOAD_SESSION_TURNS })
    expect(DEFAULT_LOAD_SESSION_TURNS).toBe(10)
  })

  it('honours an explicit page size and keeps profile scoping out of Pi archives', async () => {
    pageReads.length = 0
    await readSessionArchive({ ...base, providerId: 'codex', agentProfileId: 'profile-a', request: { limit: 25 } })
    expect(pageReads[0]).toMatchObject({ limit: 25, agentProfileId: 'profile-a' })
    pageReads.length = 0
    await readSessionArchive({ ...base, agentProfileId: 'profile-a' })
    expect(pageReads[0]).not.toHaveProperty('agentProfileId')
  })
})
