import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { LlmPerformanceHistory, LlmPerformanceHistoryRow } from '../shared/llm-performance'
import { usageJsonlPath } from './usage-jsonl'

export const LLM_HISTORY_LIMIT = 1000

function isSample(value: unknown): value is LlmPerformanceHistoryRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row.runId !== 'string' || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) ||
    !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(String(row.providerId)) ||
    typeof row.model !== 'string' || typeof row.networkLabel !== 'string' || typeof row.failed !== 'boolean' ||
    (row.agentProfileId !== undefined && typeof row.agentProfileId !== 'string') ||
    (row.upstreamProvider !== undefined && typeof row.upstreamProvider !== 'string')) return false
  const sample = row.performance as Record<string, unknown> | undefined
  if (!sample || typeof sample !== 'object' ||
    sample.state !== 'complete' || sample.networkLabel !== row.networkLabel ||
    typeof sample.observedAt !== 'string' || !Number.isFinite(Date.parse(sample.observedAt)) ||
    !Array.isArray(sample.recentOutput) || sample.recentOutput.length !== 0) return false
  const number = (key: string): boolean => typeof sample[key] === 'number' && Number.isFinite(sample[key]) && (sample[key] as number) >= 0
  return ['streamCharacters', 'windowMs', 'streamDurationMs'].every(number) &&
    ['firstOutputWaitMs', 'averageCharactersPerSecond', 'outputTokens', 'apiDurationMs', 'apiTokensPerSecond']
      .every(key => sample[key] === undefined || number(key))
}

/** Bounded IPC payload and streaming scan; no new store or deletion ownership model. */
export async function readLlmPerformanceHistory(userDataDir: string, now = Date.now()): Promise<LlmPerformanceHistory> {
  const file = usageJsonlPath(userDataDir)
  const history: LlmPerformanceHistory = { rows: [], invalidLines: 0, truncated: false }
  if (!existsSync(file)) return history
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  const rows = new Map<string, LlmPerformanceHistoryRow>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { history.invalidLines++; continue }
    if (!parsed || typeof parsed !== 'object') { history.invalidLines++; continue }
    const value = (parsed as Record<string, unknown>).performanceSample
    // Old usage rows have no measurement; never invent zero speed for them.
    if (value === undefined) continue
    if (!isSample(value)) { history.invalidLines++; continue }
    if (Date.parse(value.ts) < now - 30 * 86400_000) continue
    rows.delete(value.runId)
    rows.set(value.runId, value)
    if (rows.size > LLM_HISTORY_LIMIT) {
      rows.delete(rows.keys().next().value!)
      history.truncated = true
    }
  }
  history.rows = [...rows.values()].reverse()
  return history
}
