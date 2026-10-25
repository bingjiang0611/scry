import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const meter = vi.hoisted(() => ({
  active: false,
  counts: { hashes: 0, reads: 0, readBytes: 0, opens: 0, syncs: 0, writes: 0 }
}))

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      if (meter.active && args[0] === 'sha256') meter.counts.hashes++
      return actual.createHash(...args)
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (meter.active) meter.counts.reads++
      const result = await actual.readFile(...args)
      if (meter.active) meter.counts.readBytes += Buffer.byteLength(result)
      return result
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (meter.active) meter.counts.opens++
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      const write = handle.writeFile.bind(handle)
      handle.sync = () => {
        if (meter.active) meter.counts.syncs++
        return sync()
      }
      handle.writeFile = (...args: Parameters<typeof handle.writeFile>) => {
        if (meter.active) meter.counts.writes++
        return write(...args)
      }
      return handle
    }
  }
})

const bodyBytes = 256 * 1024
const bodies = Array.from({ length: 4 }, (_, index) => `${index}:` + 'x'.repeat(bodyBytes - 2))
const workload = 'durable-bodies=4;body-bytes=262144;reuse-passes=8;file-and-directory-sync=unchanged'
const samples: Array<Record<string, number>> = []
const durationMs: number[] = []
let writeContent: typeof import('../../src/core/turn-recorder/content-store').writeRecorderContent

function reset(): void {
  meter.counts = { hashes: 0, reads: 0, readBytes: 0, opens: 0, syncs: 0, writes: 0 }
}

function counters(): Record<string, number> {
  return {
    'crypto.sha256.calls': meter.counts.hashes,
    'io.read.calls': meter.counts.reads,
    'io.read.bytes': meter.counts.readBytes,
    'io.open.calls': meter.counts.opens,
    'io.sync.calls': meter.counts.syncs,
    'io.write.calls': meter.counts.writes
  }
}

describe('durable recorder content reuse work', () => {
  beforeAll(async () => {
    writeContent = (await import('../../src/core/turn-recorder/content-store')).writeRecorderContent
  })

  it.each(Array.from({ length: defaultRepeats }, (_, index) => index))('keeps complete bodies and durability (sample %i)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-content-reuse-'))
    try {
      // This is explicitly a reuse workload. Initial publication is outside its timing boundary.
      const expected = []
      for (const body of bodies) expected.push(await writeContent(root, body, 'utf8'))
      const actual = []
      reset()
      meter.active = true
      const started = performance.now()
      try {
        for (let pass = 0; pass < 8; pass++) {
          for (const body of bodies) actual.push(await writeContent(root, body, 'utf8'))
        }
      } finally {
        durationMs.push(performance.now() - started)
        meter.active = false
      }
      expect(actual).toEqual(Array.from({ length: 8 }, () => expected).flat())
      expect(counters()).toMatchObject({
        'io.read.calls': 32, 'io.read.bytes': 32 * bodyBytes,
        'io.open.calls': 32, 'io.sync.calls': 32, 'io.write.calls': 0
      })
      for (const [index, ref] of expected.entries()) {
        const bytes = await readFile(join(root, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`))
        expect(bytes.toString()).toBe(bodies[index])
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256)
      }
      samples.push(counters())
    } finally {
      meter.active = false
      await rm(root, { recursive: true, force: true })
    }
  })

  it('observes an extra real hash and directory sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-content-sensitivity-'))
    try {
      const ref = await writeContent(root, bodies[0], 'utf8')
      reset()
      meter.active = true
      await writeContent(root, bodies[0], 'utf8')
      const before = { ...meter.counts }
      createHash('sha256').update(bodies[0]).digest('hex')
      const directory = dirname(join(root, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`))
      const handle = await open(directory, 'r')
      try { await handle.sync() } finally { await handle.close() }
      expect(meter.counts.hashes).toBe(before.hashes + 1)
      expect(meter.counts.syncs).toBe(before.syncs + 1)
    } finally {
      meter.active = false
      await rm(root, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    expect(samples).toHaveLength(defaultRepeats)
    const runs = await repeatCounters(defaultRepeats, index => samples[index])
    writeCollector('content-reuse', Object.entries(runs).map(([metric, values]) => measured({
      scenario: 'recorder.content-reuse', metric, layer: 'io',
      unit: metric.endsWith('.bytes') ? 'bytes' : 'count', workload,
      source: 'real existing content publication; pass-through SHA256/read/open/FileHandle sync/write counters'
    }, values)))
    if (process.env.SCRY_CONTENT_REUSE_TIMINGS) writeFileSync(process.env.SCRY_CONTENT_REUSE_TIMINGS,
      JSON.stringify({ workload, durationMs, counters: runs }, null, 2))
  })
})
