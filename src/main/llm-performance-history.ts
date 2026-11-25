import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { LlmPerformanceHistory, LlmPerformanceHistoryRow } from '../shared/llm-performance'
import { observeAntigravityTranscriptModel } from './providers/antigravity-transcript-model'
import { readTraceArchiveTurnForHistory } from './transcript-archive-read'
import { usageJsonlPath } from './usage-jsonl'

export const LLM_HISTORY_LIMIT = 1000
const ANTIGRAVITY_LOOKUP_LIMIT = 24
const MAX_ARCHIVED_TURN_BYTES = 2 * 1024 * 1024
const RECENT_ARCHIVE_WINDOW_MS = 15_000

type HistoryEntry = { sample: LlmPerformanceHistoryRow; cwd?: string; sessionId?: string }

async function withAntigravityModel(userDataDir: string, entry: HistoryEntry): Promise<LlmPerformanceHistoryRow> {
  const { sample, cwd, sessionId } = entry
  const outputTokens = sample.performance.outputTokens
  if (cwd === undefined || !sessionId || !outputTokens) return sample
  try {
    const { turn } = await readTraceArchiveTurnForHistory({
      userDataDir, cwd, sessionId, providerId: 'antigravity', runId: sample.runId, maxBytes: MAX_ARCHIVED_TURN_BYTES
    })
    const result = turn.items.findLast(item => item.kind === 'harness' && item.stage === 'result')
    if ((turn.agentProfileId ?? undefined) !== sample.agentProfileId) return sample
    const model = await observeAntigravityTranscriptModel({ sessionId, startedAt: turn.startedAt, result, outputTokens })
    return model ? { ...sample, model, modelSource: 'antigravity_transcript' } : sample
  } catch {
    // An absent, oversized or unreadable sidecar cannot change the recorded performance sample.
    return sample
  }
}

function isSample(value: unknown): value is LlmPerformanceHistoryRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row.runId !== 'string' || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) ||
    !['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'].includes(String(row.providerId)) ||
    (row.model !== undefined && typeof row.model !== 'string') || typeof row.networkLabel !== 'string' || typeof row.failed !== 'boolean' ||
    (row.modelSource !== undefined && (row.modelSource !== 'antigravity_transcript' || row.providerId !== 'antigravity')) ||
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
    ['firstOutputWaitMs', 'averageCharactersPerSecond', 'outputTokens', 'apiDurationMs', 'apiTokensPerSecond', 'llmCalls', 'firstTokenMs', 'firstTokenCalls']
      .every(key => sample[key] === undefined || number(key))
}

/** Bounded IPC payload and streaming scan; no new store or deletion ownership model. */
async function scanLlmPerformanceHistory(userDataDir: string, file: string, now: number): Promise<LlmPerformanceHistory> {
  const history: LlmPerformanceHistory = { rows: [], invalidLines: 0, truncated: false }
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  const rows = new Map<string, HistoryEntry>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { history.invalidLines++; continue }
    if (!parsed || typeof parsed !== 'object') { history.invalidLines++; continue }
    const { performanceSample: value, cwd, externalSessionId } = parsed as Record<string, unknown>
    // Old usage rows have no measurement; never invent zero speed for them.
    if (value === undefined) continue
    if (!isSample(value)) { history.invalidLines++; continue }
    if (Date.parse(value.ts) < now - 30 * 86400_000) continue
    rows.delete(value.runId)
    rows.set(value.runId, {
      sample: value,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      sessionId: typeof externalSessionId === 'string' ? externalSessionId : undefined
    })
    if (rows.size > LLM_HISTORY_LIMIT) {
      rows.delete(rows.keys().next().value!)
      history.truncated = true
    }
  }
  let lookups = 0
  for (const entry of [...rows.values()].reverse()) {
    const { sample } = entry
    const needsModel = sample.providerId === 'antigravity' && !sample.failed && !sample.modelSource && sample.performance.outputTokens &&
      entry.sessionId && entry.cwd !== undefined && Boolean(sample.model) &&
      (sample.model === '未知模型' || (sample.model?.startsWith('所选：') ?? false))
    history.rows.push(needsModel && lookups++ < ANTIGRAVITY_LOOKUP_LIMIT
      ? await withAntigravityModel(userDataDir, entry)
      : sample)
  }
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
  const entry = { file, signature, expiresAt: Infinity, value: scanLlmPerformanceHistory(userDataDir, file, now) }
  historyCache = entry
  try {
    const history = await entry.value
    entry.expiresAt = Math.min(...history.rows.map(row => Date.parse(row.ts) + 30 * 86400_000 + 1))
    // The usage row can become visible before the terminal archive. Retry recent unresolved turns on the next cache window.
    if (history.rows.some(row => row.providerId === 'antigravity' && !row.failed && !row.modelSource && row.model &&
      (row.model === '未知模型' || row.model.startsWith('所选：')) && Date.parse(row.ts) > now - RECENT_ARCHIVE_WINDOW_MS)) {
      entry.expiresAt = Math.min(entry.expiresAt, now + 1_000)
    }
    return history
  } catch (error) {
    if (historyCache === entry) historyCache = undefined
    throw error
  }
}
