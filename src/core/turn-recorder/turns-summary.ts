import { inferredReadPathsFromCommand } from '../../shared/file-evidence.js'
import {
  canonicalCostUsd,
  type AgentTurnRecord,
  type Evidence,
  type EvidenceQuality,
  type EvidenceStatus,
  type TurnCall,
  type TurnCompaction,
  type TurnFile,
  type TurnHookCall
} from '../../shared/turn-record.js'
import type { AgentIntervention } from '../../shared/runtime.js'

export interface CompactModelTiming {
  status: EvidenceStatus
  quality: EvidenceQuality
  method: string | null
  cumulativeMs: number | null
  occupiedMs: number | null
  timedCalls: number | null
  totalCalls: number | null
  source: string[]
}

interface SummaryCoverage {
  knownTurns: number
  totalTurns: number
  complete: boolean
  quality: EvidenceQuality
}

interface CountRow {
  name: string
  count: number
}

interface OrderedCall {
  call: TurnCall
  category: 'tool' | 'skill' | 'agent' | 'mcp'
  record: AgentTurnRecord
  sourceIndex: number
}

interface FileRow {
  path: string
  read: number
  inferredRead: number
  write: number
  edit: number
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function availableArray<T>(evidence: Evidence<T[]>): evidence is Evidence<T[]> & { value: T[] } {
  return (evidence.status === 'available' || evidence.status === 'partial') && Array.isArray(evidence.value)
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function sumKnown(values: Array<number | undefined>): number | null {
  const known = values.filter((value): value is number => finite(value))
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null
}

function countRows(values: string[]): CountRow[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function evidenceCoverage(
  selected: AgentTurnRecord[],
  evidence: (record: AgentTurnRecord) => Evidence<unknown>,
  quality: EvidenceQuality = 'exact'
): SummaryCoverage {
  const known = selected.filter((record) => {
    const value = evidence(record)
    return (value.status === 'available' || value.status === 'partial') && value.value !== undefined
  })
  const complete = selected.length > 0 && known.length === selected.length && known.every((record) => {
    const value = evidence(record)
    return value.status === 'available' && value.quality === 'exact'
  })
  return {
    knownTurns: known.length,
    totalTurns: selected.length,
    complete,
    quality: known.length === 0 ? 'unavailable' : complete ? quality : quality === 'exact' ? 'inferred' : quality
  }
}

function combinedCoverage(
  selected: AgentTurnRecord[],
  evidence: Array<(record: AgentTurnRecord) => Evidence<unknown>>,
  quality: EvidenceQuality = 'exact'
): SummaryCoverage {
  const known = selected.filter((record) => evidence.every((pick) => {
    const value = pick(record)
    return (value.status === 'available' || value.status === 'partial') && value.value !== undefined
  }))
  const complete = selected.length > 0 && known.length === selected.length && known.every((record) => evidence.every((pick) => {
    const value = pick(record)
    return value.status === 'available' && value.quality === 'exact'
  }))
  return {
    knownTurns: known.length,
    totalTurns: selected.length,
    complete,
    quality: known.length === 0 ? 'unavailable' : complete ? quality : quality === 'exact' ? 'inferred' : quality
  }
}

export function compactModelTiming(record: AgentTurnRecord): CompactModelTiming {
  const evidence = record.modelTiming
  return {
    status: evidence?.status ?? 'unavailable',
    quality: evidence?.quality ?? 'unavailable',
    method: evidence?.value?.method ?? null,
    cumulativeMs: finite(evidence?.value?.cumulativeMs) ? evidence.value.cumulativeMs : null,
    occupiedMs: finite(evidence?.value?.occupiedMs) ? evidence.value.occupiedMs : null,
    timedCalls: finite(evidence?.value?.timedCalls) ? evidence.value.timedCalls : null,
    totalCalls: finite(evidence?.value?.totalCalls) ? evidence.value.totalCalls : null,
    source: evidence?.source ?? []
  }
}

export function turnTimeline(record: AgentTurnRecord) {
  const events: Array<Record<string, unknown> & { order: number }> = []
  for (const segment of record.modelSegments?.value ?? []) {
    events.push({
      order: segment.order,
      type: 'model',
      kind: segment.kind,
      at: segment.at,
      text: segment.text,
      ...(segment.messageId ? { messageId: segment.messageId } : {}),
      ...(segment.providerItemId ? { providerItemId: segment.providerItemId } : {}),
      ...(segment.parentId ? { parentId: segment.parentId } : {}),
      ...(segment.agentId ? { agentId: segment.agentId } : {})
    })
  }
  for (const { call, category } of orderedCalls([record]).calls) {
    if (call.order != null) events.push({
      order: call.order,
      type: category,
      phase: 'start',
      name: call.name,
      status: call.status,
      ...(call.id ? { id: call.id } : {}),
      ...(call.parentId ? { parentId: call.parentId } : {}),
      ...(call.startedAt ? { at: call.startedAt } : {}),
      ...(call.input !== undefined ? { input: call.input } : {})
    })
    if (call.completedOrder != null) events.push({
      order: call.completedOrder,
      type: category,
      phase: 'result',
      name: call.name,
      status: call.status,
      ...(call.id ? { id: call.id } : {}),
      ...(call.completedAt ? { at: call.completedAt } : {}),
      ...(call.outputSummary ? { outputSummary: call.outputSummary } : {}),
      ...(call.error ? { error: call.error } : {})
    })
  }
  events.sort((left, right) => left.order - right.order)
  const evidence = record.modelSegments
  return {
    sequence: record.sequence,
    recordId: record.recordId,
    provider: record.provider.id,
    sessionId: record.sessionId,
    turnIndex: record.turnIndex,
    modelCoverage: evidence
      ? {
          status: evidence.status,
          quality: evidence.quality,
          source: evidence.source,
          ...(evidence.omissionReason ? { omissionReason: evidence.omissionReason } : {})
        }
      : {
          status: 'unavailable',
          quality: 'unavailable',
          source: [],
          omissionReason: 'record predates model segment capture'
        },
    events
  }
}

function legacyAgentCall(call: TurnCall): boolean {
  const input = call.input && typeof call.input === 'object'
    ? call.input as Record<string, unknown>
    : undefined
  return typeof input?.agentThreadId === 'string' || typeof input?.agentPath === 'string'
}

function toolCategory(call: TurnCall): 'tool' | 'agent' {
  if (call.category === 'agent') return 'agent'
  if (call.category === 'tool') return 'tool'
  return legacyAgentCall(call) ? 'agent' : 'tool'
}

function orderedCalls(selected: AgentTurnRecord[]): { calls: OrderedCall[]; quality: EvidenceQuality } {
  const calls: OrderedCall[] = []
  let sourceIndex = 0
  let exact = true
  for (const record of selected) {
    if (availableArray(record.tools)) {
      for (const call of record.tools.value) {
        if (call.category == null || call.order == null) exact = false
        calls.push({ call, category: toolCategory(call), record, sourceIndex: sourceIndex++ })
      }
    }
    if (availableArray(record.skills)) {
      for (const call of record.skills.value) {
        if (call.order == null) exact = false
        calls.push({ call, category: 'skill', record, sourceIndex: sourceIndex++ })
      }
    }
    if (availableArray(record.mcps)) {
      for (const call of record.mcps.value) {
        if (call.order == null) exact = false
        calls.push({ call, category: 'mcp', record, sourceIndex: sourceIndex++ })
      }
    }
  }
  calls.sort((left, right) => {
    if (left.record.sequence !== right.record.sequence) return left.record.sequence - right.record.sequence
    if (left.call.order != null && right.call.order != null && left.call.order !== right.call.order) {
      return left.call.order - right.call.order
    }
    const time = (left.call.startedAt ?? '').localeCompare(right.call.startedAt ?? '')
    return time || left.sourceIndex - right.sourceIndex
  })
  return { calls, quality: calls.length === 0 || exact ? 'exact' : 'inferred' }
}

function summarizeCalls(selected: AgentTurnRecord[]) {
  const ordinary: TurnCall[] = []
  const agents: TurnCall[] = []
  const skills: TurnCall[] = []
  const mcps: TurnCall[] = []
  let classificationExact = true

  for (const record of selected) {
    if (availableArray(record.tools)) {
      for (const call of record.tools.value) {
        if (call.category == null) classificationExact = false
        if (toolCategory(call) === 'agent') agents.push(call)
        else ordinary.push(call)
      }
    }
    if (availableArray(record.skills)) skills.push(...record.skills.value)
    if (availableArray(record.mcps)) mcps.push(...record.mcps.value)
  }

  const mcpGroups = new Map<string, { server: string; total: number; actions: Map<string, { action: string; tool: string; count: number }> }>()
  for (const call of mcps) {
    const server = call.mcp?.server ?? 'unknown'
    const action = call.mcp?.action ?? ''
    const tool = call.mcp?.tool ?? call.name
    const group = mcpGroups.get(server) ?? { server, total: 0, actions: new Map() }
    group.total++
    const key = `${action}\u0000${tool}`
    const row = group.actions.get(key) ?? { action, tool, count: 0 }
    row.count++
    group.actions.set(key, row)
    mcpGroups.set(server, group)
  }

  const evidence = combinedCoverage(
    selected,
    [(record) => record.tools, (record) => record.skills, (record) => record.mcps],
    classificationExact ? 'exact' : 'inferred'
  )
  const known = evidence.knownTurns > 0
  const ordinaryRows = countRows(ordinary.map((call) => call.name))
  const skillRows = countRows(skills.map((call) => call.name))
  const agentRows = countRows(agents.map((call) => call.name))
  const mcp = [...mcpGroups.values()]
    .map((group) => ({
      server: group.server,
      total: group.total,
      actions: [...group.actions.values()].sort((left, right) => right.count - left.count || left.action.localeCompare(right.action))
    }))
    .sort((left, right) => right.total - left.total || left.server.localeCompare(right.server))
  const ordinaryTotal = known ? ordinary.length : null
  const skillTotal = known ? skills.length : null
  const agentTotal = known ? agents.length : null
  const mcpTotal = known ? mcps.length : null
  const total = [ordinaryTotal, skillTotal, agentTotal, mcpTotal].every((value) => value != null)
    ? (ordinaryTotal ?? 0) + (skillTotal ?? 0) + (agentTotal ?? 0) + (mcpTotal ?? 0)
    : null
  const topTools = [
    ...ordinaryRows,
    ...mcp.map((group) => ({ name: `mcp:${group.server}`, count: group.total }))
  ].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)).slice(0, 6)

  return {
    total,
    ordinaryTools: { total: ordinaryTotal, byName: ordinaryRows },
    mcp: { total: mcpTotal, byServer: mcp },
    skills: { total: skillTotal, byName: skillRows },
    subagents: { total: agentTotal, byName: agentRows },
    topTools,
    coverage: evidence
  }
}

function summarizeHooks(selected: AgentTurnRecord[]) {
  const hooks: TurnHookCall[] = []
  let lifecycleExact = true
  for (const record of selected) {
    if (!availableArray(record.hooks)) continue
    hooks.push(...record.hooks.value)
    if (record.hooks.value.some((hook) => !finite(hook.lifecycleEvents))) lifecycleExact = false
  }
  const coverage = evidenceCoverage(selected, (record) => record.hooks, lifecycleExact ? 'exact' : 'inferred')
  const known = coverage.knownTurns > 0
  const lifecycleEvents = known
    ? hooks.reduce((sum, hook) => sum + (finite(hook.lifecycleEvents) ? hook.lifecycleEvents : hook.completedAt ? 2 : 1), 0)
    : null
  const byEvent = countRows(hooks.map((hook) => hook.event)).map((row) => ({ event: row.name, instances: row.count }))
  const byStatus = countRows(hooks.map((hook) => hook.status))
  return {
    handlerInstances: known ? hooks.length : null,
    lifecycleEvents,
    byEvent,
    byStatus,
    coverage
  }
}

function callCommand(call: TurnCall): { command: string; cwd?: string } | null {
  if (call.name !== 'Bash' || !call.input || typeof call.input !== 'object') return null
  const input = call.input as Record<string, unknown>
  if (typeof input.command !== 'string') return null
  return {
    command: input.command,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {})
  }
}

function structuredFileCalls(record: AgentTurnRecord, calls: OrderedCall[]): Array<{ call?: TurnCall; file: TurnFile }> {
  const fromCalls = calls
    .filter((entry) => entry.record === record && entry.call.file)
    .map((entry) => ({ call: entry.call, file: entry.call.file as TurnFile }))
  if (fromCalls.length > 0) return fromCalls
  return availableArray(record.files) ? record.files.value.map((file) => ({ file })) : []
}

function summarizeFiles(selected: AgentTurnRecord[], timeline: ReturnType<typeof orderedCalls>) {
  const rows = new Map<string, FileRow>()
  const candidatePaths = [...new Set(selected.flatMap((record) => {
    const fromCalls = structuredFileCalls(record, timeline.calls).map((entry) => entry.file.path)
    const fromEvidence = availableArray(record.files) ? record.files.value.map((file) => file.path) : []
    return [...fromCalls, ...fromEvidence]
  }))]
  const exactRead = new Set<string>()
  const inferredRead = new Set<string>()
  const written = new Set<string>()
  const covered = new Set<string>()
  const inferredCovered = new Set<string>()

  const rowOf = (path: string): FileRow => {
    const existing = rows.get(path)
    if (existing) return existing
    const row = { path, read: 0, inferredRead: 0, write: 0, edit: 0 }
    rows.set(path, row)
    return row
  }

  for (const record of selected) {
    for (const entry of structuredFileCalls(record, timeline.calls)) {
      rowOf(entry.file.path)[entry.file.operation]++
    }
  }

  const completedCalls = timeline.calls.slice().sort((left, right) => {
    if (left.record.sequence !== right.record.sequence) return left.record.sequence - right.record.sequence
    const leftOrder = left.call.completedOrder ?? left.call.order
    const rightOrder = right.call.completedOrder ?? right.call.order
    if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) return leftOrder - rightOrder
    const time = (left.call.completedAt ?? left.call.startedAt ?? '').localeCompare(right.call.completedAt ?? right.call.startedAt ?? '')
    return time || left.sourceIndex - right.sourceIndex
  })
  for (const entry of completedCalls) {
    if (entry.call.status === 'failed' || entry.call.status === 'cancelled') continue
    const command = callCommand(entry.call)
    if (command) {
      for (const path of inferredReadPathsFromCommand(command.command, command.cwd, candidatePaths)) {
        const row = rowOf(path)
        row.read++
        row.inferredRead++
        inferredRead.add(path)
      }
    }
    const file = entry.call.file
    if (!file) continue
    if (file.operation === 'read') {
      exactRead.add(file.path)
      continue
    }
    if (written.has(file.path)) continue
    written.add(file.path)
    if (exactRead.has(file.path) || inferredRead.has(file.path)) {
      covered.add(file.path)
      if (!exactRead.has(file.path)) inferredCovered.add(file.path)
    }
  }

  // Some Providers expose file evidence without a matching call. Preserve it as completed evidence.
  for (const record of selected) {
    if (structuredFileCalls(record, timeline.calls).some((entry) => entry.call)) continue
    if (!availableArray(record.files)) continue
    for (const file of record.files.value) {
      if (file.operation === 'read') exactRead.add(file.path)
      else if (!written.has(file.path)) {
        written.add(file.path)
        if (exactRead.has(file.path) || inferredRead.has(file.path)) {
          covered.add(file.path)
          if (!exactRead.has(file.path)) inferredCovered.add(file.path)
        }
      }
    }
  }

  const completionQuality = timeline.calls.some((entry) =>
    entry.call.id &&
    (entry.call.file || callCommand(entry.call)) &&
    entry.call.status === 'success' &&
    entry.call.completedOrder == null
  ) ? 'inferred' : timeline.quality
  const toolsCoverage = combinedCoverage(selected, [(record) => record.tools, (record) => record.files], completionQuality)
  const known = toolsCoverage.knownTurns > 0
  const values = [...rows.values()].sort((left, right) => left.path.localeCompare(right.path))
  const inferredPaths = values.filter((row) => row.inferredRead > 0).length
  const structuredPaths = values.filter((row) => row.read - row.inferredRead > 0 || row.write > 0 || row.edit > 0).length
  const inferredOnlyPaths = values.filter((row) => row.inferredRead > 0 && row.read === row.inferredRead && row.write === 0 && row.edit === 0).length
  return {
    uniquePaths: known ? values.length : null,
    structuredPaths: known ? structuredPaths : null,
    inferredReadPaths: known ? inferredPaths : null,
    inferredOnlyPaths: known ? inferredOnlyPaths : null,
    rows: values,
    writeCoverage: known
      ? {
          written: written.size,
          readBefore: covered.size,
          inferredReadBefore: inferredCovered.size,
          blind: [...written].filter((path) => !covered.has(path)).sort()
        }
      : { written: null, readBefore: null, inferredReadBefore: null, blind: null },
    coverage: toolsCoverage
  }
}

function summarizeSegments(selected: AgentTurnRecord[], timeline: ReturnType<typeof orderedCalls>) {
  const baseline = '（无 skill）'
  const segments: Array<{ skill: string; tools: number; agents: number; reads: number; writes: number; errors: number }> = []
  let current = { skill: baseline, tools: 0, agents: 0, reads: 0, writes: 0, errors: 0 }
  const keep = (): boolean => current.skill !== baseline || current.tools > 0 || current.agents > 0
  const seenMcpEvents = new Set<string>()
  const seenErrors = new Set<string>()
  const events = timeline.calls.flatMap((entry, index) => {
    const start = {
      type: 'start' as const,
      entry,
      order: entry.call.order,
      time: entry.call.startedAt ?? '',
      index: index * 2
    }
    if (entry.call.status !== 'failed') return [start]
    return [
      start,
      {
        type: 'error' as const,
        entry,
        order: entry.call.completedOrder,
        time: entry.call.completedAt ?? entry.call.startedAt ?? '',
        index: index * 2 + 1
      }
    ]
  }).sort((left, right) => {
    if (left.entry.record.sequence !== right.entry.record.sequence) return left.entry.record.sequence - right.entry.record.sequence
    if (left.order != null && right.order != null && left.order !== right.order) return left.order - right.order
    return left.time.localeCompare(right.time) || left.index - right.index
  })

  for (const event of events) {
    const entry = event.entry
    if (event.type === 'error') {
      const identity = `${entry.record.sequence}:${entry.call.completedOrder ?? entry.call.completedAt ?? ''}:${entry.call.id ?? entry.sourceIndex}`
      if (!seenErrors.has(identity)) {
        seenErrors.add(identity)
        current.errors++
      }
      continue
    }
    if (entry.category === 'skill') {
      if (keep()) segments.push(current)
      current = { skill: entry.call.name || 'skill', tools: 0, agents: 0, reads: 0, writes: 0, errors: 0 }
      continue
    }
    if (entry.category === 'agent') current.agents++
    else if (entry.category === 'mcp') {
      const identity = `${entry.record.sequence}:${entry.call.order ?? entry.call.startedAt ?? ''}:${entry.call.id ?? entry.sourceIndex}`
      if (!seenMcpEvents.has(identity)) {
        seenMcpEvents.add(identity)
        current.tools++
      }
    } else current.tools++
    if (entry.call.file?.operation === 'read') current.reads++
    else if (entry.call.file) current.writes++
  }
  if (keep()) segments.push(current)
  const timingQuality = timeline.calls.some((entry) => entry.call.status === 'failed' && entry.call.completedOrder == null)
    ? 'inferred'
    : timeline.quality
  const coverage = combinedCoverage(
    selected,
    [(record) => record.tools, (record) => record.skills, (record) => record.mcps],
    timingQuality
  )
  return { rows: coverage.knownTurns > 0 ? segments : null, coverage }
}

function summarizeUsage(selected: AgentTurnRecord[]) {
  const known = selected.filter((record) => record.usage.value !== undefined && ['available', 'partial'].includes(record.usage.status))
  const values = known.map((record) => record.usage.value).filter((value): value is NonNullable<typeof value> => !!value)
  const inputTokens = sumKnown(values.map((value) => value.inputTokens))
  const outputTokens = sumKnown(values.map((value) => value.outputTokens))
  const cacheReadTokens = sumKnown(values.map((value) => value.cacheReadTokens))
  const cacheCreationTokens = sumKnown(values.map((value) => value.cacheCreationTokens))
  const reasoningTokens = sumKnown(values.map((value) => value.reasoningTokens))
  const summedCostUsd = sumKnown(values.map((value) => value.costUsd))
  const costUsd = summedCostUsd == null ? null : canonicalCostUsd(summedCostUsd) ?? null
  const apiDurationMs = sumKnown(values.map((value) => value.apiDurationMs))
  const totalTokens = inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0)
  const models = countRows(values.flatMap((value) => value.model ? [value.model] : []))
  let context: { used: number; window: number; pct: number; remaining: number; model?: string } | null = null
  const contextKnownTurns = selected.filter((record) =>
    finite(record.usage.value?.contextTokens) &&
    finite(record.usage.value?.contextWindow) &&
    (record.usage.value?.contextWindow ?? 0) > 0
  ).length
  for (let index = selected.length - 1; index >= 0; index--) {
    const value = selected[index].usage.value
    if (!finite(value?.contextTokens) || !finite(value?.contextWindow) || value.contextWindow <= 0) continue
    context = {
      used: value.contextTokens,
      window: value.contextWindow,
      pct: Math.round((value.contextTokens / value.contextWindow) * 100),
      remaining: Math.max(0, value.contextWindow - value.contextTokens),
      ...(value.model ? { model: value.model } : {})
    }
    break
  }
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    costUsd,
    apiDurationMs,
    models,
    context,
    contextCoverage: {
      knownTurns: contextKnownTurns,
      totalTurns: selected.length,
      complete: selected.length > 0 && contextKnownTurns === selected.length,
      quality: contextKnownTurns > 0 ? 'exact' : 'unavailable'
    } satisfies SummaryCoverage,
    coverage: evidenceCoverage(selected, (record) => record.usage)
  }
}

function summarizeDiff(selected: AgentTurnRecord[]) {
  const files = selected.flatMap((record) => availableArray(record.diff)
    ? record.diff.value.flatMap((snapshot) => snapshot.status === 'captured' ? snapshot.files : [])
    : [])
  const unique = new Set(files.map((file) => file.path))
  const coverage = evidenceCoverage(selected, (record) => record.diff)
  const known = coverage.knownTurns > 0
  return {
    files: known ? unique.size : null,
    added: known ? files.reduce((sum, file) => sum + file.added, 0) : null,
    deleted: known ? files.reduce((sum, file) => sum + file.deleted, 0) : null,
    coverage
  }
}

function summarizeEvidenceCount<T>(selected: AgentTurnRecord[], pick: (record: AgentTurnRecord) => Evidence<T[]>) {
  const coverage = evidenceCoverage(selected, pick)
  const values = selected.flatMap((record) => availableArray(pick(record)) ? pick(record).value ?? [] : [])
  return { total: coverage.knownTurns > 0 ? values.length : null, coverage }
}

const interventionEvidence = (record: AgentTurnRecord): Evidence<AgentIntervention[]> =>
  record.interventions ?? {
    status: 'unavailable',
    quality: 'unavailable',
    source: [],
    omissionReason: 'record predates human intervention evidence'
  }

const compactionEvidence = (record: AgentTurnRecord): Evidence<TurnCompaction[]> =>
  record.compactions ?? {
    status: 'unavailable',
    quality: 'unavailable',
    source: [],
    omissionReason: 'record predates context compaction evidence'
  }

function summarizeCompactions(selected: AgentTurnRecord[]) {
  const coverage = evidenceCoverage(selected, compactionEvidence)
  const values = selected.flatMap((record) => {
    const evidence = compactionEvidence(record)
    return availableArray(evidence) ? evidence.value : []
  })
  const known = coverage.knownTurns > 0
  return {
    total: known ? values.length : null,
    auto: known ? values.filter((value) => value.trigger === 'auto').length : null,
    manual: known ? values.filter((value) => value.trigger === 'manual').length : null,
    unknownTrigger: known ? values.filter((value) => value.trigger == null).length : null,
    coverage
  }
}

function summarizeInterventions(selected: AgentTurnRecord[]) {
  const coverage = evidenceCoverage(selected, interventionEvidence)
  const requested = selected.flatMap((record) => {
    const evidence = interventionEvidence(record)
    return availableArray(evidence) ? evidence.value : []
  })
  const human = requested.filter((intervention) => intervention.resolution !== 'provider_cancelled')
  const known = coverage.knownTurns > 0
  return {
    requested: known ? requested.length : null,
    total: known ? human.length : null,
    questions: known
      ? human.reduce((sum, intervention) => sum + intervention.request.questions.length, 0)
      : null,
    answered: known ? human.filter((intervention) => intervention.resolution === 'answered').length : null,
    cancelled: known ? human.filter((intervention) => intervention.resolution === 'user_cancelled').length : null,
    clarification: known ? human.filter((intervention) => intervention.kind === 'clarification').length : null,
    permission: known ? human.filter((intervention) => intervention.kind === 'permission').length : null,
    waitMs: known ? human.reduce((sum, intervention) => sum + intervention.durationMs, 0) : null,
    byProvider: known
      ? countRows(human.map((intervention) => intervention.request.providerId ?? 'unknown'))
      : null,
    coverage
  }
}

export function summarizeTurnRecords(
  records: AgentTurnRecord[],
  sessionId?: string,
  options: { scope?: 'session' | 'workspace' } = {}
) {
  const selected = (sessionId ? records.filter((record) => record.sessionId === sessionId) : records)
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
  const uniqueSessions = new Set(selected.map((record) => record.sessionId))
  const effectiveSessionId = options.scope === 'workspace'
    ? null
    : sessionId ?? (uniqueSessions.size === 1 ? [...uniqueSessions][0] : null)
  const qualityCounts: Record<string, number> = {}
  const methodCounts: Record<string, number> = {}
  const timingStatusCounts: Record<string, number> = {}
  const sourceCounts: Record<string, number> = {}
  const turnStatusCounts: Record<string, number> = {}
  let knownTurns = 0
  let occupiedKnownTurns = 0
  let observedTimedCalls = 0
  let observedTotalCalls = 0
  let callCoverageTurns = 0

  for (const record of selected) {
    increment(turnStatusCounts, record.status)
    const evidence = record.modelTiming
    increment(timingStatusCounts, evidence?.status ?? 'unavailable')
    increment(qualityCounts, evidence?.quality ?? 'unavailable')
    if (evidence?.value?.method) increment(methodCounts, evidence.value.method)
    for (const source of evidence?.source ?? []) increment(sourceCounts, source)
    if (finite(evidence?.value?.cumulativeMs)) knownTurns++
    if (finite(evidence?.value?.occupiedMs)) occupiedKnownTurns++
    if (finite(evidence?.value?.timedCalls) && finite(evidence?.value?.totalCalls)) {
      observedTimedCalls += evidence.value.timedCalls
      observedTotalCalls += evidence.value.totalCalls
      callCoverageTurns++
    }
  }

  const timeline = orderedCalls(selected)
  const calls = summarizeCalls(selected)
  const errors = summarizeEvidenceCount(selected, (record) => record.errors)
  const dangers = summarizeEvidenceCount(selected, (record) => record.dangerousOperations)
  const interventions = summarizeInterventions(selected)
  const compactions = summarizeCompactions(selected)
  return {
    scope: options.scope ?? (sessionId || uniqueSessions.size === 1 ? 'session' : 'workspace'),
    sessionId: effectiveSessionId,
    sessions: uniqueSessions.size,
    turns: selected.length,
    completedTurns: turnStatusCounts.completed ?? 0,
    statusCounts: turnStatusCounts,
    verdict: {
      state: dangers.total == null || errors.total == null
        ? 'unknown'
        : dangers.total > 0
          ? 'danger'
          : errors.total > 0
            ? 'warning'
            : 'ok',
      toolErrors: errors.total,
      dangerousOperations: dangers.total
    },
    usage: summarizeUsage(selected),
    calls,
    perTurn: selected.map((record) => {
      const turnCalls = summarizeCalls([record])
      const evidence = interventionEvidence(record)
      const turnInterventions = availableArray(evidence)
        ? evidence.value.filter((intervention) => intervention.resolution !== 'provider_cancelled')
        : null
      const turnCompactions = compactionEvidence(record)
      return {
        sequence: record.sequence,
        turnIndex: record.turnIndex,
        status: record.status,
        durationMs: record.durationMs,
        calls: turnCalls.total,
        callBreakdown: {
          ordinaryTools: turnCalls.ordinaryTools.total,
          mcp: turnCalls.mcp.total,
          skills: turnCalls.skills.total,
          subagents: turnCalls.subagents.total
        },
        errors: availableArray(record.errors) ? record.errors.value.length : null,
        compactions: availableArray(turnCompactions) ? turnCompactions.value.length : null,
        interventions: turnInterventions?.length ?? null,
        interventionQuestions: turnInterventions?.reduce(
          (sum, intervention) => sum + intervention.request.questions.length,
          0
        ) ?? null
      }
    }),
    hooks: summarizeHooks(selected),
    files: summarizeFiles(selected, timeline),
    diff: summarizeDiff(selected),
    segments: summarizeSegments(selected, timeline),
    errors,
    dangerousOperations: dangers,
    interventions,
    compactions,
    wall: {
      cumulativeMs: sumKnown(selected.map((record) => record.durationMs)),
      knownTurns: selected.filter((record) => finite(record.durationMs)).length,
      totalTurns: selected.length
    },
    modelTiming: {
      cumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.cumulativeMs)),
      occupiedMs: sumKnown(selected.map((record) => record.modelTiming?.value?.occupiedMs)),
      rootCumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.root?.cumulativeMs)),
      subagentCumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.subagents?.cumulativeMs)),
      knownTurns,
      occupiedKnownTurns,
      totalTurns: selected.length,
      complete: selected.length > 0 && knownTurns === selected.length && selected.every((record) => record.modelTiming?.status === 'available'),
      responseCallCoverage: callCoverageTurns > 0
        ? { timedCalls: observedTimedCalls, totalCalls: observedTotalCalls, knownTurns: callCoverageTurns }
        : null,
      statusCounts: timingStatusCounts,
      qualityCounts,
      methodCounts,
      sourceCounts
    }
  }
}
