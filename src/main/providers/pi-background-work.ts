import type { BackgroundTask, BackgroundWork } from '../../shared/background-work'

type WireEvent = Record<string, unknown>
const prefix = 'PI_SUBAGENT_ASYNC_JSON:'
const terminalStates = new Set(['complete', 'failed', 'paused', 'stopped', 'rejected'])

function record(value: unknown): WireEvent {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WireEvent : {}
}

/** Pi subagents v1 widgets are structured evidence, not a rendered-text heuristic.
 * Rows missing from a capped snapshot are an evidence gap, not completion.
 * An explicit clear is different evidence: the extension clears this widget once it
 * reports no async jobs left, so observation ends there. Tasks stay visible as
 * `unconfirmed` — never as completed — and the run may settle, because waiting for a
 * terminal row that cannot arrive left a real turn owned for hours.
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
    if (this.awaitingContinuation) return true
    for (const task of this.tasks.values()) {
      if (task.status !== 'unconfirmed') return true
    }
    return false
  }

  observe(event: WireEvent, now = Date.now()): BackgroundWork | undefined {
    if (event.type === 'agent_start') {
      this.parentIdle = false
      this.awaitingContinuation = false
    } else if (event.type === 'agent_end' || event.type === 'agent_settled') {
      this.parentIdle = true
      if (this.pending) this.awaitingContinuation = true
    } else if (event.type === 'message_end' && record(event.message).customType === 'subagent-notify') {
      // A fast child may finish before the original parent cycle ends. The native
      // completion message then reaches that cycle without another agent_start.
      this.awaitingContinuation = false
    } else if (event.type === 'extension_ui_request' && event.method === 'setWidget' && event.widgetKey === 'subagent-async') {
      const lines = event.widgetLines
      if (!Array.isArray(lines)) return this.release(now)
      if (lines.length !== 1 || typeof lines[0] !== 'string' || !lines[0].startsWith(prefix)) return undefined
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
          const task = this.tasks.get(id)
          if (task && task.status !== 'unconfirmed') this.awaitingContinuation = true
          this.tasks.delete(id)
        } else {
          this.observed = true
          // Only fresh live evidence for this task can restore its ownership.
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
    return { ...this.snapshot(now), phase: 'inactive', tasks: this.unconfirmed() }
  }

  private release(now: number): BackgroundWork | undefined {
    if (!this.observed || !this.pending) return undefined
    // Keep the evidence gap on each task, not a run-wide flag that a parent wakeup
    // or a different child could reset and resurrect stale waiting cards.
    for (const task of this.unconfirmed()) this.tasks.set(task.taskId, task)
    this.awaitingContinuation = false
    return this.snapshot(now)
  }

  private unconfirmed(): BackgroundTask[] {
    return [...this.tasks.values()].map(task => ({ ...task, status: 'unconfirmed' as const }))
  }

  private snapshot(now: number): BackgroundWork {
    const pending = this.pending
    return {
      providerId: 'pi', phase: pending ? this.parentIdle ? 'waiting' : 'working' : 'inactive',
      quiet: false, lastEventAt: now, revision: ++this.revision,
      // A launch without a terminal state is an unknown outcome, never a completion.
      tasks: pending ? [...this.tasks.values()] : this.unconfirmed(),
      coverage: 'partial', taskStop: 'unavailable'
    }
  }
}
