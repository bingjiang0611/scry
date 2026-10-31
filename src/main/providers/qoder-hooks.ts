import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace'
import { normalizeAgentTaskStatus } from '../normalize-hooks'

/**
 * Native hook-log fallback diagnostics owned by the adapter, not by one run:
 * `describe()` reports them as Provider health after the run that observed them.
 */
export interface QoderHookFallbackState {
  error?: string
  observed: boolean
}

export function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /(\w+)=("(?:\\.|[^"])*"|\S+)/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]
    if (raw.startsWith('"')) {
      try { out[match[1]] = JSON.parse(raw) as string } catch { out[match[1]] = raw.slice(1, -1) }
    } else out[match[1]] = raw
  }
  return out
}

export function parseQoderHookLog(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const events: TraceEvent[] = []
  const pending = new Map<string, Array<{ detail: Record<string, string>; startedAt: number }>>()
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+(?:\[([^\]]+)\]\s+)?hook\.(started|finished)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[2] ?? '')
    const detail = fields(match[4])
    if (sessionId && context.session !== sessionId) continue
    const hookName = detail.hook_name ?? 'hook'
    const hookEvent = detail.hook_event_name ?? 'Hook'
    const key = [context.session ?? '', context.tool ?? '', hookName, hookEvent].join('|')
    if (match[3] === 'started') {
      const queue = pending.get(key) ?? []
      queue.push({ detail, startedAt: new Date(match[1]).getTime() })
      pending.set(key, queue)
      const hookId = `qoder-log:${key}:${detail.source ?? 'unknown'}:${detail.hook_index ?? queue.length}`
      events.push({
        id: `${hookId}:start`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_started',
        tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: detail.display_text,
        hookOutcome: 'started', toolUseId: context.tool,
        input: { sessionId: context.session, turnId: context.turn, source: detail.source, hookIndex: detail.hook_index },
        runtimeMetadata: { source: 'qoder_cli_log', hookSource: detail.source, hookIndex: detail.hook_index }
      })
      continue
    }
    const queue = pending.get(key) ?? []
    const finishedAt = new Date(match[1]).getTime()
    const durationMs = detail.duration_ms == null ? Number.NaN : Number(detail.duration_ms)
    // finished 日志不带 source/index；用它上报的 duration 反推 started，避免并发 Hook 按完成顺序串位。
    const expectedStart = finishedAt - durationMs
    const matchedIndex = Number.isFinite(expectedStart) && queue.length > 1
      ? queue.reduce((best, candidate, index) =>
          Math.abs(candidate.startedAt - expectedStart) < Math.abs(queue[best].startedAt - expectedStart) ? index : best, 0)
      : 0
    const started = queue.splice(matchedIndex, 1)[0]?.detail ?? {}
    if (queue.length === 0) pending.delete(key)
    const hookId = `qoder-log:${key}:${started.source ?? 'unknown'}:${started.hook_index ?? 'unknown'}`
    const success = detail.success === 'true'
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    events.push({
      id: `${hookId}:response`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_response',
      tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: started.display_text,
      hookOutcome: success ? 'success' : 'error', hookExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      toolUseId: context.tool, durationMs: Number.isFinite(durationMs) ? durationMs : undefined, isError: !success,
      input: { sessionId: context.session, turnId: context.turn, source: started.source, hookIndex: started.hook_index },
      runtimeMetadata: { source: 'qoder_cli_log', hookSource: started.source, hookIndex: started.hook_index }
    })
  }
  return events
}

export function parseQoderBackgroundTaskFailures(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const backgrounded = new Map<string, { command?: string; ts: string }>()
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+(?:\[([^\]]+)\]\s+)?tool\.shell\.(backgrounded|finished)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[2] ?? '')
    const detail = fields(match[4])
    if (sessionId && context.session !== sessionId) continue
    if (!detail.pid) continue
    if (match[3] === 'backgrounded') {
      backgrounded.set(detail.pid, { command: detail.command, ts: match[1] })
      continue
    }
    const started = backgrounded.get(detail.pid)
    if (!started) continue
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    const failed = detail.aborted === 'true' || detail.signal != null || (Number.isFinite(exitCode) && exitCode !== 0)
    if (!failed) continue
    const reason = [
      Number.isFinite(exitCode) ? `exit ${exitCode}` : undefined,
      detail.signal ? `signal ${detail.signal}` : undefined
    ].filter(Boolean).join(' · ')
    const durationMs = new Date(match[1]).getTime() - new Date(started.ts).getTime()
    const output = `后台 Bash 任务异常结束${reason ? `（${reason}）` : ''}`
    events.push({
      id: `qoder-log:background:${detail.pid}:${context.tool ?? 'unknown'}:response`,
      runId,
      ts: new Date(match[1]).toISOString(),
      kind: 'tool',
      stage: 'tool_result',
      tool: 'Bash',
      toolUseId: context.tool,
      input: started.command ? { command: started.command } : undefined,
      text: output,
      output,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
      isError: true,
      runtimeMetadata: {
        source: 'qoder_cli_log',
        backgroundTask: true,
        pid: Number(detail.pid),
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
        signal: detail.signal,
        aborted: detail.aborted === 'true'
      }
    })
  }
  return events
}

export function parseQoderSubagentTerminals(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+debug\.message\s+\[SubagentRun\]\s+error\s+(.+)$/)
    if (!match) continue
    const detail = fields(match[2])
    if (sessionId && detail.sessionId !== sessionId) continue
    if (!detail.parentToolUseId || !detail.taskId) continue
    const stopped = /AbortError|cancelled|canceled|closing|SIGTERM|terminated/i.test(match[2])
    const agentStatus = stopped ? 'stopped' : 'failed'
    const output = stopped ? '后台 Agent 已停止' : '后台 Agent 失败'
    events.push({
      id: `qoder-log:agent:${detail.taskId}:${detail.parentToolUseId}:response`,
      runId,
      ts: new Date(match[1]).toISOString(),
      kind: 'tool',
      stage: 'tool_result',
      tool: 'Agent',
      toolUseId: detail.parentToolUseId,
      text: output,
      output,
      isError: !stopped,
      runtimeMetadata: {
        source: 'qoder_cli_log',
        agentStatus,
        taskId: detail.taskId,
        qoderAgentId: detail.agentId
      }
    })
  }
  return events
}

export function observedAgentStatus(event: TraceEvent): string | undefined {
  const status = event.runtimeMetadata?.agentStatus
  return typeof status === 'string' ? status : undefined
}

export function isAgentLaunchStatus(status: string | undefined): boolean {
  return status === 'async_launched' || status === 'remote_launched' || status === 'running' || status === 'in_progress'
}

export function isAgentTerminalStatus(status: string | undefined): boolean {
  return normalizeAgentTaskStatus(status) !== undefined
}

export function hookFingerprint(event: TraceEvent): string {
  const source = event.runtimeMetadata?.source
  const command = event.hookCommand ?? (source === 'qoder_sdk' ? event.hookName : undefined)
  return [event.stage, event.hookEvent, command, event.toolUseId, event.hookOutcome].join('|')
}

export function qoderHookFallbackOnly(sdkHooks: TraceEvent[], fallback: TraceEvent[]): TraceEvent[] {
  const sdkCounts = new Map<string, number>()
  for (const event of sdkHooks) sdkCounts.set(hookFingerprint(event), (sdkCounts.get(hookFingerprint(event)) ?? 0) + 1)
  return fallback.filter((event) => {
    const key = hookFingerprint(event)
    const remaining = sdkCounts.get(key) ?? 0
    if (remaining === 0) return true
    sdkCounts.set(key, remaining - 1)
    return false
  })
}

export function qoderProviderTurnId(message: Record<string, unknown>): string | undefined {
  for (const key of ['promptId', 'prompt_id']) {
    if (typeof message[key] === 'string' && message[key]) return message[key]
  }
  return undefined
}

export function uniqueId(ids: Set<string>): string | undefined {
  return ids.size === 1 ? [...ids][0] : undefined
}

export function qoderProviderTurnIdFromLog(text: string, sessionId?: string): string | undefined {
  const sdkPromptIds = new Set<string>()
  const rootTurnIds = new Set<string>()
  const notificationTurnIds = new Set<string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^\S+\s+\S+\s+\[([^\]]+)\]\s+(input\.prompt\.received|input\.prompt\.submitted|turn\.started)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[1])
    const detail = fields(match[3])
    if (sessionId && context.session !== sessionId) continue
    if (!context.turn || context.turn === context.session) continue
    if (match[2] === 'input.prompt.received' && detail.command_mode === 'task-notification') {
      notificationTurnIds.add(context.turn)
    } else if (match[2] === 'input.prompt.received' && detail.query_source === 'sdk') {
      sdkPromptIds.add(context.turn)
    } else if (detail.is_subagent === 'false') {
      rootTurnIds.add(context.turn)
    }
  }
  // Qoder 后台任务通知也标 query_source=sdk / is_subagent=false，但属于原请求的
  // 后续处理，不是新的用户轮次。全量收集后排除它的生命周期 ID，避免 fallback 再引入。
  // 仍要求用户请求 ID 唯一，不能用“取第一个”掩盖真正的多请求歧义。
  for (const id of notificationTurnIds) {
    sdkPromptIds.delete(id)
    rootTurnIds.delete(id)
  }
  return sdkPromptIds.size > 0 ? uniqueId(sdkPromptIds) : uniqueId(rootTurnIds)
}

export async function qoderHookLog(pid: number): Promise<string> {
  const configDir = process.env.QODER_CONFIG_DIR ?? join(process.env.QODER_CLI_HOME ?? homedir(), '.qoder')
  const root = join(configDir, 'logs', 'runs')
  const entries = await readdir(root, { withFileTypes: true })
  const match = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(`-p${pid}`)).map((entry) => entry.name).sort().at(-1)
  if (!match) throw new Error(`Qoder log for pid ${pid} not found`)
  return readFile(join(root, match, 'qodercli.log'), 'utf8')
}
