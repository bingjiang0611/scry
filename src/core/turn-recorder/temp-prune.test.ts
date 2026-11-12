import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRecorderConfig } from './config.js'
import { handleRecorderHook } from './recorder.js'
import { STALE_TEMP_AGE_MS, pruneStaleTemps } from './temp-prune.js'

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
    // 新鲜临时文件可能属于正在写盘的进程，绝不能碰。
    expect(await readdir(records)).toEqual([`00000000000000002329-${'b'.repeat(32)}.json.4243.6f1f.tmp`])
    expect(JSON.parse(await readFile(join(dataRoot, 'runtime', 'stale-temp-prune.json'), 'utf8')).at).toBe(new Date(now).toISOString())

    // 标记文件让目录遍历最多每天一次：同级调用直接跳过，不做任何扫描。
    await writeFile(join(records, `00000000000000002330-${'c'.repeat(32)}.json.4245.6f21.tmp`), '')
    const again = await pruneStaleTemps(dataRoot, { now: now + day / 2 })
    expect(again).toEqual({ removed: 0, bytes: 0, scanned: false })
    expect(await readdir(records)).toHaveLength(2)

    const nextDay = await pruneStaleTemps(dataRoot, { now: now + STALE_TEMP_AGE_MS, olderThanMs: 0 })
    expect(nextDay.scanned).toBe(true)
    expect(nextDay.removed).toBe(2)
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
})
