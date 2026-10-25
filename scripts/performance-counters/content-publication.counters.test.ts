import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import type { ToolContentRef } from '../../src/shared/tool-content'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const meter = vi.hoisted(() => ({
  active: false,
  counts: { hashes: 0, reads: 0, mkdirs: 0, stats: 0, opens: 0, syncs: 0, writes: 0, links: 0, removes: 0 },
  syncOrder: [] as Array<{ kind: 'directory' | 'file'; path: string }>
}))

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => {
    if (meter.active && args[0] === 'sha256') meter.counts.hashes++
    return actual.createHash(...args)
  } }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (meter.active) meter.counts.reads++
      return actual.readFile(...args)
    },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (meter.active) meter.counts.mkdirs++
      return actual.mkdir(...args)
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (meter.active) meter.counts.stats++
      return actual.stat(...args)
    },
    link: (...args: Parameters<typeof actual.link>) => {
      if (meter.active) meter.counts.links++
      return actual.link(...args)
    },
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (meter.active) meter.counts.removes++
      return actual.rm(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (meter.active) meter.counts.opens++
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      const write = handle.writeFile.bind(handle)
      handle.sync = () => {
        if (meter.active) {
          meter.counts.syncs++
          meter.syncOrder.push(args[1] === 'r'
            ? { kind: 'directory', path: String(args[0]) }
            : { kind: 'file', path: dirname(String(args[0])) })
        }
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

const bodies = Array.from({ length: 4 }, (_, index) => `${index}:` + 'x'.repeat(256 * 1024 - 2))
const scenarios = ['recorder.content-cold', 'recorder.content-dual'] as const
const samples: Record<string, Array<Record<string, number>>> = Object.fromEntries(scenarios.map(s => [s, []]))
const timing: Record<string, { workload: string; durationMs: number[] }> = Object.fromEntries(scenarios.map(s => [s, {
  workload: `new-bodies=4;body-bytes=262144;authorities=${s.endsWith('dual') ? 2 : 1};initial-publication=included;sync=unchanged`,
  durationMs: []
}]))
let writeContent: typeof import('../../src/core/turn-recorder/content-store').writeRecorderContent
let persistTrace: typeof import('../../src/main/trace-tool-content').persistTraceToolEvents

function reset(): void {
  meter.counts = { hashes: 0, reads: 0, mkdirs: 0, stats: 0, opens: 0, syncs: 0, writes: 0, links: 0, removes: 0 }
  meter.syncOrder = []
}

function counters(): Record<string, number> {
  const c = meter.counts
  return {
    'crypto.sha256.calls': c.hashes, 'io.read.calls': c.reads,
    'io.mkdir.calls': c.mkdirs, 'io.stat.calls': c.stats,
    'io.directory.metadata.calls': c.mkdirs + c.stats,
    'io.open.calls': c.opens, 'io.sync.calls': c.syncs,
    'io.write.calls': c.writes, 'io.link.calls': c.links, 'io.rm.calls': c.removes
  }
}

function publicationSyncs(directory: string): typeof meter.syncOrder {
  const absolute = resolve(directory)
  let current = parse(absolute).root
  const result: typeof meter.syncOrder = []
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    result.push({ kind: 'directory', path: current })
    current = join(current, part)
  }
  return [...result, { kind: 'file', path: directory },
    { kind: 'directory', path: directory }, { kind: 'directory', path: directory }]
}

async function verifyBody(root: string, ref: ToolContentRef, body: string): Promise<string> {
  const path = join(root, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
  const bytes = await readFile(path)
  expect(bytes.toString('utf8')).toBe(body)
  expect(bytes.length).toBe(ref.bytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256)
  return dirname(path)
}

describe('cold and dual-authority durable publication', () => {
  beforeAll(async () => {
    writeContent = (await import('../../src/core/turn-recorder/content-store')).writeRecorderContent
    persistTrace = (await import('../../src/main/trace-tool-content')).persistTraceToolEvents
  })

  for (const scenario of scenarios) {
    it.each(Array.from({ length: defaultRepeats }, (_, index) => index))(`${scenario} keeps complete independent evidence (sample %i)`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'scry-content-publish-'))
      const recorder = join(root, 'workspace', '.scry')
      const userData = join(root, 'user-data')
      const cwd = '/fixed/performance-workspace'
      const refs: ToolContentRef[] = []
      const boundedEvents: TraceEvent[] = []
      try {
        reset()
        meter.active = true
        const started = performance.now()
        try {
          if (scenario.endsWith('dual')) {
            const events: TraceEvent[] = bodies.map((body, index) => ({
              id: `result-${index}`, runId: 'run', ts: '2026-10-25T00:00:00.000Z',
              kind: 'tool', stage: 'tool_result', toolUseId: `call-${index}`, output: body, text: body
            }))
            const bounded = await persistTrace(userData, cwd, events, recorder)
            refs.push(...bounded.map(event => event.outputContent!.contentRef!))
            boundedEvents.push(...bounded)
          } else {
            for (const body of bodies) refs.push(await writeContent(recorder, body, 'utf8'))
          }
        } finally {
          timing[scenario].durationMs.push(performance.now() - started)
          meter.active = false
        }
        // The existing trace contract bounds each event, not the aggregate of four events.
        for (const event of boundedEvents) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(32 * 1024)
        const expectedSyncs: typeof meter.syncOrder = []
        for (const [index, ref] of refs.entries()) {
          if (scenario.endsWith('dual')) {
            const appRoot = join(userData, 'trace-content-v1', createHash('sha256').update(cwd).digest('hex'))
            expectedSyncs.push(...publicationSyncs(await verifyBody(appRoot, ref, bodies[index])))
          }
          expectedSyncs.push(...publicationSyncs(await verifyBody(recorder, ref, bodies[index])))
        }
        expect(refs).toHaveLength(4)
        expect(meter.syncOrder).toEqual(expectedSyncs)
        const publications = scenario.endsWith('dual') ? 8 : 4
        expect(counters()).toMatchObject({ 'io.write.calls': publications, 'io.link.calls': publications, 'io.rm.calls': publications })
        samples[scenario].push(counters())
      } finally {
        meter.active = false
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('detects additional real directory metadata and sync work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-publication-sensitivity-'))
    try {
      reset()
      meter.active = true
      await mkdir(join(root, 'child'))
      await stat(root)
      const directory = await open(root, 'r')
      try { await directory.sync() } finally { await directory.close() }
      expect(counters()).toMatchObject({ 'io.directory.metadata.calls': 2, 'io.mkdir.calls': 1, 'io.stat.calls': 1, 'io.sync.calls': 1 })
    } finally {
      meter.active = false
      await rm(root, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    const observations = []
    for (const scenario of scenarios) {
      expect(samples[scenario]).toHaveLength(defaultRepeats)
      const runs = await repeatCounters(defaultRepeats, index => samples[scenario][index])
      observations.push(...Object.entries(runs).map(([metric, values]) => measured({
        scenario, metric, layer: 'io', unit: 'count', workload: timing[scenario].workload,
        source: 'real cold publication; actual trace dual-authority caller; pass-through crypto/fs/FileHandle counters'
      }, values)))
    }
    writeCollector('content-publication', observations)
    if (process.env.SCRY_CONTENT_PUBLICATION_TIMINGS) writeFileSync(process.env.SCRY_CONTENT_PUBLICATION_TIMINGS, JSON.stringify(timing, null, 2))
  })
})
