import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { valueName } from '../../src/main/workflow-store-artifacts'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { WorkflowControlFrame, WorkflowValue } from '../../src/shared/workflow'
import { FileWorkflowStore } from '../../src/main/workflow-store'
import { closeUnder, runtime } from './runtime'
import { MetadataWorker } from './worker-client'
import { DB_NAME, type Stats } from './protocol'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) { await closeUnder(root); await rm(root, { recursive: true, force: true }) }
})
function frame(): Omit<WorkflowControlFrame, 'revision'> {
  return { schemaVersion: 1, workflowId: 'prototype-flow', programRevision: 'revision', frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'entered' }
}
const known = (value: WorkflowValue) => ({ state: 'known' as const, value, derivedFrom: [] })
async function setup() {
  const root = await mkdtemp('/tmp/scry-sqlite-prototype-')
  roots.push(root)
  const store = new FileWorkflowStore(root), initial = await store.saveFrame(frame(), 0)
  const directory = join(root, 'workflows'), storage = await runtime(directory)
  return { root, directory, store, initial, storage }
}

// Real SQLite/Worker IO, not a mock database or fake success envelope.
describe('isolated transactional metadata prototype', () => {
  it('uses FULL/WAL durability settings and counts one additional real durable mutation', async () => {
    const f = await setup(), before = await f.storage.worker.request({ op: 'stats' }) as Stats
    expect(before).toMatchObject({ journalMode: 'wal', synchronous: 2, fullfsync: 1, checkpointFullfsync: 1 })
    await f.store.saveFrame({ ...frame(), frameId: 'extra', nodeId: 'extra' }, 0)
    const after = await f.storage.worker.request({ op: 'stats' }) as Stats
    expect(after.transactions).toBe(before.transactions + 1)
    expect(after.mutations).toBe(before.mutations + 1)
    expect(after.bodyBytes).toBeGreaterThan(before.bodyBytes)
    await closeUnder(f.root)
    expect(await new FileWorkflowStore(f.root).loadFrame('prototype-flow', 'extra')).toMatchObject({ phase: 'entered', revision: 1 })
  })

  it('rolls back before COMMIT without publishing a terminal frame or acknowledging success', async () => {
    const f = await setup()
    await f.storage.fault('before_commit')
    await expect(f.store.saveFrameWithValue({ ...f.initial, phase: 'completed' }, 1,
      { field: 'resultRef', key: 'answer', evaluation: known(false) })).rejects.toThrow('injected before COMMIT')
    await closeUnder(f.root)
    const cold = new FileWorkflowStore(f.root)
    expect(await cold.loadFrame('prototype-flow', 'node')).toMatchObject({ phase: 'entered', revision: 1 })
    expect((await cold.loadFrame('prototype-flow', 'node'))!.resultRef).toBeUndefined()
    expect((await readdir(f.directory)).filter(name => name.endsWith('.value.json'))).toHaveLength(1)
  })

  it('fences an unknown COMMIT reply and cold-reads the committed fact without retrying the write', async () => {
    const f = await setup()
    await f.storage.fault('lost_commit_reply')
    await expect(f.store.saveFrameWithValue({ ...f.initial, phase: 'completed' }, 1,
      { field: 'resultRef', key: 'answer', evaluation: known(0) })).rejects.toMatchObject({ unknown: true, message: 'SQLite worker exited: 74' })
    await expect(f.store.saveFrame({ ...frame(), frameId: 'must-not-retry', nodeId: 'must-not-retry' }, 0)).rejects.toMatchObject({ unknown: true })
    await closeUnder(f.root)
    const cold = new FileWorkflowStore(f.root), committed = (await cold.loadFrame('prototype-flow', 'node'))!
    expect(committed).toMatchObject({ phase: 'completed', revision: 2 })
    expect(await cold.loadValue('prototype-flow', committed.resultRef!)).toEqual(known(0))
    expect(await cold.loadFrame('prototype-flow', 'must-not-retry')).toBeUndefined()
  })

  it('does not acknowledge a frame while its actual SQL COMMIT is held', async () => {
    const f = await setup()
    await f.storage.fault('hold_commit')
    const held = f.storage.worker.waitHeld()
    let acknowledged = false
    const pending = f.store.saveFrameWithValue({ ...f.initial, phase: 'completed' }, 1,
      { field: 'resultRef', key: 'answer', evaluation: known(false) }).then(value => { acknowledged = true; return value })
    let inspector: MetadataWorker | undefined
    try {
      await held
      expect(acknowledged).toBe(false)
      inspector = new MetadataWorker(f.storage.directory, false)
      await inspector.ready
      const old = JSON.parse(await inspector.request({ op: 'get', name: 'prototype-flow.node.frame.json' }) as string) as WorkflowControlFrame
      expect(old).toMatchObject({ phase: 'entered', revision: 1 })
      expect(old.resultRef).toBeUndefined()
      expect(acknowledged).toBe(false)
    } finally {
      await f.storage.worker.request({ op: 'release' })
      await pending
      if (inspector) await inspector.close()
    }
    expect(acknowledged).toBe(true)
  })

  it.each([false, true])('keeps SQL authority behind the real artifact-directory barrier: fail=%s', async fail => {
    const f = await setup()
    let release!: () => void, reached!: () => void, armed = true
    const gate = new Promise<void>(resolve => { release = resolve }), barrier = new Promise<void>(resolve => { reached = resolve })
    const flushing = f.storage as unknown as { flushArtifacts(): Promise<void> }
    const original = flushing.flushArtifacts.bind(flushing)
    const publication = vi.spyOn(flushing, 'flushArtifacts').mockImplementation(async () => {
      if (!armed) return original()
      armed = false
      reached()
      await gate
      if (!fail) return original()
      // Make the actual directory-open barrier fail, without replacing the IO.
      // Restore the same directory before the SQLite rollback and cleanup.
      const moved = f.storage.directory + '.barrier-held'
      await rename(f.storage.directory, moved)
      try { await original() } finally { await rename(moved, f.storage.directory) }
    })
    let acknowledged = false, inspector: MetadataWorker | undefined
    const pending = f.store.saveFrameWithValue({ ...f.initial, phase: 'completed' }, 1,
      { field: 'resultRef', key: 'answer', evaluation: known(false) }).then(value => { acknowledged = true; return { value } }, error => ({ error: error as unknown }))
    try {
      await barrier
      expect(acknowledged).toBe(false)
      inspector = new MetadataWorker(f.storage.directory, false)
      await inspector.ready
      expect(JSON.parse(await inspector.request({ op: 'get', name: 'prototype-flow.node.frame.json' }) as string)).toMatchObject({ phase: 'entered', revision: 1 })
      release()
      const settled = await pending
      if (fail) expect(settled).toHaveProperty('error', expect.objectContaining({ code: 'ENOENT' }))
      else expect(settled).toHaveProperty('value', expect.objectContaining({ phase: 'completed' }))
      expect(acknowledged).toBe(!fail)
    } finally {
      release()
      await pending
      publication.mockRestore()
      if (inspector) await inspector.close()
    }
  })

  it('rejects a real value rename failure without publishing its frame', async () => {
    const f = await setup()
    const hash = createHash('sha256').update(JSON.stringify(known(false))).digest('hex')
    await mkdir(join(f.directory, valueName({ workflowId: 'prototype-flow', key: 'answer', hash })))
    await expect(f.store.saveFrameWithValue({ ...f.initial, phase: 'completed' }, 1,
      { field: 'resultRef', key: 'answer', evaluation: known(false) })).rejects.toMatchObject({ syscall: 'rename' })
    expect(await f.store.loadFrame('prototype-flow', 'node')).toEqual(f.initial)
    expect((await readdir(f.directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.value.json'))).toEqual([])
  })

  it('rejects changed canonical metadata bytes even when the JSON value is identical', async () => {
    const f = await setup()
    await closeUnder(f.root)
    await exec(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA synchronous=FULL');
db.prepare("UPDATE metadata SET body=body || ' ' WHERE name=?").run('prototype-flow.node.frame.json'); db.close();`, join(f.directory, DB_NAME)])
    await expect(new FileWorkflowStore(f.root).loadFrame('prototype-flow', 'node')).rejects.toThrow('metadata hash mismatch')
  })

  it('does not create an empty database if the prototype marker survives a missing database', async () => {
    const f = await setup()
    await closeUnder(f.root)
    await rm(join(f.directory, DB_NAME))
    await expect(new FileWorkflowStore(f.root).loadFrame('prototype-flow', 'node')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(f.directory)).includes(DB_NAME)).toBe(false)
  })

  it('refuses legacy metadata rather than silently migrating or opening an empty SQL history', async () => {
    const root = await mkdtemp('/tmp/scry-sqlite-prototype-')
    roots.push(root)
    const directory = join(root, 'workflows')
    await mkdir(directory)
    await writeFile(join(directory, 'legacy.json'), '{"must":"remain"}')
    await expect(new FileWorkflowStore(root).load('legacy')).rejects.toThrow('refuses legacy data')
    expect((await readdir(directory)).includes(DB_NAME)).toBe(false)
    expect(await readFile(join(directory, 'legacy.json'), 'utf8')).toBe('{"must":"remain"}')
  })

  it('bounds business admission but can still close a full namespace queue', async () => {
    const f = await setup()
    let completed = 0
    const jobs = Array.from({ length: 64 }, () => f.storage.transaction(async () => { completed++ }))
    const overflow = expect(f.storage.transaction(async () => {})).rejects.toThrow('queue bound exceeded')
    const closed = f.storage.close().then(() => ({ closed: true }), error => ({ closed: false, error: error as unknown }))
    const outcomes = await Promise.allSettled(jobs), result = await closed
    if (!result.closed) await f.storage.worker.close() // Reclaim the actual Worker even if this regression fails.
    await overflow
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true)
    expect(completed).toBe(64)
    expect(result).toEqual({ closed: true })
  })

  it('does not let inherited TMPDIR authorize a home-directory namespace', async () => {
    const root = join(homedir(), 'scry-forbidden-prototype-' + randomUUID())
    vi.stubEnv('TMPDIR', homedir())
    try {
      await expect(new FileWorkflowStore(root).loadFrame('prototype-flow', 'node')).rejects.toThrow('non-temporary namespace')
      await expect(readFile(join(root, 'workflows', DB_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { vi.unstubAllEnvs(); await closeUnder(root) }
  })

  it('keeps concurrent independent roots separate and durable after closing their shared namespace', async () => {
    const f = await setup()
    await Promise.all(['first-root', 'second-root'].map(workflowId => new FileWorkflowStore(f.root).saveFrame({ ...frame(), workflowId }, 0)))
    await closeUnder(f.root)
    const cold = new FileWorkflowStore(f.root)
    for (const workflowId of ['first-root', 'second-root']) expect(await cold.loadFrame(workflowId, 'node')).toMatchObject({ workflowId, phase: 'entered', revision: 1 })
  })

  it('admits one real frame CAS across separate controller processes and connections', async () => {
    const f = await setup(), path = join(f.root, 'cas-controller.mjs')
    await closeUnder(f.root)
    await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'cas-controller.ts')], outfile: path,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const results = await Promise.all(['first', 'second'].map(value => exec(process.execPath, [path, f.root, value],
      { env: { HOME: f.root, TMPDIR: f.root, PATH: '/usr/bin:/bin' } })))
    const states = results.map(result => (JSON.parse(result.stdout.trim()) as { status: string }).status).sort()
    expect(states).toEqual(['committed', 'refused'])
    const cold = new FileWorkflowStore(f.root), committed = (await cold.loadFrame('prototype-flow', 'node'))!
    expect(committed).toMatchObject({ phase: 'completed', revision: 2 })
    expect(await cold.loadValue('prototype-flow', committed.resultRef!)).toMatchObject({ state: 'known', value: expect.stringMatching(/^(first|second)$/) })
  })
})
