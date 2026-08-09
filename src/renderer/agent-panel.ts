import { maskSecrets, type TraceEvent } from '@shared/trace'
import type { Turn } from './format'

export type AgentRowStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

export interface AgentRowActivity {
  id: string
  at?: string
  label: string
  event: TraceEvent
}

export interface AgentRow {
  id: string
  parentId?: string
  depth: number
  name: string
  model?: string
  providerId?: string
  status: AgentRowStatus
  statusSource: 'active_turn' | 'tool_result' | 'tool_error' | 'tool_stopped' | 'missing_terminal'
  toolCount: number
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  recentActivity: AgentRowActivity[]
  sourceEvent: TraceEvent
  terminalEvent?: TraceEvent
}

export interface DeriveAgentRowsOptions {
  busy: boolean
}

interface IndexedEvent {
  event: TraceEvent
  turn: Turn
  turnIndex: number
  eventIndex: number
  order: number
}

interface AgentAccumulator {
  id: string
  name?: string
  nameRank: number
  model?: string
  providerId?: string
  parentId?: string
  firstOrder: number
  source: IndexedEvent
  seeds: IndexedEvent[]
  events: Map<string, IndexedEvent>
  spawnCalls: Set<string>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : []
}

function callKey(runId: string, toolUseId: string): string {
  return `${runId}\u0000${toolUseId}`
}

function validTime(ts: string | undefined): number | undefined {
  if (!ts) return undefined
  const value = Date.parse(ts)
  return Number.isFinite(value) ? value : undefined
}

function compareEvents(left: IndexedEvent, right: IndexedEvent): number {
  const leftTime = validTime(left.event.ts)
  const rightTime = validTime(right.event.ts)
  if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime
  return left.order - right.order
}

function earlier(left: IndexedEvent, right: IndexedEvent): IndexedEvent {
  return compareEvents(left, right) <= 0 ? left : right
}

function later(left: IndexedEvent, right: IndexedEvent): IndexedEvent {
  return compareEvents(left, right) >= 0 ? left : right
}

function fallbackId(event: TraceEvent): string {
  return `${event.runId}:${event.toolUseId ?? event.id}`
}

function receiverIds(event: TraceEvent): string[] {
  return strings(record(event.input).receiverThreadIds)
}

/**
 * Agent tool calls made by a child carry the caller in `agentId` and the newly
 * spawned children in `receiverThreadIds`. A subAgentActivity event instead
 * carries the child itself in `agentId`, so it remains the strongest identity.
 */
function targetIds(event: TraceEvent): string[] {
  const receivers = receiverIds(event)
  const input = record(event.input)
  const isActivity = typeof input.activity === 'string'
  if (event.agentId && (isActivity || receivers.length === 0 || receivers.includes(event.agentId))) {
    return [event.agentId]
  }
  if (receivers.length > 0) return receivers
  if (event.agentId) return [event.agentId]
  return [fallbackId(event)]
}

function meaningfulName(value: string | undefined): string | undefined {
  const name = maskSecrets(value)?.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!name || /^(agent|task|subagent|子 agent)$/i.test(name)) return undefined
  return name
}

function eventModel(event: TraceEvent): string | undefined {
  const model = record(event.input).model
  return typeof model === 'string' && model.trim() ? model.trim() : undefined
}

function observedAgentStatus(event: TraceEvent): string | undefined {
  const status = record(event.runtimeMetadata).agentStatus
  return typeof status === 'string' ? status : undefined
}

function isLaunchStatus(status: string | undefined): boolean {
  return status === 'async_launched' || status === 'remote_launched' || status === 'running' || status === 'in_progress'
}

function terminalStatus(event: TraceEvent): Extract<AgentRowStatus, 'completed' | 'failed' | 'stopped'> {
  const status = observedAgentStatus(event)
  if (event.isError || status === 'failed' || status === 'error') return 'failed'
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled' || status === 'interrupted') return 'stopped'
  return 'completed'
}

function ensureAgent(agents: Map<string, AgentAccumulator>, id: string, indexed: IndexedEvent): AgentAccumulator {
  const existing = agents.get(id)
  if (existing) {
    existing.source = earlier(existing.source, indexed)
    existing.firstOrder = Math.min(existing.firstOrder, indexed.order)
    return existing
  }
  const created: AgentAccumulator = {
    id,
    nameRank: 0,
    firstOrder: indexed.order,
    source: indexed,
    seeds: [],
    events: new Map(),
    spawnCalls: new Set()
  }
  agents.set(id, created)
  return created
}

function updateIdentity(agent: AgentAccumulator, indexed: IndexedEvent): void {
  const { event } = indexed
  const nextName = meaningfulName(event.name)
  const input = record(event.input)
  const nameRank = event.kind === 'agent'
    ? typeof input.activity === 'string' ? 2 : 3
    : 1
  if (nextName && nameRank > agent.nameRank) {
    agent.name = nextName
    agent.nameRank = nameRank
  }
  agent.model ??= eventModel(event)
  agent.providerId ??= event.providerId
  agent.source = earlier(agent.source, indexed)
}

function toolDetail(event: TraceEvent): string | undefined {
  if (event.filePath) return event.filePath.split('/').filter(Boolean).pop() ?? event.filePath
  const input = record(event.input)
  for (const key of ['command', 'pattern', 'path', 'query', 'description']) {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const firstLine = value.trim().split(/\r?\n/, 1)[0]
    return maskSecrets(firstLine)?.slice(0, 88)
  }
  return undefined
}

function textDetail(value: string | undefined): string | undefined {
  const compact = maskSecrets(value)?.replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, 88) : undefined
}

function activityFor(indexed: IndexedEvent, terminal: boolean): AgentRowActivity | undefined {
  const { event } = indexed
  let label: string | undefined
  if (event.kind === 'agent') {
    label = `启动子 Agent · ${meaningfulName(event.name) ?? '未命名'}`
  } else if (event.stage === 'tool_result') {
    const name = event.tool ?? event.name ?? (terminal ? '任务' : '工具')
    const status = observedAgentStatus(event)
    const isAgent = event.tool === 'Agent' || event.tool === 'Task'
    if (isAgent && !terminal) {
      label = event.isError
        ? '子 Agent 启动失败'
        : status === 'remote_launched'
          ? '远程 Agent 已启动'
          : status === 'async_launched'
            ? '后台 Agent 已启动'
            : '子 Agent 已启动'
    } else if (isAgent) {
      const outcome = terminalStatus(event)
      label = outcome === 'failed' ? 'Agent 失败' : outcome === 'stopped' ? 'Agent 已停止' : 'Agent 完成'
    } else {
      label = `${name} ${event.isError ? '失败' : '完成'}`
    }
  } else if (event.kind === 'tool' || event.kind === 'skill') {
    const name = event.tool ?? event.name ?? event.stage
    const detail = toolDetail(event)
    label = `${name}${detail ? ` · ${detail}` : ''}`
  } else if (event.kind === 'model') {
    const detail = textDetail(event.text ?? event.thinking)
    if (detail) label = `${event.thinking ? '思考' : '输出'} · ${detail}`
  } else if (event.stage === 'agent_activity') {
    const input = record(event.input)
    const activity = input.activity
    if (activity === 'task_started') {
      label = '后台 Agent 已启动'
    } else if (activity === 'task_progress') {
      const detail = textDetail(
        typeof input.summary === 'string'
          ? input.summary
          : typeof input.lastToolName === 'string'
            ? input.lastToolName
            : undefined
      )
      label = `后台 Agent 活动${detail ? ` · ${detail}` : ''}`
    } else {
      label = activity === 'interacted'
        ? '与其他 Agent 交互'
        : typeof activity === 'string' && activity
          ? `Agent 活动 · ${activity}`
          : 'Agent 活动'
    }
  } else if (event.kind === 'hook') {
    label = `Hook · ${event.hookName ?? event.name ?? event.tool ?? '运行'}`
  }
  return label ? { id: event.id, ...(event.ts ? { at: event.ts } : {}), label, event } : undefined
}

function chronologicalValue(row: Pick<AgentRow, 'startedAt'>, fallback: number): number {
  return validTime(row.startedAt) ?? fallback
}

/**
 * 从当前会话已经观测到的 TraceEvent 投影子 Agent roster。它不补 Token、
 * 进度或终态：历史事件缺少 Agent tool_result 时明确保持 unknown。
 */
export function deriveAgentRows(turns: readonly Turn[], options: DeriveAgentRowsOptions): AgentRow[] {
  const indexed: IndexedEvent[] = []
  let order = 0
  turns.forEach((turn, turnIndex) => {
    turn.items.forEach((event, eventIndex) => indexed.push({ event, turn, turnIndex, eventIndex, order: order++ }))
  })

  const agents = new Map<string, AgentAccumulator>()
  const spawnOwners = new Map<string, Set<string>>()

  // agentId is an explicit provider identity even if the original spawn event
  // has fallen out of a partial history snapshot.
  for (const item of indexed) {
    if (item.event.agentId) updateIdentity(ensureAgent(agents, item.event.agentId, item), item)
  }

  const seeds = indexed.filter((item) => item.event.kind === 'agent' && item.event.stage !== 'tool_result')
    .sort(compareEvents)
  for (const item of seeds) {
    const targets = targetIds(item.event)
    for (const id of targets) {
      const agent = ensureAgent(agents, id, item)
      agent.seeds.push(item)
      updateIdentity(agent, item)
      if (item.event.toolUseId) {
        const key = callKey(item.event.runId, item.event.toolUseId)
        agent.spawnCalls.add(key)
        const owners = spawnOwners.get(key) ?? new Set<string>()
        owners.add(id)
        spawnOwners.set(key, owners)
      }
    }
  }

  const ownerByCall = new Map(spawnOwners)
  const startsByCall = new Map<string, IndexedEvent>()
  for (const item of indexed) {
    const { event } = item
    if (event.toolUseId && event.stage !== 'tool_result') {
      startsByCall.set(callKey(event.runId, event.toolUseId), item)
    }
  }

  // Resolve ordinary child tools once their parent call is known. Repeating is
  // intentional: nested Claude Task calls can appear before their parent.
  for (let pass = 0; pass <= indexed.length; pass++) {
    let changed = false
    for (const item of indexed) {
      const { event } = item
      if (!event.toolUseId || event.stage === 'tool_result' || event.kind === 'agent') continue
      const key = callKey(event.runId, event.toolUseId)
      if (ownerByCall.has(key)) continue
      const explicit = event.agentId && agents.has(event.agentId) ? new Set([event.agentId]) : undefined
      const parent = event.parentToolUseId
        ? ownerByCall.get(callKey(event.runId, event.parentToolUseId))
        : undefined
      const owners = explicit ?? parent
      if (!owners?.size) continue
      ownerByCall.set(key, new Set(owners))
      changed = true
    }
    if (!changed) break
  }

  const ownersFor = (event: TraceEvent): Set<string> => {
    if (event.kind === 'agent') return new Set(targetIds(event))
    if (event.stage === 'tool_result' && event.toolUseId) {
      const spawned = spawnOwners.get(callKey(event.runId, event.toolUseId))
      if (spawned) {
        const owners = new Set(spawned)
        if (event.agentId && agents.has(event.agentId)) owners.add(event.agentId)
        return owners
      }
    }
    if (event.agentId && agents.has(event.agentId)) return new Set([event.agentId])
    if (event.parentToolUseId) {
      const parent = ownerByCall.get(callKey(event.runId, event.parentToolUseId))
      if (parent) return parent
    }
    if (event.toolUseId) return ownerByCall.get(callKey(event.runId, event.toolUseId)) ?? new Set()
    return new Set()
  }

  // A nested spawn belongs to its child row, but is also the parent's latest
  // observed activity. Parent linkage is resolved only after all spawn calls
  // have been indexed, so event arrival order does not matter.
  for (const item of seeds) {
    const targets = targetIds(item.event)
    const input = record(item.event.input)
    let parents = new Set<string>()
    if (item.event.agentId && !targets.includes(item.event.agentId) && agents.has(item.event.agentId)) {
      parents = new Set([item.event.agentId])
    } else if (item.event.parentToolUseId) {
      parents = ownerByCall.get(callKey(item.event.runId, item.event.parentToolUseId)) ?? new Set()
    } else if (typeof input.senderThreadId === 'string' && agents.has(input.senderThreadId)) {
      parents = new Set([input.senderThreadId])
    }
    for (const target of targets) {
      const agent = agents.get(target)
      const parent = [...parents].find((candidate) => candidate !== target)
      if (agent && parent && !agent.parentId) agent.parentId = parent
    }
    for (const parent of parents) {
      if (!targets.includes(parent)) agents.get(parent)?.events.set(item.event.id, item)
    }
  }

  for (const item of indexed) {
    for (const id of ownersFor(item.event)) {
      const agent = agents.get(id)
      if (!agent) continue
      agent.events.set(item.event.id, item)
      updateIdentity(agent, item)
    }
  }

  // ownerByCall can point at a child from an explicit parentToolUseId even when
  // the only surviving evidence is a nested tool result.
  for (const [key, owners] of ownerByCall) {
    const start = startsByCall.get(key)
    if (!start) continue
    for (const id of owners) agents.get(id)?.events.set(start.event.id, start)
  }

  const activeRunId = options.busy
    ? [...turns].reverse().find((turn) => !turn.done && !turn.error)?.runId
    : undefined
  const rows = new Map<string, AgentRow>()

  for (const agent of agents.values()) {
    const events = [...agent.events.values()].sort(compareEvents)
    const terminals = events.filter((item) => {
      const { event } = item
      if (event.stage !== 'tool_result' || !event.toolUseId) return false
      const key = callKey(event.runId, event.toolUseId)
      if (!agent.spawnCalls.has(key) || isLaunchStatus(observedAgentStatus(event))) return false
      // Codex first completes the spawn command itself, then emits a second,
      // child-scoped Agent result when that child turn really settles.
      const isCodex = event.providerId === 'codex' || event.runtimeProvider === 'codex_cli' ||
        agent.seeds.some((seed) => receiverIds(seed.event).length > 0)
      return !isCodex || event.agentId === agent.id || event.isError === true
    })
    const latestTurnIndex = events.reduce((latest, item) => Math.max(latest, item.turnIndex), -1)
    const latestRunId = events.find((item) => item.turnIndex === latestTurnIndex)?.event.runId
    const statusRunId = activeRunId && events.some((item) => item.event.runId === activeRunId)
      ? activeRunId
      : latestRunId
    const scopedTerminal = statusRunId
      ? terminals.filter((item) => item.event.runId === statusRunId).reduce<IndexedEvent | undefined>(
          (latest, item) => latest ? later(latest, item) : item,
          undefined
        )
      : undefined
    const active = Boolean(
      activeRunId && statusRunId === activeRunId && !scopedTerminal
    )
    const settledStatus = scopedTerminal ? terminalStatus(scopedTerminal.event) : undefined
    const status: AgentRowStatus = active
      ? 'running'
      : settledStatus ?? 'unknown'
    const statusSource: AgentRow['statusSource'] = active
      ? 'active_turn'
      : settledStatus === 'failed'
        ? 'tool_error'
        : settledStatus === 'stopped'
          ? 'tool_stopped'
          : settledStatus === 'completed'
            ? 'tool_result'
            : 'missing_terminal'

    const toolCalls = new Set<string>()
    for (const item of events) {
      const { event } = item
      if (event.kind !== 'tool') continue
      if (event.tool === 'Agent' || event.tool === 'Task') continue
      const key = event.toolUseId ? callKey(event.runId, event.toolUseId) : `${event.runId}\u0000${event.id}`
      if (agent.spawnCalls.has(key)) continue
      toolCalls.add(key)
    }
    const source = agent.seeds.reduce<IndexedEvent | undefined>(
      (first, item) => first ? earlier(first, item) : item,
      undefined
    ) ?? agent.source
    const updated = events.reduce<IndexedEvent | undefined>(
      (latest, item) => latest ? later(latest, item) : item,
      undefined
    ) ?? source
    const recentActivity = events
      .map((item) => activityFor(item, terminals.includes(item)))
      .filter((item): item is AgentRowActivity => item != null)
      .reverse()
      .filter((item, index, all) => index === 0 || item.label !== all[index - 1].label)
      .slice(0, 4)

    rows.set(agent.id, {
      id: agent.id,
      ...(agent.parentId && agents.has(agent.parentId) ? { parentId: agent.parentId } : {}),
      depth: 0,
      name: agent.name ?? `Agent ${agent.id.slice(-8)}`,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.providerId ? { providerId: agent.providerId } : {}),
      status,
      statusSource,
      toolCount: toolCalls.size,
      ...(source.event.ts ? { startedAt: source.event.ts } : {}),
      ...(updated.event.ts ? { updatedAt: updated.event.ts } : {}),
      ...(scopedTerminal?.event.ts ? { completedAt: scopedTerminal.event.ts } : {}),
      recentActivity,
      sourceEvent: source.event,
      ...(scopedTerminal ? { terminalEvent: scopedTerminal.event } : {})
    })
  }

  const children = new Map<string, AgentRow[]>()
  const roots: AgentRow[] = []
  for (const row of rows.values()) {
    if (row.parentId && row.parentId !== row.id && rows.has(row.parentId)) {
      const list = children.get(row.parentId) ?? []
      list.push(row)
      children.set(row.parentId, list)
    } else {
      roots.push(row)
    }
  }
  const sortRows = (items: AgentRow[]): void => {
    items.sort((left, right) => {
      const leftAgent = agents.get(left.id)
      const rightAgent = agents.get(right.id)
      return chronologicalValue(left, leftAgent?.firstOrder ?? 0) - chronologicalValue(right, rightAgent?.firstOrder ?? 0)
    })
  }
  sortRows(roots)
  for (const list of children.values()) sortRows(list)

  const output: AgentRow[] = []
  const visited = new Set<string>()
  const append = (row: AgentRow, depth: number): void => {
    if (visited.has(row.id)) return
    visited.add(row.id)
    output.push({ ...row, depth })
    for (const child of children.get(row.id) ?? []) append(child, depth + 1)
  }
  for (const root of roots) append(root, 0)
  // Defensive cycle handling: malformed parent evidence must not hide a row.
  for (const row of rows.values()) append(row, 0)
  return output
}
