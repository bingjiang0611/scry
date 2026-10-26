import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeRecorderContentCopies, readRecorderContent } from '../core/turn-recorder/content-store'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import type { TraceEvent } from '../shared/trace'
import { LiveTraceIngestion } from './live-trace-ingestion'
import { persistTraceToolEvents, TRACE_TOOL_CONTENT_POLICY } from './trace-tool-content'

const probe = vi.hoisted(() => ({
  syncs: [] as string[],
  links: [] as string[],
  failPath: '',
  failOrdinal: 1,
  failFileRoot: '',
  racePath: '',
  raceContent: '',
  hold: null as null | { path: string; ordinal: number; entered: () => void; released: Promise<void> }
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        const path = String(args[0])
        probe.syncs.push(path)
        const ordinal = probe.syncs.filter(value => value === path).length
        if ((path === probe.failPath && ordinal === probe.failOrdinal) ||
            (args[1] === 'wx' && probe.failFileRoot && path.startsWith(probe.failFileRoot))) {
          throw new Error('injected sync failure')
        }
        const hold = probe.hold
        if (hold && path === hold.path && ordinal === hold.ordinal) {
          hold.entered()
          await hold.released
        }
        await sync()
      }
      return handle
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const path = String(args[1])
      if (path === probe.racePath) {
        probe.racePath = ''
        // A separate publisher completes its bytes before winning the final name.
        const competing = await actual.open(path, 'wx', 0o600)
        try { await competing.writeFile(probe.raceContent); await competing.sync() } finally { await competing.close() }
      }
      await actual.link(...args)
      probe.links.push(path)
    }
  }
})

const roots: string[] = []
const content = 'complete dual-authority body '.repeat(2_000)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const pathFor = (root: string) => join(root, 'content', 'sha256', hash(content).slice(0, 2), hash(content) + '.bin')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-content-copies-'))
  roots.push(root)
  const userData = join(root, 'app')
  const app = join(userData, 'trace-content-v1', hash('/fixture'))
  const recorder = join(root, 'recorder')
  return { root, userData, app, recorder, copies: [app, recorder] as [string, string] }
}

afterEach(async () => {
  probe.syncs = []
  probe.links = []
  probe.failPath = probe.failFileRoot = probe.racePath = probe.raceContent = ''
  probe.failOrdinal = 1
  probe.hold = null
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('one-event dual-authority publication', () => {
  it('prepares a shared parent once, retains both complete copies, and does not cache across operations', async () => {
    const { root, copies } = await fixture()
    const ref = await writeRecorderContentCopies(copies, content, 'utf8')
    expect(probe.syncs.filter(path => path === root)).toHaveLength(1)
    expect(probe.links).toEqual(copies.map(pathFor))
    for (const copy of copies) expect(await readRecorderContent(copy, ref)).toBe(content)
    await writeRecorderContentCopies(copies, content + ' next', 'utf8')
    expect(probe.syncs.filter(path => path === root)).toHaveLength(2)
  })

  it('publishes no file after a failed preparation and retries every required barrier', async () => {
    const { root, copies } = await fixture()
    probe.failPath = root
    await expect(writeRecorderContentCopies(copies, content, 'utf8')).rejects.toThrow('injected sync failure')
    expect(probe.links).toEqual([])
    probe.failPath = ''
    const ref = await writeRecorderContentCopies(copies, content, 'utf8')
    expect(probe.syncs.filter(path => path === root)).toHaveLength(2)
    for (const copy of copies) expect(await readRecorderContent(copy, ref)).toBe(content)
  })

  it.each(['file', 'publish', 'cleanup'] as const)('rejects a second-authority %s sync failure without reporting a durable event', async (stage) => {
    const { userData, app, recorder, copies } = await fixture()
    if (stage === 'file') probe.failFileRoot = recorder
    else { probe.failPath = dirname(pathFor(recorder)); probe.failOrdinal = stage === 'publish' ? 1 : 2 }
    const tool: TraceEvent = { id: 'tool', runId: 'run', ts: '', kind: 'tool', stage: 'tool_result', text: content }
    const published: TraceEvent[] = []
    const onPersisted = vi.fn()
    const onError = vi.fn()
    const queue = new LiveTraceIngestion({ provider: 'pi', publish: event => { published.push(event) },
      persist: async event => (await persistTraceToolEvents(userData, '/fixture', [event], recorder))[0], onPersisted, onError })
    queue.enqueue(tool, sanitizeToolEvents([tool], TRACE_TOOL_CONTENT_POLICY, 'live_renderer')[0])
    await queue.idle()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toContain('injected sync failure')
    expect(onPersisted).not.toHaveBeenCalled()
    expect(published).toHaveLength(1)
    expect(published[0].outputContent?.contentRef).toBeUndefined()
    expect(tool.text).toBe(content)
    expect(await readFile(pathFor(app), 'utf8')).toBe(content)
    probe.failPath = probe.failFileRoot = ''
    const ref = await writeRecorderContentCopies(copies, content, 'utf8')
    for (const copy of copies) expect(await readRecorderContent(copy, ref)).toBe(content)
  })

  it('withholds the persisted enrichment until the second cleanup barrier finishes', async () => {
    const { userData, recorder } = await fixture()
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    probe.hold = { path: dirname(pathFor(recorder)), ordinal: 2, entered, released }
    const tool: TraceEvent = { id: 'tool', runId: 'run', ts: '', kind: 'tool', stage: 'tool_result', text: content }
    const published: TraceEvent[] = []
    const onPersisted = vi.fn()
    const onError = vi.fn()
    const queue = new LiveTraceIngestion({ provider: 'pi', publish: event => { published.push(event) },
      persist: async event => (await persistTraceToolEvents(userData, '/fixture', [event], recorder))[0], onPersisted, onError })
    try {
      queue.enqueue(tool, sanitizeToolEvents([tool], TRACE_TOOL_CONTENT_POLICY, 'live_renderer')[0])
      await Promise.race([reached, queue.idle().then(() => { throw new Error('persisted before the second cleanup barrier') })])
      expect(onPersisted).not.toHaveBeenCalled()
      expect(published).toHaveLength(1)
      expect(published[0].outputContent?.contentRef).toBeUndefined()
      release()
      await queue.idle()
      expect(onPersisted).toHaveBeenCalledOnce()
      expect(published).toHaveLength(2)
      expect(await readRecorderContent(recorder, published[1].outputContent!.contentRef!)).toBe(content)
      expect(onError).not.toHaveBeenCalled()
    } finally { release(); await queue.idle() }
  })

  it.each([false, true])('verifies a racing publisher rather than treating EEXIST as success (corrupt=%s)', async (corrupt) => {
    const { recorder, copies } = await fixture()
    probe.racePath = pathFor(recorder)
    probe.raceContent = corrupt ? 'x'.repeat(Buffer.byteLength(content)) : content
    if (corrupt) await expect(writeRecorderContentCopies(copies, content, 'utf8')).rejects.toThrow('collision or corruption')
    else {
      const ref = await writeRecorderContentCopies(copies, content, 'utf8')
      for (const copy of copies) expect(await readRecorderContent(copy, ref)).toBe(content)
    }
    expect(probe.racePath).toBe('')
    expect(await readFile(pathFor(recorder), 'utf8')).toBe(probe.raceContent)
  })

  it('rejects same-length corruption in an existing authority without overwriting evidence', async () => {
    const { recorder, copies } = await fixture()
    await writeRecorderContentCopies(copies, content, 'utf8')
    const corrupt = 'x'.repeat(Buffer.byteLength(content))
    await writeFile(pathFor(recorder), corrupt)
    await expect(writeRecorderContentCopies(copies, content, 'utf8')).rejects.toThrow('collision or corruption')
    expect(await readFile(pathFor(recorder), 'utf8')).toBe(corrupt)
  })
})
