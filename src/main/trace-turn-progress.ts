import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { protectToolContent } from '../core/turn-recorder/content-policy.js'
import { basename, dirname, join } from 'node:path'
import type { ProviderId } from '../shared/provider.js'
import type { RuntimeProvider } from '../shared/runtime.js'
import { listFiles, readJson, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { safeKey, stableHash } from '../core/turn-recorder/store.js'
import {
  findTraceArchiveTurnMatches,
  upsertTraceArchiveTurn,
  type TraceArchiveTurn
} from './transcript-archive.js'

interface TraceTurnProgress {
  schemaVersion: 1
  // Only a running checkpoint may be superseded. Terminal progress is immutable.
  state?: 'running'
  persistedAt: string
  request: {
    cwd: string
    sessionId: string
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    turn: TraceArchiveTurn
  }
}

interface UnresolvedTraceTurnProgress {
  schemaVersion: 1
  state: 'unresolved'
  reason: 'missing_provider_session_id'
  persistedAt: string
  request: {
    cwd: string
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    turn: TraceArchiveTurn
  }
}

const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const RUNTIMES = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server', 'pi_rpc'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export interface TraceTurnProgressRecovery {
  recovered: number
  pending: number
  errors: string[]
}

function progressRoot(userDataDir: string): string {
  return join(userDataDir, 'trace-turn-progress')
}

function progressPath(userDataDir: string, runId: string): string {
  return join(progressRoot(userDataDir), `${safeKey(runId)}.json`)
}

function validProgress(value: TraceTurnProgress | null): value is TraceTurnProgress {
  const request = value?.request
  const turn = request?.turn
  return value?.schemaVersion === 1 && typeof value.persistedAt === 'string' &&
    typeof request?.cwd === 'string' &&
    typeof request.sessionId === 'string' && request.sessionId.length > 0 &&
    PROVIDERS.has(request.providerId) && RUNTIMES.has(request.runtimeProvider) &&
    Boolean(
      turn && typeof turn.runId === 'string' && turn.runId.length > 0 &&
      typeof turn.userText === 'string' && Array.isArray(turn.items) &&
      turn.items.every((item) => item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.stage === 'string') &&
      (value.state === 'running'
        ? turn.done === false && turn.status === undefined
        : value.state === undefined && turn.done === true && typeof turn.status === 'string' && TERMINAL_STATUSES.has(turn.status)) &&
      typeof turn.ts === 'number' && Number.isFinite(turn.ts)
    )
}

// 终态失败/中止、且没有任何 Provider 证据（无 Provider turn 边界，只有 harness 自己的事件）
// 的轮次，说明 Provider 在给出原生 session id 之前就没有任何产出：这个 id 永远不会到来，
// 所以它不是“待恢复的 Provider 证据”，也没有可写入的 archive key。把它留成 unresolved 只会让
// 该工作区+Provider 永久无法开始新一轮（agent:start 会 fail closed 在“仍有 N 轮待恢复”）。
// 真正必须 fail closed 的是 Provider 已经产出过内容、却丢了 session id 的轮次：那种仍保留为 pending。
// 失败本身的证据不会消失：它仍在 usage.jsonl、spans、会话 catalog 与当前轮的 trace 里。
export function isProviderlessTerminalTurn(
  turn: Pick<TraceArchiveTurn, 'status' | 'items' | 'providerTurnId' | 'forkTurnId'>
): boolean {
  if (turn.status !== 'failed' && turn.status !== 'cancelled' && turn.status !== 'interrupted') return false
  if (turn.providerTurnId || turn.forkTurnId) return false
  return turn.items.every((item) => item.kind === 'harness')
}

/**
 * A managed Provider failure before its native turn boundary has no canonical turn to commit.
 * Keep that diagnostic turn, or an acknowledged Pi command without a model turn, in Scry's
 * local progress/archive path. Neither is a canonical model turn in `.scry/records`.
 */
export function shouldUseManagedTerminalPersistence(
  managedPolicy: boolean,
  turn: Pick<TraceArchiveTurn, 'status' | 'items' | 'providerTurnId' | 'forkTurnId'>
): boolean {
  const commandOnly = !turn.providerTurnId && !turn.forkTurnId &&
    turn.items.some((item) => item.kind === 'harness' && item.stage === 'result' &&
      item.providerId === 'pi' && item.runtimeProvider === 'pi_rpc' &&
      item.providerCommand?.source === 'extension' && item.providerCommand.modelTurn === 'unobserved') &&
    !turn.items.some((item) => item.kind === 'model' || item.kind === 'agent' || item.kind === 'tool')
  return managedPolicy && !isProviderlessTerminalTurn(turn) && !commandOnly
}

function validUnresolvedProgress(value: UnresolvedTraceTurnProgress | null): value is UnresolvedTraceTurnProgress {
  const request = value?.request
  const turn = request?.turn
  return value?.schemaVersion === 1 && value.state === 'unresolved' &&
    value.reason === 'missing_provider_session_id' && typeof value.persistedAt === 'string' &&
    typeof request?.cwd === 'string' && PROVIDERS.has(request.providerId) &&
    RUNTIMES.has(request.runtimeProvider) && Boolean(
      turn && typeof turn.runId === 'string' && turn.runId.length > 0 &&
      typeof turn.userText === 'string' && Array.isArray(turn.items) &&
      turn.items.every((item) => item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.stage === 'string') &&
      turn.done === true && typeof turn.status === 'string' && TERMINAL_STATUSES.has(turn.status) &&
      typeof turn.ts === 'number' && Number.isFinite(turn.ts)
    )
}

function progressIdentity(value: unknown): { cwd: string; sessionId: string; providerId: ProviderId } | null {
  if (!value || typeof value !== 'object') return null
  const request = (value as { request?: unknown }).request
  if (!request || typeof request !== 'object') return null
  const candidate = request as { cwd?: unknown; sessionId?: unknown; providerId?: unknown }
  if (
    typeof candidate.cwd !== 'string' || typeof candidate.sessionId !== 'string' ||
    !PROVIDERS.has(candidate.providerId as ProviderId)
  ) return null
  return { cwd: candidate.cwd, sessionId: candidate.sessionId, providerId: candidate.providerId as ProviderId }
}

function identityMatches(
  identity: { cwd: string; sessionId: string; providerId: ProviderId },
  filter: { cwd?: string; sessionId?: string; providerId?: ProviderId }
): boolean {
  return (filter.cwd == null || identity.cwd === filter.cwd) &&
    (!filter.sessionId || identity.sessionId === filter.sessionId) &&
    (!filter.providerId || identity.providerId === filter.providerId)
}

function baseTurnFingerprint(turn: TraceArchiveTurn): string {
  const { turnEvidence: _turnEvidence, items, ts: _ts, ...base } = turn
  return stableHash({
    ...base,
    items: items.filter((item) => !(item.kind === 'harness' && item.stage === 'turn_diff'))
  })
}

function atomicTempPaths(path: string): string[] {
  const dir = dirname(path)
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const pattern = new RegExp(`^${base}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`)
  return names.filter((name) => pattern.test(name)).map((name) => join(dir, name))
}

type TraceProgressRequest = TraceTurnProgress['request'] & { userDataDir: string }

function sameProgressRun(a: TraceTurnProgress['request'], b: TraceTurnProgress['request']): boolean {
  return a.cwd === b.cwd && a.sessionId === b.sessionId && a.providerId === b.providerId &&
    a.runtimeProvider === b.runtimeProvider && a.turn.runId === b.turn.runId
}

// The caller serializes checkpoints and awaits the last write before terminal
// persistence, so a delayed running snapshot cannot overwrite a settled turn.
export async function persistTraceTurnCheckpoint(args: TraceProgressRequest): Promise<void> {
  const path = progressPath(args.userDataDir, args.turn.runId)
  const existing = await readJson<TraceTurnProgress>(path)
  if (existing && (!validProgress(existing) || existing.state !== 'running' || !sameProgressRun(existing.request, args))) {
    throw new Error(`trace turn checkpoint collision for ${args.turn.runId}`)
  }
  const { userDataDir: _userDataDir, ...request } = args
  const { status: _status, error: _error, completedAt: _completedAt, durationMs: _durationMs, ...turn } = request.turn
  const policy = existing?.request.turn.toolContentPolicy
  const next: TraceTurnProgress = {
    schemaVersion: 1, state: 'running', persistedAt: new Date().toISOString(),
    request: { ...request, turn: protectToolContent({ ...turn, ...(policy ? { toolContentPolicy: policy } : {}), done: false }, args.cwd) }
  }
  await writeJsonAtomic(path, next)
}

export async function persistTraceTurnProgress(args: TraceProgressRequest): Promise<void> {
  const path = progressPath(args.userDataDir, args.turn.runId)
  const existing = await readJson<TraceTurnProgress>(path)
  const policy = existing?.request.turn.toolContentPolicy
  args = { ...args, turn: protectToolContent({ ...args.turn, ...(policy ? { toolContentPolicy: policy } : {}) }, args.cwd) }
  const { userDataDir: _userDataDir, ...request } = args
  if (existing) {
    if (!validProgress(existing) || (existing.state === 'running'
      ? !sameProgressRun(existing.request, request)
      : stableHash(existing.request) !== stableHash(request))) {
      throw new Error(`trace turn progress collision for ${args.turn.runId}`)
    }
    if (existing.state !== 'running') return
  }
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    persistedAt: new Date().toISOString(),
    request
  } satisfies TraceTurnProgress)
}

export async function persistUnresolvedTraceTurnProgress(args: {
  userDataDir: string
  cwd: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  turn: TraceArchiveTurn
  reason: 'missing_provider_session_id'
}): Promise<void> {
  const path = progressPath(args.userDataDir, args.turn.runId)
  const existing = await readJson<UnresolvedTraceTurnProgress>(path)
  const policy = existing?.request.turn.toolContentPolicy
  args = { ...args, turn: protectToolContent({ ...args.turn, ...(policy ? { toolContentPolicy: policy } : {}) }, args.cwd) }
  const { userDataDir: _userDataDir, reason, ...request } = args
  const next: UnresolvedTraceTurnProgress = {
    schemaVersion: 1,
    state: 'unresolved',
    reason,
    persistedAt: new Date().toISOString(),
    request
  }
  if (existing) {
    if (!validUnresolvedProgress(existing) || stableHash(existing.request) !== stableHash(request) || existing.reason !== reason) {
      throw new Error(`trace turn progress collision for ${args.turn.runId}`)
    }
    return
  }
  await writeJsonAtomic(path, next)
}

export async function recoverTraceTurnProgress(
  userDataDir: string,
  filter: {
    cwd?: string
    sessionId?: string
    providerId?: ProviderId
    isLiveManagedRun?: (runId: string) => boolean
  } = {}
): Promise<TraceTurnProgressRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = filter.cwd != null || Boolean(filter.sessionId || filter.providerId)
  for (const name of await listFiles(progressRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(progressRoot(userDataDir), name)
    const unresolved = await readJson<UnresolvedTraceTurnProgress>(path)
    if (validUnresolvedProgress(unresolved)) {
      const request = unresolved.request
      if (filter.cwd != null && request.cwd !== filter.cwd) continue
      if (filter.sessionId) continue
      if (filter.providerId && request.providerId !== filter.providerId) continue
      if (filter.isLiveManagedRun?.(request.turn.runId)) continue
      // Provider 产出任何内容之前就失败的轮次不可能再拿到原生 session id，也不是可恢复的 Provider turn。
      // 旧版本曾把这类失败永久卡成 pending；保留它只会让修正环境后的下一次启动继续失败。
      if (isProviderlessTerminalTurn(request.turn)) {
        await rm(path, { force: true })
        recovered++
        continue
      }
      pending++
      errors.push(`unresolved trace turn progress (${unresolved.reason}): ${unresolved.request.turn.runId}`)
      continue
    }
    const progress = unresolved as unknown as TraceTurnProgress | null
    if (!validProgress(progress)) {
      const identity = progressIdentity(progress)
      if (!scoped || (identity && identityMatches(identity, filter))) {
        pending++
        errors.push(`invalid trace turn progress: ${name}`)
      }
      continue
    }
    const request = progress.request
    if (filter.cwd != null && request.cwd !== filter.cwd) continue
    if (filter.sessionId && request.sessionId !== filter.sessionId) continue
    if (filter.providerId && request.providerId !== filter.providerId) continue
    if (filter.isLiveManagedRun?.(request.turn.runId)) continue
    if (progress.state === 'running') {
      // A live owner is excluded above. Only restart recovery converts this
      // partial snapshot to interrupted; never invent a completed Provider turn.
      request.turn = { ...request.turn, done: true, status: 'interrupted',
        error: '主机退出前未记录运行终态；已恢复最后保存的内容，可能不完整。' }
    }
    const existing = findTraceArchiveTurnMatches({
      cwd: request.cwd,
      sessionId: request.sessionId,
      providerId: request.providerId,
      userDataDir,
      runId: request.turn.runId,
      providerTurnId: request.turn.providerTurnId
    }).byRunId
    if (existing) {
      if (baseTurnFingerprint(existing) !== baseTurnFingerprint(request.turn)) {
        pending++
        errors.push(`trace turn progress conflicts with committed archive: ${request.turn.runId}`)
        continue
      }
      await rm(path, { force: true })
      recovered++
      continue
    }
    const ok = upsertTraceArchiveTurn({ ...request, userDataDir })
    if (!ok) {
      pending++
      errors.push(`trace turn progress is still pending: ${request.turn.runId}`)
      continue
    }
    await rm(path, { force: true })
    recovered++
  }
  return { recovered, pending, errors }
}

export async function deleteTraceTurnProgress(userDataDir: string, runId: string): Promise<void> {
  await rm(progressPath(userDataDir, runId), { force: true })
}

export function traceProgressSessionRunIds(
  userDataDir: string,
  identity: { cwd: string; sessionId: string; providerId: ProviderId }
): string[] {
  const runIds = new Set<string>()
  let names: string[]
  try { names = readdirSync(progressRoot(userDataDir)) } catch { return [] }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const progress = JSON.parse(readFileSync(join(progressRoot(userDataDir), name), 'utf8')) as TraceTurnProgress
      if (
        validProgress(progress) && progress.request.cwd === identity.cwd &&
        progress.request.sessionId === identity.sessionId && progress.request.providerId === identity.providerId
      ) runIds.add(progress.request.turn.runId)
    } catch {
      // Invalid progress cannot safely establish session ownership.
    }
  }
  return [...runIds]
}

export function deleteTraceTurnProgressArtifacts(
  userDataDir: string,
  runIds: ReadonlySet<string>
): { failed: Array<{ path: string; error: string }> } {
  const failed: Array<{ path: string; error: string }> = []
  for (const runId of runIds) {
    const path = progressPath(userDataDir, runId)
    for (const target of [path, ...atomicTempPaths(path)]) {
      try { rmSync(target, { force: true }) } catch (error) {
        failed.push({ path: target, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { failed }
}

export function cleanupTraceTurnProgressTemps(userDataDir: string): void {
  let names: string[]
  const root = progressRoot(userDataDir)
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    if (!/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path, { force: true })
    } catch {
      // Startup cleanup is best-effort; recovery ignores temp files.
    }
  }
}
