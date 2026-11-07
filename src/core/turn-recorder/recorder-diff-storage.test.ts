import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeTurnDiffSnapshot, type TurnDiffSnapshot } from '../../shared/trace'
import { readRecorderContent } from './content-store'
import { writeJsonAtomic } from './io'
import { persistTurnDiffContent } from './recorder-turn-state'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const snapshot = (patch: string): TurnDiffSnapshot => ({
  version: 1, status: 'captured', beforeAt: '2026-11-05T00:00:00.000Z',
  afterAt: '2026-11-05T00:00:01.000Z', captureMs: 1, cleanup: 'ok',
  files: [{ path: '/repo/file.txt', added: 1, deleted: 1, patch, patchStatus: 'captured' }]
})

describe('recorder diff inline storage', () => {
  it('persists one complete Unicode body and its reference without mutating the Git snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-diff-storage-'))
    roots.push(root)
    // Larger than the shared parser's 1.1M-character limit on the legacy patch field.
    const patch = '@@ -1 +1 @@\n-old\n+' + '正文😀'.repeat(300_000) + '\n+END-OF-PATCH\n'
    const source = snapshot(patch)
    const [stored] = await persistTurnDiffContent(root, [source])
    const path = join(root, 'snapshot.json')
    await writeJsonAtomic(path, stored)
    const bytes = await readFile(path)
    const decoded = JSON.parse(bytes.toString('utf8')) as TurnDiffSnapshot
    const file = decoded.files[0]

    expect(file).not.toHaveProperty('patch')
    expect(file.patchContent).toMatchObject({
      content: patch, savedBytes: Buffer.byteLength(patch), storage: 'complete',
      sourceCompleteness: 'complete', source: 'git_turn_diff', reasons: []
    })
    expect(file.patchStatus).toBe('captured')
    await expect(readRecorderContent(root, file.patchContent!.contentRef!)).resolves.toBe(patch)
    expect(normalizeTurnDiffSnapshot(decoded)?.files[0].patchContent?.content).toBe(patch)
    expect(source.files[0].patch).toBe(patch)
    expect(source.files[0]).not.toHaveProperty('patchContent')

    // Compare the exact saved bytes with the former two-inline-body shape, not a size estimate.
    const legacy = { ...decoded, files: [{ ...file, patch }] }
    const legacyBytes = Buffer.byteLength(`${JSON.stringify(legacy)}\n`)
    expect(legacyBytes - bytes.length).toBe(Buffer.byteLength(`,"patch":${JSON.stringify(patch)}`))
    expect(normalizeTurnDiffSnapshot(legacy)?.files[0].patchContent?.content).toBe(patch)
  })

  it('leaves binary, unavailable and empty patches unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-diff-storage-'))
    roots.push(root)
    const source: TurnDiffSnapshot = { ...snapshot(''), files: [
      { path: '/repo/binary', added: 0, deleted: 0, binary: true, patchStatus: 'binary' },
      { path: '/repo/missing', added: 1, deleted: 0, patchStatus: 'unavailable', patchReason: 'git_error' },
      { path: '/repo/empty', added: 0, deleted: 0, patch: '' }
    ] }
    expect(await persistTurnDiffContent(root, [source])).toEqual([source])
  })
})
