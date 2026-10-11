import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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
  if (sample.networkConfiguration !== undefined) {
    const config = sample.networkConfiguration as Record<string, unknown> | null
    const switches = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object' &&
      Object.keys(value).length === keys.length && keys.every(key => typeof (value as Record<string, unknown>)[key] === 'boolean'))
    if (!config || Object.keys(config).length !== 4 ||
      typeof config.observedAt !== 'string' || !Number.isFinite(Date.parse(config.observedAt)) ||
      !['macos-system-and-app-environment', 'app-environment'].includes(String(config.source)) ||
      !(config.systemProxy === null || switches(config.systemProxy, ['http', 'https', 'socks', 'pac', 'discovery'])) ||
      !switches(config.environmentProxy, ['http', 'https', 'all', 'bypass'])) return false
  }
  const number = (key: string): boolean => typeof sample[key] === 'number' && Number.isFinite(sample[key]) && (sample[key] as number) >= 0
  if (sample.tokenTimingSource !== undefined && !['provider_api', 'observed_calls'].includes(String(sample.tokenTimingSource))) return false
  if (sample.model !== undefined && typeof sample.model !== 'string') return false
  return ['streamCharacters', 'windowMs', 'streamDurationMs'].every(number) &&
    ['firstOutputWaitMs', 'averageCharactersPerSecond', 'outputTokens', 'apiDurationMs', 'apiTokensPerSecond', 'llmCalls']
      .every(key => sample[key] === undefined || number(key))
}

/** Bounded IPC payload and streaming scan; no new store or deletion ownership model. */
async function scanLlmPerformanceHistory(file: string, now: number): Promise<LlmPerformanceHistory> {
  const history: LlmPerformanceHistory = { rows: [], invalidLines: 0, truncated: false }
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

let historyCache: { file: string; signature: string; expiresAt: number; value: Promise<LlmPerformanceHistory> } | undefined

/** File identity invalidates both appends and atomic session deletions; concurrent readers share scans. */
export async function readLlmPerformanceHistory(userDataDir: string, now = Date.now()): Promise<LlmPerformanceHistory> {
  const file = usageJsonlPath(userDataDir)
  let info: Awaited<ReturnType<typeof stat>>
  try { info = await stat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (historyCache?.file === file) historyCache = undefined
    return { rows: [], invalidLines: 0, truncated: false }
  }
  const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const cached = historyCache
  if (cached?.file === file && cached.signature === signature && now < cached.expiresAt) return cached.value
  const entry = { file, signature, expiresAt: Infinity, value: scanLlmPerformanceHistory(file, now) }
  historyCache = entry
  try {
    const history = await entry.value
    entry.expiresAt = Math.min(...history.rows.map(row => Date.parse(row.ts) + 30 * 86400_000 + 1))
    return history
  } catch (error) {
    if (historyCache === entry) historyCache = undefined
    throw error
  }
}
