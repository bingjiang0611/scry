import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const io = vi.hoisted(() => ({
  active: false,
  counts: { open: 0, read: 0, stat: 0, readdir: 0, readBytes: 0, write: 0, rename: 0 }
}))
type IoCounts = typeof io.counts

function resetIo(): void {
  io.counts = { open: 0, read: 0, stat: 0, readdir: 0, readBytes: 0, write: 0, rename: 0 }
}

function addRead(value: unknown): void {
  if (!io.active) return
  io.counts.read++
  if (typeof value === 'string' || Buffer.isBuffer(value)) io.counts.readBytes += Buffer.byteLength(value)
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const wrap = <K extends keyof typeof actual>(name: K, fn: typeof actual[K]): typeof actual[K] => {
    return ((...args: never[]) => {
      if (io.active) {
        if (name === 'openSync') io.counts.open++
        if (name === 'readSync') io.counts.read++
        if (name === 'readFileSync') addRead(args[0])
        if (name === 'readdirSync') io.counts.readdir++
        if (name === 'statSync' || name === 'lstatSync' || name === 'existsSync') io.counts.stat++
        if (name === 'writeFileSync' || name === 'appendFileSync') io.counts.write++
        if (name === 'renameSync') io.counts.rename++
      }
      const result = Reflect.apply(fn as (...args: never[]) => unknown, actual, args)
      if (io.active && name === 'readSync' && typeof result === 'number') io.counts.readBytes += result
      return result
    }) as typeof actual[K]
  }
  return {
    ...actual,
    openSync: wrap('openSync', actual.openSync),
    readSync: wrap('readSync', actual.readSync),
    readFileSync: wrap('readFileSync', actual.readFileSync),
    readdirSync: wrap('readdirSync', actual.readdirSync),
    statSync: wrap('statSync', actual.statSync),
    lstatSync: wrap('lstatSync', actual.lstatSync),
    existsSync: wrap('existsSync', actual.existsSync),
    writeFileSync: wrap('writeFileSync', actual.writeFileSync),
    appendFileSync: wrap('appendFileSync', actual.appendFileSync),
    renameSync: wrap('renameSync', actual.renameSync)
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const wrap = <K extends keyof typeof actual>(name: K, fn: typeof actual[K]): typeof actual[K] => {
    return (async (...args: never[]) => {
      if (io.active) {
        if (name === 'open') io.counts.open++
        if (name === 'readFile') io.counts.read++
        if (name === 'readdir') io.counts.readdir++
        if (name === 'stat' || name === 'lstat') io.counts.stat++
        if (name === 'writeFile') io.counts.write++
        if (name === 'rename') io.counts.rename++
      }
      const result = await Reflect.apply(fn as (...args: never[]) => unknown, actual, args)
      if (io.active && name === 'readFile') addRead(result)
      if (io.active && name === 'open' && result && typeof result === 'object') {
        const fileHandle = result
        const handle = fileHandle as Record<string, unknown>
        for (const method of ['read', 'stat']) {
          const original = handle[method]
          if (typeof original !== 'function') continue
          handle[method] = async (...methodArgs: unknown[]) => {
            if (io.active && method === 'read') {
              io.counts.read++
              const destination = methodArgs[0]
              const readResult = await Reflect.apply(original, fileHandle, methodArgs)
              if (readResult && typeof readResult === 'object' && 'bytesRead' in readResult) io.counts.readBytes += Number(readResult.bytesRead)
              else if (Buffer.isBuffer(destination)) io.counts.readBytes += destination.byteLength
              return readResult
            }
            if (io.active && method === 'stat') io.counts.stat++
            return Reflect.apply(original, result, methodArgs)
          }
        }
      }
      return result
    }) as typeof actual[K]
  }
  return {
    ...actual,
    open: wrap('open', actual.open),
    readFile: wrap('readFile', actual.readFile),
    readdir: wrap('readdir', actual.readdir),
    stat: wrap('stat', actual.stat),
    lstat: wrap('lstat', actual.lstat),
    writeFile: wrap('writeFile', actual.writeFile),
    rename: wrap('rename', actual.rename)
  }
})

const workload = 'fixed-local-temp-workloads'
const timestamp = '2026-01-01T00:00:00.000Z'

async function imports() {
  const [{ cleanupAppStoreAtomicTemps, createAppSessionStore }, usage, archive, workspace, { listMcp }, { listSkills }, drafts, traceProgress] = await Promise.all([
    import('../../src/main/app-store'),
    import('../../src/main/usage-jsonl'),
    import('../../src/main/transcript-archive'),
    import('../../src/main/workspace-files'),
    import('../../src/main/mcp-config'),
    import('../../src/main/skill-config'),
    import('../../src/renderer/composer-drafts'),
    import('../../src/main/trace-turn-progress')
  ])
  return { cleanupAppStoreAtomicTemps, createAppSessionStore, ...usage, ...archive, ...workspace, listMcp, listSkills, ...drafts, ...traceProgress }
}

async function tempRoot(): Promise<{ root: string; home: string; workspace: string; userData: string }> {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'scry-file-counters-'))
  const home = join(root, 'home')
  const workspace = join(home, 'workspace')
  const userData = join(root, 'user-data')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(userData, { recursive: true })])
  await mkdir(join(home, '.claude', 'skills', 'fixed-skill'), { recursive: true })
  await mkdir(join(workspace, '.claude', 'skills', 'project-skill'), { recursive: true })
  await writeFile(join(home, '.claude', 'skills', 'fixed-skill', 'SKILL.md'), '# Fixed skill\n')
  await writeFile(join(workspace, '.claude', 'skills', 'project-skill', 'SKILL.md'), '# Project skill\n')
  await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixed: { command: 'node', args: ['fixed-server.mjs'] } } }))
  return { root, home, workspace, userData }
}

async function measure(operation: () => unknown | Promise<unknown>): Promise<IoCounts> {
  resetIo()
  io.active = true
  try { await operation() } finally { io.active = false }
  return { ...io.counts }
}

function metrics(counts: IoCounts): Record<string, number> {
  return {
    'io.open': counts.open,
    'io.read': counts.read,
    'io.stat': counts.stat,
    'io.readdir': counts.readdir,
    'io.read.bytes': counts.readBytes,
    'io.write': counts.write,
    'io.rename': counts.rename
  }
}

describe('fixed production file work counters', () => {
  it('counts fixed file workloads with complete functional results', async () => {
    const production = await imports()
    const runs = await repeatCounters(defaultRepeats, async (index) => {
      const fixture = await tempRoot()
      const { mkdir, writeFile, rm } = await import('node:fs/promises')
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const stale = [
        join(fixture.userData, 'app-sessions.json.tmp'),
        join(fixture.userData, 'recent-folders.json.tmp'),
        join(fixture.userData, 'usage.jsonl.tmp'),
        join(fixture.userData, 'app-sessions.json.1.00000000-0000-4000-8000-000000000000.tmp')
      ]
      const { writeFileSync } = await import('node:fs')
      const sessions = Array.from({ length: 500 }, (_, item) => ({ sessionId: `session-${item}`, runId: `catalog-${item}`, providerId: 'codex', runtimeProvider: 'codex_cli', cwd: fixture.workspace, preview: `prompt ${item}`, ts: item }))
      writeFileSync(join(fixture.userData, 'app-sessions.json'), JSON.stringify(sessions))
      const usageRows = Array.from({ length: 240 }, (_, item) => JSON.stringify({ providerId: 'codex', runtimeProvider: 'codex_cli', cwd: fixture.workspace, runId: `usage-${item}`, cost: 0.01, tin: 100, tout: 40, ts: timestamp })).join('\n') + '\n'
      writeFileSync(join(fixture.userData, 'usage.jsonl'), usageRows)
      const archive = { cwd: fixture.workspace, sessionId: 'fixed-session', providerId: 'codex' as const, userDataDir: fixture.userData }
      for (let item = 0; item < 120; item++) production.upsertTraceArchiveTurn({ ...archive, turn: { runId: `archive-${item}`, userText: `request ${item}`, done: true, ts: item, items: [] } })
      await writeFile(join(fixture.workspace, 'large-fixed.txt'), 'x'.repeat(1024 * 1024))
      await mkdir(join(fixture.workspace, 'directory'), { recursive: true })
      await writeFile(join(fixture.workspace, 'directory', 'entry.txt'), 'entry')
      const store = production.createAppSessionStore(fixture.userData)
      const draftStorage = { value: '', getItem: () => draftStorage.value, setItem: (_key: string, value: string) => { draftStorage.value = value }, removeItem: () => { draftStorage.value = '' } }
      await Promise.all(stale.map((path) => writeFile(path, 'stale')))
      let result: unknown
      const counts = await measure(async () => {
        production.cleanupAppStoreAtomicTemps(fixture.userData)
        production.cleanupUsageAtomicTemps(fixture.userData)
        production.cleanupTraceTurnProgressTemps(fixture.userData)
        await production.cleanupTraceArchiveTemps(fixture.userData)
        expect(stale.every((path) => !existsSync(path))).toBe(true)
        const stats = production.readUsageStats(fixture.userData)
        expect(stats).toMatchObject({ status: 'ready', turns: 240 })

        const skills = production.listSkills(fixture.workspace, fixture.home)
        const mcp = production.listMcp(fixture.workspace, fixture.home)
        expect(skills).toHaveLength(2)
        expect(mcp.some((item) => item.name === 'fixed')).toBe(true)

        expect(store.load()).toHaveLength(500)
        const initialPage = await production.readTraceArchivePageAsync(archive, { limit: 40 })
        expect(initialPage.archive?.turns).toHaveLength(40)
        const written = production.upsertTraceArchiveTurn({ ...archive, turn: { runId: 'archive-write', userText: 'written', done: true, ts: 121, items: [] } })
        expect(written).toBe(true)
        const page = await production.readTraceArchivePageAsync(archive, { limit: 40 })
        expect(page.archive?.turns.length).toBeGreaterThan(0)

        production.appendUsage(fixture.userData, { providerId: 'codex', runtimeProvider: 'codex_cli', cwd: fixture.workspace, runId: `appended-${index}` }, { costUsd: 0.02, tokensIn: 101, tokensOut: 41, ts: timestamp })
        expect(production.readUsageStats(fixture.userData).turns).toBe(241)

        const listed = await production.listWorkspace({ cwd: fixture.workspace, path: '', limit: 200 })
        const file = await production.readWorkspaceFile({ cwd: fixture.workspace, path: 'large-fixed.txt' })
        const filePage = await production.readWorkspaceFilePage({ cwd: fixture.workspace, path: 'large-fixed.txt', limit: 64 * 1024 })
        expect(listed.entries.some((entry) => entry.path === 'large-fixed.txt')).toBe(true)
        expect(file.content).toHaveLength(1024 * 1024)
        expect(filePage.content).toHaveLength(64 * 1024 + 3)

        let drafts = production.readComposerDrafts(draftStorage)
        for (let draft = 0; draft < 32; draft++) drafts = production.updateComposerDraft(drafts, `codex\\0fixed\\0session-${draft}`, () => ({ input: 'x'.repeat(4096), attachments: [] })).drafts
        expect(production.writeComposerDrafts(draftStorage, drafts)).toBe(true)
        expect(production.readComposerDrafts(draftStorage)).toHaveProperty('size', 32)
        result = stats
      })
      expect(result).toBeDefined()
      await rm(fixture.root, { recursive: true, force: true })
      return metrics(counts)
    })
    const meta = { scenario: 'files.fixed-operations', layer: 'io' as const, workload, source: 'pass-through node:fs and node:fs/promises wrappers around production functions' }
    writeCollector('files', Object.entries(runs).map(([metric, values]) => measured({ ...meta, metric, unit: metric === 'io.read.bytes' ? 'bytes' as const : 'count' as const }, values)))
  })

  it('is sensitive to duplicated production reads', async () => {
    const { listWorkspace } = await imports()
    const fixture = await tempRoot()
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(`${fixture.workspace}/fixed.txt`, 'fixed content')
    const single = await measure(async () => {
      const result = await listWorkspace({ cwd: fixture.workspace, path: '', limit: 200 })
      expect(result.entries.some((entry) => entry.path === 'fixed.txt')).toBe(true)
    })
    const doubled = await measure(async () => {
      const first = await listWorkspace({ cwd: fixture.workspace, path: '', limit: 200 })
      const second = await listWorkspace({ cwd: fixture.workspace, path: '', limit: 200 })
      expect(first.entries).toEqual(second.entries)
    })
    expect(doubled.read + doubled.stat + doubled.readdir).toBeGreaterThan(single.read + single.stat + single.readdir)
    expect(doubled.readBytes).toBeGreaterThanOrEqual(single.readBytes)
    await rm(fixture.root, { recursive: true, force: true })
  })
})
