import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TraceArchiveTurn } from './transcript-archive'
import { externalizeTraceDiffPatches, hydrateNewestSessionSnapshots } from './trace-diff-content'
import { appTraceContentRoot } from './trace-tool-content'
import { readRecorderContent, writeRecorderContentBatch } from '../core/turn-recorder/content-store'

const observed = vi.hoisted(() => ({
  syncs: [] as string[],
  onSync: undefined as ((path: string) => void) | undefined,
  onLink: undefined as ((path: string) => Promise<void>) | undefined
}))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      await observed.onLink?.(String(args[1]))
      return fs.link(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = () => {
        observed.syncs.push(String(args[0]))
        observed.onSync?.(String(args[0]))
        return sync()
      }
      return handle
    }
  }
})

let userData: string
const cwd = '/workspace/batched-patches'
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'scry-diff-batch-'))
  observed.syncs.length = 0
  observed.onSync = undefined
  observed.onLink = undefined
})
afterEach(async () => { await rm(userData, { recursive: true, force: true }) })

function turn(patches: string[]): TraceArchiveTurn {
  return {
    runId: 'batch-run', userText: 'fixture', done: true, ts: 1,
    items: [{
      id: 'snapshot', runId: 'batch-run', kind: 'harness', stage: 'session_diff', ts: '2026-01-01T00:00:00.000Z',
      turnDiff: {
        version: 1, status: 'captured', repoRoot: cwd, scope: 'working_tree',
        beforeAt: '2026-01-01T00:00:00.000Z', afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok',
        files: patches.map((patch, index) => ({ path: `${cwd}/${index}.ts`, patch, added: 1, deleted: 0, patchStatus: 'captured' }))
      }
    }]
  }
}

it('prepares shared ancestors once for a snapshot and restores every exact patch', async () => {
  const patches = ['@@ -0,0 +1 @@\n+first\n', '@@ -0,0 +1 @@\n+汉字 😀\n', '@@ -0,0 +1 @@\n+third\n']
  const source = turn(patches)
  const { turn: stored } = await externalizeTraceDiffPatches(userData, cwd, source)
  expect(observed.syncs.filter(path => path === parse(userData).root)).toHaveLength(1)
  expect(stored.items[0].turnDiff!.files.every(file => !file.patch && file.patchContent?.contentRef)).toBe(true)
  await hydrateNewestSessionSnapshots(userData, cwd, [stored])
  expect(stored.items[0].turnDiff!.files.map(file => file.patch)).toEqual(patches)
})

it('keeps references aligned when the snapshot repeats the same file object', async () => {
  const patches = ['first', 'second', 'third']
  const source = turn(patches)
  const files = source.items[0].turnDiff!.files
  files.splice(1, 0, files[0])
  const { turn: stored } = await externalizeTraceDiffPatches(userData, cwd, source)
  await hydrateNewestSessionSnapshots(userData, cwd, [stored])
  expect(stored.items[0].turnDiff!.files.map(file => file.patch)).toEqual(['first', 'first', 'second', 'third'])
})

it.each(['ancestor', 'payload', 'link'])('does not expose references after a %s sync failure and repairs on retry', async phase => {
  const source = turn(['first', 'second', 'third'])
  const matches = (path: string) => phase === 'ancestor' ? path === parse(userData).root
    : phase === 'payload' ? path.endsWith('.archive-tmp') : /\/sha256\/[a-f0-9]{2}$/.test(path)
  observed.onSync = path => { if (matches(path)) throw new Error(`injected ${phase} sync failure`) }
  await expect(externalizeTraceDiffPatches(userData, cwd, source)).rejects.toThrow(`injected ${phase} sync failure`)
  expect(source.items[0].turnDiff!.files.every(file => !file.patchContent?.contentRef)).toBe(true)
  const root = appTraceContentRoot(userData, cwd)
  const names = await readdir(root, { recursive: true })
  if (phase !== 'link') expect(names.filter(name => String(name).endsWith('.bin'))).toHaveLength(0)
  observed.onSync = undefined
  const { turn: stored } = await externalizeTraceDiffPatches(userData, cwd, source)
  await hydrateNewestSessionSnapshots(userData, cwd, [stored])
  expect(stored.items[0].turnDiff!.files.map(file => file.patch)).toEqual(['first', 'second', 'third'])
})

it.each([false, true])('verifies a competing publisher instead of treating EEXIST as success (corrupt=%s)', async corrupt => {
  const root = appTraceContentRoot(userData, cwd)
  let raced = false
  observed.onLink = async path => {
    if (raced) return
    raced = true
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(corrupt ? 'wrong bytes' : 'first')
      await handle.sync()
    } finally { await handle.close() }
  }
  if (corrupt) {
    await expect(writeRecorderContentBatch(root, ['first', 'second'], 'utf8')).rejects.toThrow('collision or corruption')
  } else {
    const refs = await writeRecorderContentBatch(root, ['first', 'second'], 'utf8')
    expect(await Promise.all(refs.map(ref => readRecorderContent(root, ref)))).toEqual(['first', 'second'])
  }
  expect(raced).toBe(true)
})

it('rejects corrupted existing bytes before publishing the missing part of a batch', async () => {
  const root = appTraceContentRoot(userData, cwd)
  const [ref] = await writeRecorderContentBatch(root, ['existing'], 'utf8')
  const path = join(root, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
  await writeFile(path, 'corruption')
  await expect(writeRecorderContentBatch(root, ['new', 'existing'], 'utf8')).rejects.toThrow('collision or corruption')
  expect(await readFile(path, 'utf8')).toBe('corruption')
  expect((await readdir(root, { recursive: true })).filter(name => String(name).endsWith('.bin'))).toHaveLength(1)
})

it('deduplicates equal UTF-8 bytes, including replacement characters, without changing reference order', async () => {
  const root = appTraceContentRoot(userData, cwd)
  const contents = ['汉字 😀', '\ud800', '\ud801', '汉字 😀', '']
  const refs = await writeRecorderContentBatch(root, contents, 'utf8')
  expect(await Promise.all(refs.map(ref => readRecorderContent(root, ref)))).toEqual(contents.map(text => Buffer.from(text).toString('utf8')))
  expect(refs[0]).toEqual(refs[3])
  expect(refs[1]).toEqual(refs[2])
  expect((await readdir(root, { recursive: true })).filter(name => String(name).endsWith('.bin'))).toHaveLength(3)
})

it('still requires a directory barrier when a complete blob already exists', async () => {
  const root = appTraceContentRoot(userData, cwd)
  await writeRecorderContentBatch(root, ['existing'], 'utf8')
  observed.onSync = path => { if (/\/sha256\/[a-f0-9]{2}$/.test(path)) throw new Error('reuse sync failed') }
  await expect(writeRecorderContentBatch(root, ['existing'], 'utf8')).rejects.toThrow('reuse sync failed')
})
