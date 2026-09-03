import { createHash } from 'node:crypto'
import { evidenceStatusMap, type AgentTurnRecord, type Evidence, type TurnCall } from '../shared/turn-record.js'

/**
 * Read-only projection for external uploaders.
 *
 * The commit hook only hands an uploader a workspace + recordId, so without this command the
 * uploader must read `.scry/records` itself and every team re-implements redaction. Keeping the
 * projection here means redaction lives in reviewed CLI code, and an uploader can be given
 * projection output only — it never needs read access to the records at all.
 *
 * `team-metadata@1` deliberately excludes prompt and assistant text (and their hashes, which are
 * dictionary-recoverable for common prompts), tool inputs and outputs, file paths, patches, repo
 * remotes, the workspace path, and environment values. Unobservable numbers are emitted as null
 * with an evidence entry, never as 0.
 */
export const PROJECTION_POLICIES = ['team-metadata@1'] as const
export type ProjectionPolicy = typeof PROJECTION_POLICIES[number]

export function isProjectionPolicy(value: string): value is ProjectionPolicy {
  return (PROJECTION_POLICIES as readonly string[]).includes(value)
}

export interface ProjectedTurn {
  schemaVersion: 1
  policyVersion: ProjectionPolicy
  recorderVersion: string
  /** Null on records written before capture presets existed — not silently assumed current. */
  capturePolicy: string | null
  workspaceIdHash: string
  provider: { id: string; model: string | null }
  sessionId: string
  recordId: string
  sequence: number
  turnIndex: number
  startedAt: string
  completedAt: string
  durationMs: number
  status: AgentTurnRecord['status']
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cacheCreationTokens: number | null
    reasoningTokens: number | null
    costUsd: number | null
  } | null
  modelTiming: { cumulativeMs: number | null; occupiedMs: number | null } | null
  counts: {
    tools: number | null
    skills: number | null
    mcps: number | null
    agents: number | null
    hookInstances: number | null
    filesTouched: number | null
  }
  interventions: { count: number; waitMs: number; byKind: Record<string, number> } | null
  dangerousOperations: Array<{ level: string; reason: string; tool: string | null }> | null
  compactions: number | null
  diffStats: { filesChanged: number; added: number; removed: number } | null
  errors: number | null
  evidence: Record<string, string>
}

function usable<T>(evidence: Evidence<T> | undefined): T | null {
  if (!evidence) return null
  if (evidence.status !== 'available' && evidence.status !== 'partial') return null
  return evidence.value ?? null
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type CallCategory = NonNullable<TurnCall['category']>

/** One pass over the call sections; null when no section is observable at all. */
function callCounts(record: AgentTurnRecord): Record<CallCategory, number | null> {
  const counts: Record<CallCategory, number> = { tool: 0, skill: 0, agent: 0, mcp: 0 }
  let known = false
  for (const section of [record.tools, record.skills, record.mcps] as Array<Evidence<TurnCall[]> | undefined>) {
    const calls = usable(section)
    if (!calls) continue
    known = true
    for (const call of calls) counts[call.category ?? 'tool']++
  }
  if (!known) return { tool: null, skill: null, agent: null, mcp: null }
  return counts
}

export function projectTurn(
  record: AgentTurnRecord,
  policy: ProjectionPolicy
): ProjectedTurn {
  const usage = usable(record.usage)
  const timing = usable(record.modelTiming)
  const hooks = usable(record.hooks)
  const files = usable(record.files)
  const diffs = usable(record.diff)
  const dangers = usable(record.dangerousOperations)
  const interventions = usable(record.interventions)
  const compactions = usable(record.compactions)
  const errors = usable(record.errors)

  const evidence = evidenceStatusMap(record)
  const counts = callCounts(record)

  const diffStats = diffs
    ? diffs.reduce(
        (total, snapshot) => {
          for (const file of snapshot.files ?? []) {
            total.filesChanged++
            total.added += Number.isFinite(file.added) ? file.added : 0
            total.removed += Number.isFinite(file.deleted) ? file.deleted : 0
          }
          return total
        },
        { filesChanged: 0, added: 0, removed: 0 }
      )
    : null

  return {
    schemaVersion: 1,
    policyVersion: policy,
    recorderVersion: record.recorderVersion,
    capturePolicy: record.capturePolicy ?? null,
    // The workspace id is often the directory name, so it is hashed rather than sent.
    workspaceIdHash: `sha256:${createHash('sha256').update(record.workspace.id).digest('hex')}`,
    provider: { id: record.provider.id, model: record.provider.model ?? null },
    sessionId: record.sessionId,
    recordId: record.recordId,
    sequence: record.sequence,
    turnIndex: record.turnIndex,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    status: record.status,
    usage: usage
      ? {
          inputTokens: numberOrNull(usage.inputTokens),
          outputTokens: numberOrNull(usage.outputTokens),
          cacheReadTokens: numberOrNull(usage.cacheReadTokens),
          cacheCreationTokens: numberOrNull(usage.cacheCreationTokens),
          reasoningTokens: numberOrNull(usage.reasoningTokens),
          costUsd: numberOrNull(usage.costUsd)
        }
      : null,
    modelTiming: timing
      ? { cumulativeMs: numberOrNull(timing.cumulativeMs), occupiedMs: numberOrNull(timing.occupiedMs) }
      : null,
    counts: {
      tools: counts.tool,
      skills: counts.skill,
      mcps: counts.mcp,
      agents: counts.agent,
      hookInstances: hooks ? hooks.length : null,
      filesTouched: files ? files.length : null
    },
    interventions: interventions
      ? {
          count: interventions.length,
          waitMs: interventions.reduce((sum, item) => sum + (numberOrNull(item.durationMs) ?? 0), 0),
          // Only the classification and resolution travel; question and answer text never does.
          byKind: interventions.reduce<Record<string, number>>((byKind, item) => {
            const key = `${item.kind}:${item.resolution}`
            byKind[key] = (byKind[key] ?? 0) + 1
            return byKind
          }, {})
        }
      : null,
    // `reason` is a fixed classification produced by the danger classifier, not command text.
    dangerousOperations: dangers
      ? dangers.map((danger) => ({ level: danger.level, reason: danger.reason, tool: danger.tool ?? null }))
      : null,
    compactions: compactions ? compactions.length : null,
    diffStats,
    errors: errors ? errors.length : null,
    evidence
  }
}
