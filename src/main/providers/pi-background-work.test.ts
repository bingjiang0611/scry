import { describe, expect, it } from 'vitest'
import { PiBackgroundWork } from './pi-background-work'

function widget(state: string, generatedAt = 1, id = 'child') {
  return {
    type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async',
    widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt,
      runs: [{ id, kind: 'subagent', label: 'worker', state }]
    })]
  }
}

const notify = { type: 'message_end', message: { role: 'custom', customType: 'subagent-notify' } }

describe('Pi detached subagent evidence', () => {
  it('keeps idle ownership through completion delivery, then resumes and settles', () => {
    const work = new PiBackgroundWork()
    expect(work.observe({ type: 'agent_start' })).toBeUndefined()
    expect(work.observe(widget('queued'), 10)?.tasks[0].observedAt).toBe(10)
    expect(work.observe(widget('running', 2), 20)?.tasks[0].observedAt).toBe(10)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('waiting')
    expect(work.pending).toBe(true)
    expect(work.observe(widget('complete', 3))?.tasks).toEqual([])
    // Terminal child evidence alone must not tear down the parent listener.
    expect(work.pending).toBe(true)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('waiting')
    work.observe({ type: 'agent_start' })
    expect(work.pending).toBe(false)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('inactive')
  })

  it('allows a fast completion delivered inside the original parent cycle', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running'))
    work.observe(widget('complete', 2))
    expect(work.pending).toBe(true)
    work.observe(notify)
    expect(work.pending).toBe(false)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('inactive')
  })

  it('does not mistake a supervisor wakeup or one child completion for all work ending', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running', 1, 'a'))
    work.observe(widget('running', 2, 'b'))
    work.observe({ type: 'agent_settled' })
    expect(work.observe({ type: 'agent_start' })?.phase).toBe('working')
    work.observe(widget('failed', 3, 'a'))
    work.observe(notify)
    expect(work.pending).toBe(true)
    expect(work.observe({ type: 'agent_settled' })?.tasks.map(task => task.taskId)).toEqual(['b'])
    work.observe(widget('stopped', 4, 'b'))
    work.observe({ type: 'agent_start' })
    expect(work.pending).toBe(false)
  })

  it('does not infer completion from absent rows, malformed or older evidence', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running', 2))
    work.observe(widget('complete', 1))
    work.observe({ ...widget('complete', 3), widgetLines: ['PI_SUBAGENT_ASYNC_JSON:{bad'] })
    work.observe({ ...widget('complete', 3), widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: 3, runs: []
    })] })
    expect(work.pending).toBe(true)
    expect(work.end()?.tasks).toMatchObject([{ taskId: 'child', status: 'unconfirmed' }])
  })

  it('ends observation when the extension clears the widget instead of waiting forever', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running', 1))
    work.observe({ type: 'agent_end' })
    expect(work.pending).toBe(true)
    // The extension clears this widget once it has no async jobs left. That is the
    // end of observation, not proof the child succeeded and not a reason to keep
    // the run owned: a real turn stayed open for hours waiting for a terminal row.
    expect(work.observe({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })?.tasks)
      .toMatchObject([{ taskId: 'child', status: 'unconfirmed' }])
    expect(work.pending).toBe(false)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('inactive')
    // Live work in a later snapshot outranks the earlier clear.
    work.observe(widget('running', 5, 'child-2'))
    expect(work.pending).toBe(true)
  })

  it('does not revive cleared tasks when the parent wakes again', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running'))
    work.observe({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
    expect(work.observe({ type: 'agent_start' })?.phase).toBe('inactive')
    expect(work.pending).toBe(false)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('inactive')
    expect(work.end()?.tasks).toMatchObject([{ taskId: 'child', status: 'unconfirmed' }])
  })

  it('keeps cleared tasks unconfirmed when a different child starts', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running'))
    work.observe({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
    expect(work.observe(widget('running', 2, 'new-child'))?.tasks).toMatchObject([
      { taskId: 'child', status: 'unconfirmed' }, { taskId: 'new-child' }
    ])
    work.observe(widget('complete', 3, 'new-child'))
    work.observe(notify)
    expect(work.pending).toBe(false)
    expect(work.observe({ type: 'agent_settled' })?.phase).toBe('inactive')
  })

  it('only revives a cleared task on fresh live evidence for that task', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running', 2))
    work.observe({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
    expect(work.observe(widget('running', 1))).toBeUndefined()
    expect(work.pending).toBe(false)
    expect(work.observe(widget('running', 3))?.tasks[0].status).toBeUndefined()
    expect(work.pending).toBe(true)
  })

  it('does not await continuation for a late terminal row from a cleared task', () => {
    const work = new PiBackgroundWork()
    work.observe(widget('running'))
    work.observe({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
    work.observe(widget('complete', 2))
    expect(work.pending).toBe(false)
  })

  it('does not resurrect from stale snapshots or await historical terminal tasks', () => {
    const work = new PiBackgroundWork()
    expect(work.observe(widget('complete'))).toBeUndefined()
    expect(work.pending).toBe(false)
    work.observe(widget('running', 2))
    work.observe(widget('paused', 3))
    work.observe({ type: 'agent_start' })
    expect(work.observe(widget('running', 2))).toBeUndefined()
    work.observe(widget('paused', 4))
    expect(work.pending).toBe(false)
  })

  it('does not parse plain extension text or other protocol versions as live work', () => {
    const work = new PiBackgroundWork()
    work.observe({ ...widget('running'), widgetKey: 'unrelated' })
    work.observe({ ...widget('running'), widgetLines: [widget('running').widgetLines[0].replace('"version":1', '"version":2')] })
    work.observe({ type: 'message_end', message: { role: 'assistant', content: 'waiting for a worker' } })
    expect(work.pending).toBe(false)
    expect(work.end()).toBeUndefined()
  })
})
