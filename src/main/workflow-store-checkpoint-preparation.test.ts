import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})
import { rename, writeFile } from 'node:fs/promises'
import { FileWorkflowStore } from './workflow-store'
import type { WorkflowControlFrame } from '../shared/workflow'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('prepares frame bytes while the value is held, but publishes the value before the frame', async ({ onTestFinished }) => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'scry-checkpoint-preparation-'))
  roots.push(root)
  const store = new FileWorkflowStore(root)
  const frame: Omit<WorkflowControlFrame, 'revision'> = { schemaVersion: 1, workflowId: 'flow', programRevision: 'program', frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'entered' }
  const initial = await store.saveFrame(frame, 0)
  let releaseValue!: () => void, prepared!: () => void
  const held = new Promise<void>(resolve => { releaseValue = resolve })
  const framePrepared = new Promise<void>(resolve => { prepared = resolve })
  let valuePublished = false, acknowledged = false
  onTestFinished(() => releaseValue())
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    const body = String(args[1])
    if (body.includes('"state":"known"')) await held
    await actual.writeFile(...args)
    if (body.includes('"phase":"completed"')) prepared()
  })
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (String(args[1]).endsWith('.frame.json') && !valuePublished) throw new Error('frame published before its value')
    await actual.rename(...args)
    if (String(args[1]).endsWith('.value.json')) valuePublished = true
  })
  const checkpoint = store.saveFrameWithValue({ ...initial, phase: 'completed' }, initial.revision,
    { field: 'resultRef', key: 'result', evaluation: { state: 'known', value: 'durable', derivedFrom: [] } }).then(value => { acknowledged = true; return value })
  void checkpoint.catch(() => {})
  try {
    await framePrepared
    expect(acknowledged).toBe(false)
    expect(valuePublished).toBe(false)
    expect((await new FileWorkflowStore(root).loadFrame('flow', 'node'))!.phase).toBe('entered')
    expect((await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.value.json'))).toEqual([])
    releaseValue()
    const completed = await checkpoint
    expect(valuePublished).toBe(true)
    expect(await new FileWorkflowStore(root).loadValue('flow', completed.resultRef!)).toMatchObject({ value: 'durable' })
    expect(acknowledged).toBe(true)
  } finally {
    releaseValue()
    await checkpoint.catch(() => {})
    vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
    vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  }
})
