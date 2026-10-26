import { isToolContent } from '../shared/tool-content'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_DIFF_PREVIEW_STAGE, SESSION_DIFF_STAGE, TURN_DIFF_STAGE, type DiffFile } from '../shared/turn-diff'
import type { TraceArchiveTurn } from './transcript-archive'
import { readTraceArchivePageAsync, upsertTraceArchiveTurnAsync } from './transcript-archive'
import { externalizeTraceDiffPatches, hydrateNewestSessionSnapshots } from './trace-diff-content'
import { appTraceContentRoot } from './trace-tool-content'

const cwd = '/workspace/large'
const sessionId = 'large-session'
let userDataDir: string

// A patch body well above the reference threshold, distinctive so a wrong ref is visible.
const patch = (marker: string, lines: number) => `@@ -1 +1 @@\n${Array.from({ length: lines }, (_, index) => `+${marker} line ${index}`).join('\n')}\n`

const snapshot = (scope: 'turn' | 'session', marker: string, lines = 1200) => ({
  version: 1 as const,
  status: 'captured' as const,
  files: [
    { path: '/workspace/large/a.ts', added: 1, deleted: 0, patch: patch(`${marker}-a`, scope === 'turn' ? 20 : lines), patchStatus: 'captured' as const },
    { path: '/workspace/large/b.ts', added: 1, deleted: 0, patch: patch(`${marker}-b`, scope === 'turn' ? 20 : lines), patchStatus: 'captured' as const }
  ],
  repoRoot: cwd,
  scope: 'working_tree' as const,
  beforeAt: '2026-01-01T00:00:00.000Z',
  afterAt: '2026-01-01T00:00:01.000Z',
  captureMs: 3,
  cleanup: 'ok' as const,
  ...(scope === 'session' ? {} : {})
})

const diffItem = (runId: string, stage: string, marker: string) => ({
  id: `${runId}-${stage}`,
  ts: '2026-01-01T00:00:00.000Z',
  runId,
  kind: 'harness' as const,
  stage,
  turnDiff: snapshot(stage === TURN_DIFF_STAGE ? 'turn' : 'session', marker)
})

const evidence = (marker: string) => ({
  user: { status: 'available', quality: 'exact', source: ['scry_provider_adapter'], value: { text: 'hi' } },
  assistant: { status: 'available', quality: 'exact', source: ['scry_provider_adapter'], value: { text: 'ok' } },
  diff: {
    status: 'available',
    quality: 'exact',
    source: ['scry_provider_adapter'],
    // Evidence snapshots are canonical records: no version/captureMs, same patch shape.
    value: [snapshot('session', marker)].map(({ version: _version, captureMs: _captureMs, ...rest }) => rest)
  }
}) as never

const turn = (runId: string, marker: string, ts = 1): TraceArchiveTurn => ({
  runId,
  userText: `request ${marker}`,
  done: true,
  ts,
  items: [
    diffItem(runId, SESSION_DIFF_STAGE, marker),
    diffItem(runId, TURN_DIFF_STAGE, marker)
  ],
  turnEvidence: evidence(marker)
})

const filesOf = (value: TraceArchiveTurn): DiffFile[] => value.items[0].turnDiff!.files

function blobs(dir: string): string[] {
  const root = join(appTraceContentRoot(dir, cwd), 'content', 'sha256')
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.bin'))
}

beforeEach(() => { userDataDir = mkdtempSync(join(tmpdir(), 'scry-diff-content-')) })
afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

describe('cumulative diff patch bodies move to the content store', () => {
  it('replaces session snapshot patch bodies with a content reference plus bounded preview', async () => {
    const source = turn('run-1', 'first')
    const expected = filesOf(source).map((file) => file.patch)
    const before = JSON.stringify(source.items[0]).length
    const { turn: slim, changed } = await externalizeTraceDiffPatches(userDataDir, cwd, source)
    expect(changed).toBe(true)
    for (const file of filesOf(slim)) {
      expect(file.patch).toBeUndefined()
      expect(isToolContent(file.patchContent)).toBe(true)
      expect(file.patchContent!.contentRef!.storage).toBe('recorder-content-v1')
      expect(Buffer.byteLength(file.patchContent!.content!, 'utf8')).toBeLessThanOrEqual(2048)
      expect(file.patchContent!.storage).toBe('complete')
    }
    // The bytes really left the turn file and are readable from the store by reference.
    expect(JSON.stringify(slim.items[0]).length).toBeLessThan(before / 5)
    await hydrateNewestSessionSnapshots(userDataDir, cwd, [slim])
    expect(filesOf(slim).map((file) => file.patch)).toEqual(expected)
  })

  it('keeps per-turn diffs inline: history pages show them per turn', async () => {
    const source = turn('run-1', 'first')
    const { turn: slim } = await externalizeTraceDiffPatches(userDataDir, cwd, source)
    const perTurn = slim.items.find((item) => item.stage === TURN_DIFF_STAGE)!
    expect(perTurn.turnDiff!.files.every((file) => typeof file.patch === 'string' && !file.patchContent)).toBe(true)
  })

  it('leaves small patches inline and is idempotent', async () => {
    const small: TraceArchiveTurn = {
      runId: 'run-2',
      userText: 'request small',
      done: true,
      ts: 1,
      items: [{
        ...diffItem('run-2', SESSION_DIFF_STAGE, 'small'),
        turnDiff: { ...snapshot('session', 'small'), files: [{ path: '/workspace/large/a.ts', added: 1, deleted: 0, patch: '@@ -1 +1 @@\n+x\n', patchStatus: 'captured' }] }
      }]
    }
    const first = await externalizeTraceDiffPatches(userDataDir, cwd, small)
    expect(first.changed).toBe(false)
    expect(filesOf(small)[0].patch).toBe('@@ -1 +1 @@\n+x\n')

    const once = await externalizeTraceDiffPatches(userDataDir, cwd, turn('run-3', 'again'))
    const refs = filesOf(once.turn).map((file) => file.patchContent!.contentRef!.sha256)
    const twice = await externalizeTraceDiffPatches(userDataDir, cwd, once.turn)
    expect(twice.changed).toBe(false)
    expect(filesOf(twice.turn).map((file) => file.patchContent!.contentRef!.sha256)).toEqual(refs)
  })

  it('externalizes the duplicated canonical evidence snapshots too', async () => {
    const source = turn('run-1', 'first')
    const { turn: slim } = await externalizeTraceDiffPatches(userDataDir, cwd, source)
    const evidenceFiles = slim.turnEvidence!.diff.value!.flatMap((entry) => entry.files)
    expect(evidenceFiles.length).toBe(2)
    expect(evidenceFiles.every((file) => file.patch === undefined && file.patchContent?.contentRef)).toBe(true)
  })

  it('hydrates only the newest terminal and preview session snapshots of a page', async () => {
    const turns = [
      await externalizeTraceDiffPatches(userDataDir, cwd, turn('run-1', 'one')).then((result) => result.turn),
      await externalizeTraceDiffPatches(userDataDir, cwd, turn('run-2', 'two')).then((result) => result.turn),
      await externalizeTraceDiffPatches(userDataDir, cwd, {
        ...turn('run-3', 'three'),
        items: [
          diffItem('run-3', SESSION_DIFF_STAGE, 'three'),
          diffItem('run-3', SESSION_DIFF_PREVIEW_STAGE, 'three')
        ]
      }).then((result) => result.turn)
    ]
    await hydrateNewestSessionSnapshots(userDataDir, cwd, turns)
    expect(turns[2].items.every((item) => item.turnDiff!.files.every((file) => typeof file.patch === 'string'))).toBe(true)
    // Superseded snapshots stay references: they never cross IPC (see the page projection).
    expect(turns[0].items[0].turnDiff!.files.every((file) => file.patch === undefined)).toBe(true)
    expect(turns[1].items[0].turnDiff!.files.every((file) => file.patch === undefined)).toBe(true)
  })
})

describe('archive write and page read keep the same visible snapshot', () => {
  it('stores references on disk and restores inline patches for the newest page snapshot', async () => {
    const args = { cwd, sessionId, providerId: 'pi' as const, userDataDir }
    expect(await upsertTraceArchiveTurnAsync({ ...args, turn: turn('run-one', 'one', 1) })).toBe(true)
    expect(await upsertTraceArchiveTurnAsync({ ...args, turn: turn('run-two', 'two', 2) })).toBe(true)
    const page = await readTraceArchivePageAsync(args, { limit: 40 })
    const newest = page.archive!.turns.at(-1)!.items.find((item) => item.stage === SESSION_DIFF_STAGE)!
    expect(newest.turnDiff!.files.every((file) => typeof file.patch === 'string' && file.patch!.includes('two-'))).toBe(true)
    // The archive file on disk keeps references instead of a second copy of every patch body.
    const piDir = join(userDataDir, 'trace-archive-turns-v1', 'pi')
    const sessionDir = join(piDir, readdirSync(piDir)[0])
    const turnDir = join(sessionDir, readdirSync(sessionDir)[0])
    const parsed = readdirSync(turnDir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(turnDir, name), 'utf8')) as { turns: TraceArchiveTurn[] })
      .sort((a, b) => a.turns[0].ts - b.turns[0].ts)
    const onDisk = JSON.stringify(parsed[0])
    // 只有 2 KB 预览留在 turn 文件里，完整正文（含最后一行）只在内容库。
    expect(onDisk).not.toContain('+one-a line 1199')
    expect(onDisk).toContain('recorder-content-v1')
    expect(onDisk.length).toBeLessThan(20 * 1024)
    expect(statSync(appTraceContentRoot(userDataDir, cwd)).isDirectory()).toBe(true)
  })

  it('writes each distinct patch body once no matter how many turns repeat it', async () => {
    const args = { cwd, sessionId, providerId: 'pi' as const, userDataDir }
    const repeated: TraceArchiveTurn = {
      ...turn('run-shared', 'shared'),
      items: [diffItem('run-shared', SESSION_DIFF_STAGE, 'shared')]
    }
    await upsertTraceArchiveTurnAsync({ ...args, turn: repeated })
    await upsertTraceArchiveTurnAsync({ ...args, turn: { ...repeated, runId: 'run-shared-2' } })
    // Two files, two distinct bodies: the repeated turn adds no new blobs.
    expect(blobs(userDataDir).length).toBe(2)
  })
})
