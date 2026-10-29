import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import { LiveTraceIngestion } from './live-trace-ingestion'
import { setPerformanceRecordingSink, type PerformanceSample } from './performance-timing'
import { persistTraceToolEvents, readAppTraceContentPage, TRACE_TOOL_CONTENT_POLICY } from './trace-tool-content'

const tool: TraceEvent = {
  id: 'tool-result', runId: 'run', ts: '', kind: 'tool', stage: 'tool_result', toolUseId: 'call',
  text: 'large tool body '.repeat(2_000)
}
const text: TraceEvent = { id: 'text', runId: 'run', ts: '', kind: 'model', stage: 'text_delta', text: 'next answer' }
const ended: TraceEvent = { id: 'ended', runId: 'run', ts: '', kind: 'harness', stage: 'runtime:provider_ended' }
const bounded = sanitizeToolEvents([tool], TRACE_TOOL_CONTENT_POLICY, 'live_renderer')[0]

describe('live trace ingestion', () => {
  it('delivers ordered tool/text/terminal projections before disk finishes, then enriches the same event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-live-ingestion-'))
    let release!: () => void
    const disk = new Promise<void>((resolve) => { release = resolve })
    const published: TraceEvent[] = []
    let owned = tool
    const queue = new LiveTraceIngestion({
      provider: 'pi', publish: (event) => { published.push(event) },
      persist: async (event) => {
        await disk
        return (await persistTraceToolEvents(root, '/fixture', [event]))[0]
      },
      onPersisted: (event) => { owned = event }, onError: (error) => { throw error }
    })
    try {
      queue.enqueue(tool, bounded)
      queue.enqueue(text, text)
      queue.enqueue(ended, ended)
      let settled = false
      const done = queue.idle().then(() => { settled = true })
      await queue.liveIdle()
      expect(published.map((event) => event.id)).toEqual(['tool-result', 'text', 'ended'])
      expect(published[0].outputContent?.contentRef).toBeUndefined()
      // Result text/output aliases both carry the preview; the contract bounds each field.
      expect(published[0].outputContent?.savedBytes).toBeLessThanOrEqual(TRACE_TOOL_CONTENT_POLICY.toolContentFieldBytes)
      expect(published[0].outputContent?.storage).toBe('truncated')
      expect(owned).toBe(tool)
      expect(settled).toBe(false)
      release()
      await done
      expect(published.map((event) => event.id)).toEqual(['tool-result', 'text', 'ended', 'tool-result'])
      const ref = owned.outputContent!.contentRef!
      const page = await readAppTraceContentPage(root, '/fixture', { source: 'app-trace', ref })
      expect(Buffer.from(page.dataBase64, 'base64').toString('utf8')).toBe(tool.text)
      expect(published[3].outputContent?.contentRef).toEqual(ref)
    } finally {
      release()
      await queue.idle()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('separates queue wait from durable content service time', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink((sample) => { samples.push(sample) })
    const queue = new LiveTraceIngestion({
      provider: 'pi',
      publish: () => undefined,
      persist: async (event) => event,
      onPersisted: () => undefined,
      onError: (error) => { throw error }
    })
    try {
      queue.enqueue(tool, bounded)
      await queue.idle()
    } finally {
      setPerformanceRecordingSink(null)
    }
    expect(samples).toHaveLength(1)
    expect(samples[0].checkpoints.map((checkpoint) => checkpoint.stage))
      .toEqual(['queue_drained', 'content_persisted'])
  })

  it('persists eight events concurrently but publishes enrichment in Provider order', async () => {
    const started: string[] = []
    const persisted: string[] = []
    const releases = new Map<string, () => void>()
    const queue = new LiveTraceIngestion({
      provider: 'pi',
      publish: () => undefined,
      persist: (event) => new Promise<TraceEvent>((resolve) => {
        started.push(event.id)
        releases.set(event.id, () => resolve(event))
      }),
      onPersisted: (event) => { persisted.push(event.id) },
      onError: (error) => { throw error }
    })
    const events = Array.from({ length: 9 }, (_, index) => ({
      ...tool,
      id: `tool-${index}`,
      toolUseId: `call-${index}`
    }))
    for (const event of events) queue.enqueue(event, event)
    await setImmediate()
    expect(started).toEqual(Array.from({ length: 8 }, (_, index) => `tool-${index}`))

    for (let index = 1; index < 8; index++) releases.get(`tool-${index}`)!()
    await setImmediate()
    expect(persisted).toEqual([])
    expect(started).not.toContain('tool-8')

    releases.get('tool-0')!()
    await setImmediate()
    expect(started).toEqual(Array.from({ length: 9 }, (_, index) => `tool-${index}`))
    expect(persisted).toEqual(Array.from({ length: 8 }, (_, index) => `tool-${index}`))
    releases.get('tool-8')!()
    await queue.idle()
    expect(persisted).toEqual(events.map((event) => event.id))
  })

  it('keeps raw evidence and live ordering on disk failure and still drains later tool writes', async () => {
    const published: TraceEvent[] = []
    const onPersisted = vi.fn()
    const onError = vi.fn()
    const second = { ...tool, id: 'second', text: 'small' }
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk failure')).mockResolvedValueOnce(second)
    const queue = new LiveTraceIngestion({ provider: 'pi', publish: (event) => { published.push(event) }, persist, onPersisted, onError })
    queue.enqueue(tool, bounded)
    queue.enqueue(text, text)
    queue.enqueue(second, second)
    await queue.idle()
    expect(persist.mock.calls.map(([event]) => event.id)).toEqual(['tool-result', 'second'])
    expect(onPersisted.mock.calls.map(([event]) => event.id)).toEqual(['second'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(published.map((event) => event.id)).toEqual(['tool-result', 'text', 'second', 'second'])
    expect(tool.text!.length).toBeGreaterThan(bounded.text!.length)
    expect(tool.outputContent).toBeUndefined()
  })
})
