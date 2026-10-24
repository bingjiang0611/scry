import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, open, rename, rm, symlink, truncate, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiSessionProof } from './pi-session-proof'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const header = JSON.stringify({ type: 'session', id: 'session' }) + '\n'
const entry = (text = '你好', id = 'new') => JSON.stringify({ type: 'message', id, message: { role: 'user', content: text } }) + '\n'
async function fixture(initial: string | undefined = header) {
  const directory = await mkdtemp(join(tmpdir(), 'scry-pi-proof-unit-'))
  directories.push(directory)
  const path = join(directory, 'session.jsonl')
  if (initial !== undefined) await writeFile(path, initial)
  return { path, capture: () => PiSessionProof.capture(path, 'session', '你好', 0) }
}

describe('bounded incremental Pi session proof', () => {
  it('does not reuse a matching historical user entry as evidence for a new dispatch', async () => {
    const { path, capture } = await fixture(header + entry())
    const proof = await capture()
    expect(await proof.verify('new')).toEqual({ status: 'pending' })
    await appendFile(path, entry('你好', 'fresh'))
    expect(await proof.verify('fresh')).toEqual({ status: 'matched' })
  })

  it('retains partial UTF-8/JSONL bytes and does not reread the history between snapshots', async () => {
    const { path, capture } = await fixture(header + JSON.stringify({ type: 'custom', padding: 'x'.repeat(1024 * 1024) }) + '\n')
    const inspection = await open(path, 'r')
    const baseline = (await inspection.stat()).size
    const prototype = Object.getPrototypeOf(inspection) as FileHandle
    await inspection.close()
    const reads = vi.spyOn(prototype, 'read')
    const proof = await capture()
    const bytes = Buffer.from(entry())
    const split = bytes.indexOf(Buffer.from('你')) + 1
    await appendFile(path, bytes.subarray(0, split))
    expect(await proof.verify('new')).toEqual({ status: 'pending' })
    await appendFile(path, bytes.subarray(split))
    // Later, incomplete records must not invalidate the already complete target row.
    await appendFile(path, '{"type":"message"')
    expect(await proof.verify('new')).toEqual({ status: 'matched' })
    const positions = reads.mock.calls.map(args => (args as unknown as [Buffer, number, number, number])[3])
    expect(positions).toEqual([baseline - 1, 0, baseline, baseline + split])
    const results = await Promise.all(reads.mock.results.map(result => result.value))
    expect(results.reduce((sum, result) => sum + result.bytesRead, 0)).toBeLessThan(70 * 1024)
  })

  it('accepts a newly persisted session but not a different session header', async () => {
    const { path, capture } = await fixture()
    await rm(path)
    const proof = await capture()
    expect(await proof.verify('new')).toEqual({ status: 'pending' })
    await writeFile(path, header + entry())
    expect(await proof.verify('new')).toEqual({ status: 'matched' })
    const wrong = await fixture(header.replace('"session"}', '"wrong"}'))
    const wrongProof = await wrong.capture()
    await appendFile(wrong.path, entry())
    expect(await wrongProof.verify('new')).toEqual({ status: 'pending' })
  })

  it.each(['replace', 'truncate', 'symlink'] as const)('reports unavailable when the frozen file is changed: %s', async mode => {
    const { path, capture } = await fixture(header + entry('old', 'old'))
    const proof = await capture()
    if (mode === 'truncate') await truncate(path, 1)
    else {
      await rename(path, path + '.old')
      if (mode === 'replace') await writeFile(path, header + entry())
      else await symlink(path + '.old', path)
    }
    expect(await proof.verify('new')).toMatchObject({ status: 'unavailable', reason: expect.any(String) })
  })

  it('does not call malformed or oversized headers a missing native user message', async () => {
    for (const initial of ['broken\n', JSON.stringify({ type: 'session', id: 'session', padding: 'x'.repeat(65536) }) + '\n']) {
      const { path, capture } = await fixture(initial)
      const proof = await capture()
      await appendFile(path, entry())
      expect(await proof.verify('new')).toMatchObject({ status: 'unavailable' })
    }
  })

  it('bounds newly appended bytes independently of total session size', async () => {
    const { path, capture } = await fixture()
    const proof = await capture()
    const file = await open(path, 'a')
    try {
      const chunk = Buffer.from((JSON.stringify({ type: 'custom', padding: 'x'.repeat(1024) }) + '\n').repeat(1024))
      for (let i = 0; i < 128; i++) await file.write(chunk)
      await file.write(entry())
    } finally { await file.close() }
    expect(await proof.verify('new')).toEqual({ status: 'unavailable', reason: 'Pi 本轮新增记录超过 128MiB，输入回执尚未校验' })
  })
})
