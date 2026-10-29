import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withDirectoryLock } from '../../src/core/turn-recorder/io'
import { afterEach, expect, it } from 'vitest'
import { FileWorkflowStore } from '../../src/main/workflow-store'
import { snapshotFilesystem } from './io-meter-setup'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp('/tmp/scry-checkpoint-meter-')
  roots.push(root)
  const store = new FileWorkflowStore(root)
  await store.saveValue('meter', 'warm', { state: 'known', value: true, derivedFrom: [] })
  return store
}
it('detects one additional flushed immutable value write and its byte size', async () => {
  const store = await fixture(), before = snapshotFilesystem()
  const value = { state: 'known' as const, value: false, derivedFrom: [] }
  await store.saveValue('meter', 'extra', value)
  const after = snapshotFilesystem()
  expect(after.writeFileSucceeded).toBe(before.writeFileSucceeded + 1)
  expect(after.flushedWritesSucceeded).toBe(before.flushedWritesSucceeded + 1)
  expect(after.renameSucceeded).toBe(before.renameSucceeded + 1)
  expect(after['published.value']).toBe(before['published.value'] + 1)
  expect(after.explicitSyncSucceeded).toBe(before.explicitSyncSucceeded + 1)
  expect(after.fileWrittenBytes).toBe(before.fileWrittenBytes + Buffer.byteLength(JSON.stringify(value)))
})
it('counts real writes from overlapping independent FileStore lifetimes', async () => {
  const [first, second] = await Promise.all([fixture(), fixture()]), before = snapshotFilesystem()
  await Promise.all([first.saveValue('meter', 'extra-a', { state: 'known', value: false, derivedFrom: [] }),
    second.saveValue('meter', 'extra-b', { state: 'known', value: false, derivedFrom: [] })])
  const after = snapshotFilesystem()
  expect(after.flushedWritesSucceeded).toBe(before.flushedWritesSucceeded + 2)
  expect(after.renameSucceeded).toBe(before.renameSucceeded + 2)
  expect(after.explicitSyncSucceeded).toBe(before.explicitSyncSucceeded + 2)
})
it('includes the real sibling initialization lock but excludes unrelated workspace files', async () => {
  await fixture()
  const root = roots.at(-1)!, before = snapshotFilesystem()
  await withDirectoryLock(join(root, 'workflows.prototype-init.lock'), async () => {})
  await writeFile(join(root, 'unrelated.txt'), 'not checkpoint storage', { flush: true })
  const after = snapshotFilesystem()
  expect(after.lockDirectoriesCreated).toBe(1)
  expect(after.handleWriteCalls).toBe(1)
  expect(after.handleWrittenBytes).toBeGreaterThan(0)
  expect(after.explicitSyncSucceeded).toBeGreaterThan(before.explicitSyncSucceeded)
  expect(after.flushedWritesSucceeded).toBe(before.flushedWritesSucceeded)
})
