import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Evidence } from '../shared/turn-record'
import { transcriptPath } from '../main/transcript-archive-paths'
import { observeNativeRunTranscript } from './orchestration-run-transcript'

const rewrite = vi.hoisted(() => ({ path: '', bytes: '', injected: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      if (args[0] === rewrite.path && !rewrite.injected) {
        const read = file.read.bind(file)
        Object.defineProperty(file, 'read', {
          async value(buffer: Buffer, offset: number, length: number, position: number) {
            const result = await read(buffer, offset, length, position)
            if (!rewrite.injected) {
              rewrite.injected = true
              await actual.writeFile(rewrite.path, rewrite.bytes)
              await actual.utimes(rewrite.path, 1, 1)
            }
            return result
          }
        })
      }
      return file
    }
  }
})

vi.mock('../host-runtime/orchestration/transcript-interval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-runtime/orchestration/transcript-interval')>()
  return {
    ...actual,
    readTranscriptExtent: async (...args: Parameters<typeof actual.readTranscriptExtent>) => {
      const extent = await actual.readTranscriptExtent(...args)
      return extent ? { ...extent, birthtimeNs: 0n } : undefined
    }
  }
})

it.each(['new', 'preexisting', 'undated', 'rewritten'] as const)('uses identity and transcript time with zero birthtime: %s', async mode => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scry-transcript-birthtime-')))
  const cwd = join(home, 'workspace')
  const sessionId = 'bb91df54-79c3-43e5-bead-f3df063d34fa'
  const startedAt = Date.now() - 5_000
  const evidence: Array<Promise<Evidence<string>>> = []
  try {
    await mkdir(cwd)
    const file = transcriptPath(cwd, sessionId, home)
    await mkdir(dirname(file), { recursive: true })
    const row = (at: number | undefined) => JSON.stringify({
      cwd, sessionId, type: 'user', ...(at === undefined ? {} : { timestamp: new Date(at).toISOString() }),
      message: { role: 'user', content: 'transcript fixture' }
    }) + '\n'
    const first = row(mode === 'undated' ? undefined : startedAt + (mode === 'preexisting' ? -1_000 : 1_000))
    const next = row(startedAt + 2_000)
    const content = first + next
    if (mode === 'preexisting') await writeFile(file, first)
    vi.spyOn(Date, 'now').mockReturnValueOnce(startedAt)
    const finish = await observeNativeRunTranscript(home, { runId: 'run', providerId: 'claude', cwd },
      transcript => evidence.push(transcript), message => { throw new Error(message) })
    if (mode === 'preexisting') await appendFile(file, next)
    else await writeFile(file, content)
    if (mode === 'rewritten') {
      rewrite.path = file
      rewrite.bytes = row(startedAt - 1_000) + next
      expect(Buffer.byteLength(rewrite.bytes)).toBe(Buffer.byteLength(content))
    }
    await finish(sessionId)
    expect(evidence).toHaveLength(1)
    if (mode === 'new') {
      expect(await evidence[0]).toMatchObject({
        status: 'available', quality: 'inferred',
        value: expect.stringContaining(`#bytes=0-${Buffer.byteLength(content)},sha256=`)
      })
    } else {
      expect(await evidence[0]).toMatchObject({ status: 'unavailable', omissionReason: 'transcript_frontier_unavailable' })
      if (mode === 'rewritten') expect(rewrite.injected).toBe(true)
    }
  } finally {
    rewrite.path = ''
    rewrite.injected = false
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  }
})
