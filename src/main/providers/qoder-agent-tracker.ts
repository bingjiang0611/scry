import type { TraceEvent } from '../../shared/trace'
import type { QoderBackgroundTasks } from './qoder-messages'
import { isAgentLaunchStatus, isAgentTerminalStatus, observedAgentStatus } from './qoder-hooks'

/**
 * Qoder's Agent tool calls report through hooks that can stop arriving when the CLI ends. This
 * tracker counts the calls that started without a terminal state, so the turn can close them with an
 * honest "never returned" result instead of leaving them pending forever.
 */
export interface QoderAgentTracker {
  /** Agent calls that started and have not reported a terminal status yet. */
  readonly active: ReadonlySet<string>
  /** Agent calls already closed, so a fallback never overwrites real evidence. */
  readonly terminal: ReadonlySet<string>
  hasPending(): boolean
  observe(event: TraceEvent, hasTerminalEvidence?: boolean): void
  /** Observes and forwards: the event is emitted unless its call is already terminal. */
  emit(event: TraceEvent, hasTerminalEvidence: boolean): void
  settleUnreported(status: 'failed' | 'stopped', source: string): void
}

export function createQoderAgentTracker(input: {
  runId: string
  tasks: QoderBackgroundTasks
  emit: (event: TraceEvent) => void
}): QoderAgentTracker {
  const active = new Set<string>()
  const terminal = new Set<string>()

  const observe = (event: TraceEvent, hasTerminalEvidence = true): void => {
    if (!event.toolUseId || terminal.has(event.toolUseId)) return
    const status = observedAgentStatus(event)
    if (event.stage === 'agent_activity' || isAgentLaunchStatus(status)) {
      active.add(event.toolUseId)
      return
    }
    if (event.tool === 'Agent' && event.stage === 'tool_result' && isAgentTerminalStatus(status)) {
      active.delete(event.toolUseId)
      terminal.add(event.toolUseId)
      if (hasTerminalEvidence) input.tasks.settleCall(event.toolUseId, 'Agent')
    }
  }

  const emit = (event: TraceEvent, hasTerminalEvidence: boolean): void => {
    if (!event.toolUseId || terminal.has(event.toolUseId)) return
    observe(event, hasTerminalEvidence)
    input.emit(event)
  }

  const settleUnreported = (agentStatus: 'failed' | 'stopped', source: string): void => {
    for (const toolUseId of active) {
      emit({
        id: `qoder-fallback:agent:${input.runId}:${toolUseId}:${agentStatus}`,
        runId: input.runId,
        ts: new Date().toISOString(),
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Agent',
        toolUseId,
        text: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
        output: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
        isError: agentStatus === 'failed',
        runtimeMetadata: { source, agentStatus }
      }, false)
    }
  }

  return { active, terminal, hasPending: () => active.size > 0, observe, emit, settleUnreported }
}
