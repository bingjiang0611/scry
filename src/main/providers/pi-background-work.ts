import type { BackgroundTask, BackgroundWork } from '../../shared/background-work'

type WireEvent = Record<string, unknown>
const prefix = 'PI_SUBAGENT_ASYNC_JSON:'
const terminalStates = new Set(['complete', 'failed', 'paused', 'stopped', 'rejected'])

function record(value: unknown): WireEvent {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WireEvent : {}
}

/** Pi subagents v1 widgets are structured evidence, not a rendered-text heuristic.
 * Missing rows/widget clearing are not task completion (snapshots are capped).
 * Keep ownership through idle and through the completion-to-parent-wakeup gap.
 */
export class PiBackgroundWork {
  private tasks = new Map<string, BackgroundTask>()
  private snapshotAt = -1
  private revision = 0
  private parentIdle = false
  private awaitingContinuation = false
  private observed = false

  get pending(): boolean {
    return this.tasks.size > 0 || this.awaitingContinuation
  }

  observe(event: WireEvent, now = Date.now()): BackgroundWork | undefined {
    if (event.type === 'agent_start') {
      this.parentIdle = false
      this.awaitingContinuation = false
    } else if (event.type === 'agent_end' || event.type === 'agent_settled') {
      this.parentIdle = true
      if (this.tasks.size > 0) this.awaitingContinuation = true
    } else if (event.type === 'message_end' && record(event.message).customType === 'subagent-notify') {
      // A fast child may finish before the original parent cycle ends. The native
      // completion message then reaches that cycle without another agent_start.
      this.awaitingContinuation = false
    } else if (event.type === 'extension_ui_request' && event.method === 'setWidget' && event.widgetKey === 'subagent-async') {
      const lines = event.widgetLines
      if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || !lines[0].startsWith(prefix)) return undefined
      const json = lines[0].slice(prefix.length)
      if (Buffer.byteLength(json) > 32_768) return undefined
      let snapshot: WireEvent
      try { snapshot = record(JSON.parse(json)) } catch { return undefined }
      if (snapshot.kind !== 'pi-subagents.async-status-snapshot' || snapshot.version !== 1 ||
        typeof snapshot.generatedAt !== 'number' || !Number.isFinite(snapshot.generatedAt) ||
        snapshot.generatedAt < this.snapshotAt || !Array.isArray(snapshot.runs)) return undefined
      const runs = snapshot.runs.map(record)
      if (runs.some(run => typeof run.id !== 'string' || !run.id || typeof run.label !== 'string' ||
        !['subagent', 'workflow'].includes(String(run.kind)) ||
        !['queued', 'running', ...terminalStates].includes(String(run.state)))) return undefined
      this.snapshotAt = snapshot.generatedAt
      for (const run of runs) {
        const id = run.id as string
        if (terminalStates.has(run.state as string)) {
          if (this.tasks.delete(id)) this.awaitingContinuation = true
        } else {
          this.observed = true
          this.tasks.set(id, {
            taskId: id, toolUseId: id, tool: 'Agent', description: run.label as string,
            observedAt: this.tasks.get(id)?.observedAt ?? now
          })
        }
      }
    } else return undefined
    return this.observed ? this.snapshot(now) : undefined
  }

  end(now = Date.now()): BackgroundWork | undefined {
    if (!this.observed) return undefined
    return { ...this.snapshot(now), phase: 'inactive', tasks: [...this.tasks.values()].map(task => ({ ...task, status: 'unconfirmed' })) }
  }

  private snapshot(now: number): BackgroundWork {
    return {
      providerId: 'pi', phase: this.pending ? this.parentIdle ? 'waiting' : 'working' : 'inactive',
      quiet: false, lastEventAt: now, revision: ++this.revision,
      tasks: [...this.tasks.values()], coverage: 'partial', taskStop: 'unavailable'
    }
  }
}
