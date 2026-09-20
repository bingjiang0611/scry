import { afterAll, beforeAll, bench, describe } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTraceArchiveAsync, readTraceArchivePageAsync, upsertTraceArchiveTurn } from './transcript-archive'

const TURN_COUNT = Number(process.env.BENCH_ARCHIVE_TURNS ?? 500)
let userDataDir = ''
const args = { cwd: '/benchmark', sessionId: 'archive-benchmark', providerId: 'codex' as const }

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'scry-archive-bench-'))
  for (let index = 0; index < TURN_COUNT; index++) {
    const ok = upsertTraceArchiveTurn({
      ...args,
      userDataDir,
      turn: {
        runId: `run-${index}`,
        userText: `request ${index}`,
        items: [{ id: `event-${index}`, ts: new Date(index * 1_000).toISOString(), runId: `run-${index}`, kind: 'model', stage: 'text', text: 'x'.repeat(256) }],
        done: true,
        ts: index
      }
    })
    if (!ok) throw new Error(`failed to create benchmark turn ${index}`)
  }
})

afterAll(() => rmSync(userDataDir, { recursive: true, force: true }))

describe(`segmented archive (${TURN_COUNT} turns, 40 visible)`, () => {
  bench('read and parse every turn file', async () => {
    await readTraceArchiveAsync({ ...args, userDataDir })
  })

  bench('read indexed visible page', async () => {
    await readTraceArchivePageAsync({ ...args, userDataDir }, { limit: 40 })
  })

  bench('commit one turn, preserve the page index, then read 40', async () => {
    const index = TURN_COUNT - 1
    const ok = upsertTraceArchiveTurn({
      ...args,
      userDataDir,
      turn: {
        runId: `run-${index}`,
        userText: `request ${index}`,
        items: [{
          id: `event-${index}`,
          ts: new Date(index * 1_000).toISOString(),
          runId: `run-${index}`,
          kind: 'model',
          stage: 'text',
          text: 'x'.repeat(256)
        }],
        done: true,
        ts: index
      }
    })
    if (!ok) throw new Error('failed to invalidate archive benchmark index')
    await readTraceArchivePageAsync({ ...args, userDataDir }, { limit: 40 })
  })
})
