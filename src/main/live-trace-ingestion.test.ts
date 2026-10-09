import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import { LiveTraceIngestion } from './live-trace-ingestion'
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
