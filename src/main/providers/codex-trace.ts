import type { TraceEvent } from '../../shared/trace'
import { mcpPayloadFailed, parseMcp } from '../../shared/trace'

/**
 * Codex app-server reports items and hooks; this module is the only place that turns those
 * payloads into trace events. Keeping the projection out of the adapter lets it be read and tested
 * without a live app-server.
 */

/** The adapter records these so child-agent items can be attributed to their parent turn. */
export interface ItemTraceContext {
  agentId?: string
  parentToolUseId?: string
}

let eventCounter = 0
export const newEvent = (runId: string, fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>): TraceEvent => ({
  id: `codex-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date().toISOString(),
  ...fields
})


export const newEventAt = (
  runId: string,
  observedAtMs: number,
  fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>
): TraceEvent => ({
  id: `codex-${observedAtMs.toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date(observedAtMs).toISOString(),
  ...fields
})


export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}


export const hookEventName = (value: unknown): string => {
  const name = String(value ?? 'hook')
  return name.charAt(0).toUpperCase() + name.slice(1)
}


export const usageNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined


export const skillNamesFromCommand = (command: string): string[] => {
  const names = new Set<string>()
  const paths = /(?:^|[\s"'`=])[^\s"'`=]*skills\/([^/\s"'`=]+)\/SKILL\.md\b/g
  for (const match of command.matchAll(paths)) names.add(match[1])
  return [...names]
}


const projectHookSource = (
  source: unknown,
  sourcePath: unknown,
  cwd?: string
): { sourcePath?: string; originalSourcePath?: string } => {
  const originalSourcePath = typeof sourcePath === 'string' ? sourcePath : undefined
  if (
    source === 'project' &&
    cwd &&
    originalSourcePath &&
    /[/\\]\.codex[/\\]hooks\.json$/.test(originalSourcePath)
  ) {
    const normalized = `${cwd.replace(/[/\\]+$/, '')}/.codex/hooks.json`
    return normalized === originalSourcePath
      ? { sourcePath: normalized }
      : { sourcePath: normalized, originalSourcePath }
  }
  return { sourcePath: originalSourcePath }
}

export function traceFromHook(runId: string, raw: unknown, completed: boolean, cwd?: string): TraceEvent {
  const hook = record(raw)
  const status = String(hook.status ?? (completed ? 'completed' : 'running'))
  const event = hookEventName(hook.eventName)
  const entries = Array.isArray(hook.entries) ? hook.entries.map(record) : []
  const failed = completed && status !== 'completed'
  const source = projectHookSource(hook.source, hook.sourcePath, cwd)
  return newEvent(runId, {
    kind: 'hook',
    stage: completed ? 'hook_response' : 'hook_started',
    name: event,
    hookId: typeof hook.id === 'string' ? hook.id : undefined,
    hookEvent: event,
    hookName: typeof hook.statusMessage === 'string' ? hook.statusMessage : `${event}:${String(hook.handlerType ?? 'hook')}`,
    hookCommand: typeof hook.command === 'string' ? hook.command : undefined,
    hookOutcome: completed ? (status === 'completed' ? 'success' : status === 'stopped' ? 'cancelled' : 'error') : 'started',
    durationMs: typeof hook.durationMs === 'number' ? hook.durationMs : undefined,
    isError: failed,
    output: completed ? entries.map((entry) => String(entry.text ?? '')).filter(Boolean).join('\n') : undefined,
    input: {
      source: hook.source,
      sourcePath: source.sourcePath,
      ...(source.originalSourcePath ? { originalSourcePath: source.originalSourcePath } : {}),
      scope: hook.scope,
      handlerType: hook.handlerType,
      status,
      entries
    }
  })
}

export function traceFromItem(
  runId: string,
  raw: unknown,
  completed: boolean,
  context: ItemTraceContext = {}
): TraceEvent[] {
  const item = record(raw)
  const type = String(item.type ?? '')
  const id = typeof item.id === 'string' ? item.id : undefined
  if (type === 'contextCompaction') {
    if (!completed) return []
    const compaction = id ? { providerEventId: id } : {}
    return [newEvent(runId, {
      kind: 'harness',
      stage: 'context_compaction',
      compaction,
      input: compaction,
      runtimeMetadata: { source: 'codex_context_compaction', codexItemId: id },
      ...context
    })]
  }
  if (type === 'commandExecution') {
    const command = String(item.command ?? '')
    const input = { command, cwd: item.cwd }
    const mcp = parseMcp('Bash', input)
    const output = completed ? String(item.aggregatedOutput ?? '') : undefined
    const managementAction = /\bmcporter\s+list(?:\s|$)/.test(command) ? 'list' : undefined
    const identity = { agentId: context.agentId, parentToolUseId: context.parentToolUseId }
    const events = [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool: 'Bash',
            toolUseId: id,
            output,
            durationMs: usageNumber(item.durationMs),
            isError: item.status === 'failed' || (mcp.isMcp && mcpPayloadFailed(output ?? item.aggregatedOutput)),
            ...identity,
            ...mcp,
            ...(managementAction ? { runtimeMetadata: { mcpManagementAction: managementAction } } : {})
          }
        : {
            kind: 'tool',
            stage: 'tool:Bash',
            tool: 'Bash',
            toolUseId: id,
            input,
            ...identity,
            ...mcp,
            ...(managementAction ? { runtimeMetadata: { mcpManagementAction: managementAction } } : {})
          })
    ]
    if (!completed) {
      for (const name of skillNamesFromCommand(command)) {
        events.push(
          newEvent(runId, {
            kind: 'skill',
            stage: `skill:${name}`,
            tool: 'Skill',
            toolUseId: id,
            name,
            input: { source: 'skill_path_in_command', command },
            ...identity
          })
        )
      }
    }
    return events
  }
  if (type === 'mcpToolCall') {
    const server = String(item.server ?? '')
    const tool = String(item.tool ?? '')
    const toolName = `mcp__${server}__${tool}`
    return [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool: toolName,
            toolUseId: id,
            isMcp: true,
            mcpServer: server,
            mcpAction: tool,
            mcpTool: toolName,
            output: JSON.stringify(item.result ?? item.error ?? null),
            durationMs: usageNumber(item.durationMs),
            isError: !!item.error,
            ...context
          }
        : {
            kind: 'tool',
            stage: `tool:${toolName}`,
            tool: toolName,
            toolUseId: id,
            isMcp: true,
            mcpServer: server,
            mcpAction: tool,
            mcpTool: toolName,
            input: item.arguments,
            ...context
          })
    ]
  }
  if (type === 'dynamicToolCall') {
    const tool = String(item.tool ?? 'dynamicTool')
    return [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool,
            toolUseId: id,
            output: JSON.stringify(item.contentItems ?? null),
            durationMs: usageNumber(item.durationMs),
            isError: item.success === false || item.status === 'failed',
            ...context
          }
        : {
            kind: 'tool',
            stage: `tool:${tool}`,
            tool,
            toolUseId: id,
            input: item.arguments,
            ...context
          })
    ]
  }
  if (type === 'collabAgentToolCall') {
    const collabTool = String(item.tool ?? 'collaboration')
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []
    const promptName = typeof item.prompt === 'string'
      ? item.prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 40)
      : undefined
    const agentName = promptName || (typeof item.model === 'string' ? item.model : 'subagent')
    const input = {
      senderThreadId: item.senderThreadId,
      receiverThreadIds: receivers,
      prompt: item.prompt,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
      agentsStates: item.agentsStates
    }
    if (collabTool === 'spawnAgent') {
      return [
        newEvent(runId, completed
          ? {
              kind: 'tool',
              stage: 'tool_result',
              tool: 'Agent',
              toolUseId: id,
              output: JSON.stringify(item.agentsStates ?? null),
              isError: item.status === 'failed',
              ...context
            }
          : {
              kind: 'agent',
              stage: `agent:${agentName}`,
              tool: 'Agent',
              toolUseId: id,
              name: agentName,
              input,
              ...context
            })
      ]
    }
    const tool = `collaboration:${collabTool}`
    return [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool,
            toolUseId: id,
            output: JSON.stringify(item.agentsStates ?? null),
            isError: item.status === 'failed',
            ...context
          }
        : { kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: id, input, ...context })
    ]
  }
  if (type === 'subAgentActivity') {
    const targetAgentId = String(item.agentThreadId ?? '')
    const agentId = String(
      item.kind === 'started'
        ? targetAgentId || context.agentId || ''
        : context.agentId || targetAgentId
    )
    if (item.kind !== 'started') {
      return [
        newEvent(runId, {
          kind: 'harness',
          stage: 'agent_activity',
          toolUseId: id,
          agentId: agentId || undefined,
          parentToolUseId: context.parentToolUseId,
          name: String(item.agentPath ?? (agentId || 'subagent')),
          input: {
            activity: item.kind,
            agentThreadId: targetAgentId || undefined,
            agentPath: item.agentPath
          }
        })
      ]
    }
    const agentName = String(item.agentPath ?? (agentId || 'subagent')).replace(/^\/root\//, '')
    return [
      newEvent(runId, {
        kind: 'agent',
        stage: `agent:${agentName}`,
        tool: 'Agent',
        toolUseId: id,
        agentId: agentId || undefined,
        parentToolUseId: context.parentToolUseId,
        name: agentName,
        input: {
          activity: item.kind,
          agentThreadId: agentId || undefined,
          agentPath: item.agentPath
        }
      })
    ]
  }
  if (type === 'plan') {
    // `turn/plan/updated` 是一次真实 update_plan 调用；部分 app-server
    // 版本还会额外发送只读的 plan ThreadItem。这里只把 ThreadItem 当快照，
    // 避免同一次计划更新被重复计数。
    return []
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return changes.map((change) => {
      const file = record(change)
      return newEvent(runId, {
        kind: 'tool',
        stage: completed ? 'tool_result' : 'tool:Edit',
        tool: 'Edit',
        toolUseId: id,
        fileOp: 'edit',
        filePath: String(file.path ?? ''),
        input: completed ? undefined : file,
        output: completed ? String(file.diff ?? '') : undefined,
        ...context
      })
    })
  }
  return []
}
