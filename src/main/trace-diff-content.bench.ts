import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, bench, describe } from 'vitest'
import { writeRecorderContent } from '../core/turn-recorder/content-store'
import { SESSION_DIFF_STAGE, type DiffFile } from '../shared/turn-diff'
import type { ToolContentRef } from '../shared/tool-content'
import type { TraceArchiveTurn } from './transcript-archive'
import { hydrateNewestSessionSnapshots } from './trace-diff-content'
import { APP_TRACE_CONTENT_SOURCE, appTraceContentRoot } from './trace-tool-content'

const fileCount = 384
let root = ''
let userDataDir = ''
let cwd = ''
let refs: ToolContentRef[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry-diff-hydration-bench-'))
  userDataDir = join(root, 'user-data')
  cwd = join(root, 'workspace')
  await Promise.all([mkdir(userDataDir), mkdir(cwd)])
  const contentRoot = appTraceContentRoot(userDataDir, cwd)
  refs = await Promise.all(Array.from({ length: fileCount }, (_, index) =>
    writeRecorderContent(contentRoot, `@@ -1 +1 @@\n-${index}\n+${'patch '.repeat(1800)}${index}\n`, 'utf8')))
})

afterAll(() => rm(root, { recursive: true, force: true }))

function pendingTurn(): TraceArchiveTurn {
  const files: DiffFile[] = refs.map((contentRef, index) => ({
    path: join(cwd, `file-${index}.ts`),
    added: 1,
    deleted: 1,
    patchStatus: 'captured',
    patchContent: {
      content: '',
      contentRef,
      encoding: 'utf8',
      savedBytes: 0,
      source: APP_TRACE_CONTENT_SOURCE,
      sourceCompleteness: 'complete',
      redaction: 'not_run',
      storage: 'complete',
      reasons: []
    }
  }))
  return {
    runId: 'diff-hydration-bench',
    userText: 'benchmark',
    done: true,
    ts: 1,
    items: [{
      id: 'session-diff',
      runId: 'diff-hydration-bench',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'harness',
      stage: SESSION_DIFF_STAGE,
      turnDiff: {
        version: 1,
        status: 'captured',
        files,
        repoRoot: cwd,
        scope: 'working_tree',
        beforeAt: '2026-01-01T00:00:00.000Z',
        afterAt: '2026-01-01T00:00:01.000Z',
        captureMs: 1,
        cleanup: 'ok'
      }
    }]
  }
}

describe('session diff content hydration', () => {
  bench('hydrate 384 referenced patches', async () => {
    const turn = pendingTurn()
    await hydrateNewestSessionSnapshots(userDataDir, cwd, [turn])
    if (turn.items[0].turnDiff?.files[fileCount - 1].patch === undefined) throw new Error('patch hydration incomplete')
  }, { iterations: 5, warmupIterations: 1, time: 0 })
})
