import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRecorderConfig } from './config.js'
import { handleRecorderHook } from './recorder.js'
import { RETAINED_CAPTURE_AGE_MS, STALE_TEMP_AGE_MS, pruneStaleTemps } from './temp-prune.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const day = 24 * 60 * 60 * 1_000

describe('recorder stale temp files', () => {
  it('removes only temps older than a day, then stays quiet until it is due again', async () => {
    const dataRoot = await tempRoot('scry-temp-prune-')
    const records = join(dataRoot, 'records')
    await mkdir(records, { recursive: true })
    await mkdir(join(dataRoot, 'runtime', 'claude', 'session-1'), { recursive: true })
    const recordId = 'a'.repeat(32)
    const staleTemp = join(records, `00000000000000002328-${recordId}.json.4242.6f1e.tmp`)
    const freshTemp = join(records, `00000000000000002329-${'b'.repeat(32)}.json.4243.6f1f.tmp`)
    const nestedStale = join(dataRoot, 'runtime', 'claude', 'session-1', 'open.json.4244.6f20.tmp')
    await writeFile(staleTemp, '{"partial":')
    await writeFile(freshTemp, '{"partial":')
    await writeFile(nestedStale, '')
    const now = Date.now()
    await utimes(staleTemp, new Date(now - 2 * day), new Date(now - 2 * day))
    await utimes(nestedStale, new Date(now - 2 * day), new Date(now - 2 * day))

    const result = await pruneStaleTemps(dataRoot, { now })

    expect(result).toMatchObject({ removed: 2, scanned: true })
    expect(result.bytes).toBe(Buffer.byteLength('{"partial":'))
    expect(await readdir(records)).toEqual([`00000000000000002329-${'b'.repeat(32)}.json.4243.6f1f.tmp`])
    expect(JSON.parse(await readFile(join(dataRoot, 'runtime', 'stale-temp-prune.json'), 'utf8')).at).toBe(new Date(now).toISOString())

    await writeFile(join(records, `00000000000000002330-${'c'.repeat(32)}.json.4245.6f21.tmp`), '')
    const again = await pruneStaleTemps(dataRoot, { now: now + day / 2 })
    expect(again).toEqual({ removed: 0, bytes: 0, scanned: false, retained: 0 })
    expect(await readdir(records)).toHaveLength(2)

    const nextDay = await pruneStaleTemps(dataRoot, { now: now + STALE_TEMP_AGE_MS, olderThanMs: 0 })
    expect(nextDay.scanned).toBe(true)
    expect(nextDay.removed).toBe(2)
  })

  it('never walks the content store or the archive looking for temps', async () => {
    const dataRoot = await tempRoot('scry-temp-prune-scope-')
    await mkdir(join(dataRoot, 'records'), { recursive: true })
    const shard = join(dataRoot, 'content', 'sha256', 'ab')
    await mkdir(shard, { recursive: true })
    const archived = join(dataRoot, 'archive', 'old')
    await mkdir(archived, { recursive: true })
    const inContent = join(shard, 'stray.tmp')
    const inArchive = join(archived, 'stray.tmp')
    await writeFile(inContent, '')
    await writeFile(inArchive, '')
    const old = new Date(Date.now() - 3 * day)
    await utimes(inContent, old, old)
    await utimes(inArchive, old, old)

    const result = await pruneStaleTemps(dataRoot)

    expect(result).toMatchObject({ removed: 0, scanned: true })
    await expect(stat(inContent)).resolves.toBeTruthy()
    await expect(stat(inArchive)).resolves.toBeTruthy()
  })

  it('does not follow a symlinked scan entry out of the workspace', async () => {
    const dataRoot = await tempRoot('scry-temp-prune-link-')
    const outside = await tempRoot('scry-temp-prune-outside-')
    const stray = join(outside, 'stray.tmp')
    await writeFile(stray, '')
    const old = new Date(Date.now() - 3 * day)
    await utimes(stray, old, old)
    await mkdir(join(dataRoot), { recursive: true })
    await symlink(outside, join(dataRoot, 'runtime'))

    const result = await pruneStaleTemps(dataRoot)

    expect(result).toMatchObject({ removed: 0, scanned: true })
    await expect(stat(stray)).resolves.toBeTruthy()
    expect(await readdir(outside)).toEqual(['stray.tmp'])
  })

  it('cleans leftovers at commit time, where every writer converges', async () => {
    const root = await tempRoot('scry-temp-prune-commit-')
    const raw = {
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'temp-prune',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
    }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(raw))
    expect(parseRecorderConfig(raw).enabled).toBe(true)
    const dataRoot = join(root, '.scry')
    const records = join(dataRoot, 'records')
    await mkdir(records, { recursive: true })
    const leftover = join(records, `00000000000000000001-${'d'.repeat(32)}.json.5150.6f22.tmp`)
    await writeFile(leftover, '')
    await utimes(leftover, new Date(Date.now() - 3 * day), new Date(Date.now() - 3 * day))
    const payload = (extra: Record<string, unknown>) => ({ session_id: 'temp-prune-session', timestamp: '2026-01-01T00:00:00.000Z', ...extra })

    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload({ prompt: 'hello' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload({ assistant_response: 'done' }) })

    const names = await readdir(records)
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(names).toHaveLength(1)
  })

  it('expires a retained segment store whose session no longer names it', async () => {
    const dataRoot = await tempRoot('scry-retained-capture-')
    const session = join(dataRoot, 'runtime', 'codex', 'session-1')
    const store = join(session, 'segment-captures', '1', 'scry-turn-diff-abc', 'objects')
    await mkdir(store, { recursive: true })
    await writeFile(join(dataRoot, 'runtime', 'codex', 'session-1', 'session.json'), JSON.stringify({
      schemaVersion: 1, lastGeneration: 1, lastTurnIndex: 0
    }))
    const now = Date.now()
    const old = new Date(now - 3 * RETAINED_CAPTURE_AGE_MS)
    await utimes(join(session, 'segment-captures', '1'), old, old)

    const result = await pruneStaleTemps(dataRoot, { now, olderThanMs: 0 })
    expect(result.retained).toBe(1)
    expect(await readdir(join(session, 'segment-captures'))).toEqual([])
  })

  it('keeps a store the session still holds as its chain baseline, however old', async () => {
    const dataRoot = await tempRoot('scry-retained-chain-')
    const session = join(dataRoot, 'runtime', 'qoder', 'session-2')
    const generation = join(session, 'segment-captures', '1')
    const store = join(generation, 'scry-turn-diff-def', 'objects')
    await mkdir(store, { recursive: true })
    await writeFile(join(session, 'session.json'), JSON.stringify({
      schemaVersion: 1, lastGeneration: 2, lastTurnIndex: 1, chainStores: [generation]
    }))
    const now = Date.now()
    const old = new Date(now - 30 * day)
    await utimes(store, old, old)
    await utimes(generation, old, old)

    const result = await pruneStaleTemps(dataRoot, { now, olderThanMs: 0 })
    expect(result.retained).toBe(0)
    expect(await readdir(join(session, 'segment-captures'))).toEqual(['1'])
  })

  it('leaves a store younger than the retention window alone', async () => {
    const dataRoot = await tempRoot('scry-retained-fresh-')
    const session = join(dataRoot, 'runtime', 'codex', 'session-3')
    const generation = join(session, 'segment-captures', '4')
    await mkdir(join(generation, 'scry-turn-diff-ghi', 'objects'), { recursive: true })
    const result = await pruneStaleTemps(dataRoot, { now: Date.now(), olderThanMs: 0 })
    expect(result.retained).toBe(0)
    expect(await readdir(join(session, 'segment-captures'))).toEqual(['4'])
  })
})
