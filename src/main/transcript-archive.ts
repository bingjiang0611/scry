import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeTurnDiffSnapshot, type TraceEvent } from '../shared/trace'
import type { AgentInputAttachment } from '../shared/runtime'
import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { AgentTurnRecord, TurnEvidence } from '../shared/turn-record'

// Claude Code transcript 目录编码：路径里的 / . _ 都换成 -
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-')
}

export function transcriptDir(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', encodeCwd(cwd))
}

export function transcriptPath(cwd: string, sessionId: string, home = homedir()): string {
  return join(transcriptDir(cwd, home), sessionId + '.jsonl')
}

export function archivedTranscriptPath(userDataDir: string, cwd: string, sessionId: string): string {
  return join(userDataDir, 'transcripts', encodeCwd(cwd), sessionId + '.jsonl')
}

export interface TraceArchiveTurn {
  runId: string
  providerTurnId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  status?: AgentTurnRecord['status']
  error?: string
  errorHint?: string
  turnEvidence?: TurnEvidence
  startedAt?: string
  completedAt?: string
  durationMs?: number
  ts: number
}

export interface TraceArchive {
  version: 1 | 2
  cwd: string
  sessionId: string
  externalSessionId?: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  turns: TraceArchiveTurn[]
}

export function legacyTraceArchivePath(userDataDir: string, cwd: string, sessionId: string): string {
  return join(userDataDir, 'trace-archives', encodeCwd(cwd), sessionId + '.json')
}

export function traceArchivePath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId = 'claude'): string {
  return join(userDataDir, 'trace-archives-v2', providerId, encodeCwd(cwd), sessionId + '.json')
}

export function inferTraceArchiveProvider(archive: TraceArchive): ProviderId | undefined {
  if (archive.providerId) return archive.providerId
  for (const turn of archive.turns) {
    for (const item of turn.items) {
      if (item.providerId) return item.providerId
      if (item.runtimeProvider) return providerIdForRuntime(item.runtimeProvider)
    }
  }
  return undefined
}

function readArchiveFile(fp: string, cwd: string, sessionId: string): TraceArchive | null {
  try {
    if (!existsSync(fp)) return null
    const parsed = JSON.parse(readFileSync(fp, 'utf8')) as TraceArchive
    if ((parsed.version !== 1 && parsed.version !== 2) || parsed.cwd !== cwd || parsed.sessionId !== sessionId || !Array.isArray(parsed.turns)) return null
    parsed.turns = parsed.turns.map((turn) => ({
      ...turn,
      items: Array.isArray(turn.items)
        ? turn.items.map((event) => {
            if (event.stage !== 'turn_diff') return event
            const turnDiff = normalizeTurnDiffSnapshot(event.turnDiff)
            return {
              ...event,
              turnDiff:
                turnDiff ??
                {
                  version: 1,
                  status: 'failed',
                  reason: 'git_error',
                  files: [],
                  beforeAt: event.ts,
                  afterAt: event.ts,
                  captureMs: 0,
                  cleanup: 'failed'
                }
            }
          })
        : []
    }))
    return parsed
  } catch {
    return null
  }
}

export function readTraceArchive(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId?: ProviderId
}): TraceArchive | null {
  if (args.providerId) {
    const current = readArchiveFile(
      traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
      args.cwd,
      args.sessionId
    )
    if (current) return current
  }
  const legacy = readArchiveFile(legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId), args.cwd, args.sessionId)
  if (!legacy) return null
  const inferred = inferTraceArchiveProvider(legacy)
  if (args.providerId && inferred !== args.providerId) return null
  return legacy
}

export function upsertTraceArchiveTurn(args: {
  cwd: string
  sessionId: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  userDataDir: string
  turn: Omit<TraceArchiveTurn, 'ts'> & { ts?: number }
}): boolean {
  if (!args.cwd || !args.sessionId) return false
  const providerId = args.providerId ?? 'claude'
  const fp = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId)
  const existing = readArchiveFile(fp, args.cwd, args.sessionId) ?? {
    version: 2 as const,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId,
    runtimeProvider: args.runtimeProvider,
    turns: []
  }
  const turn: TraceArchiveTurn = {
    ...args.turn,
    // capture 层已经按总字节数截断 patch；保留它才能让重启/切换后的 Review
    // 与实时会话一致，避免“有 +/- 统计但历史无 diff”的假降级。
    items: args.turn.items,
    ts: args.turn.ts ?? Date.now()
  }
  const index = existing.turns.findIndex((item) => item.runId === turn.runId)
  if (index === -1) existing.turns.push(turn)
  else existing.turns[index] = turn
  const tmp = fp + '.tmp'
  try {
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(existing)}\n`)
    renameSync(tmp, fp)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return false
  }
}

export function resolveTranscriptPath(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): string | null {
  const primary = transcriptPath(args.cwd, args.sessionId, args.home)
  if (existsSync(primary)) return primary
  const archived = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  if (existsSync(archived)) return archived
  return null
}

export function mirrorTranscript(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): boolean {
  const source = transcriptPath(args.cwd, args.sessionId, args.home)
  if (!existsSync(source)) return false
  const dest = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  const tmp = dest + '.tmp'
  try {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, tmp)
    renameSync(tmp, dest)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return false
  }
}

export function deleteTranscriptCopies(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
  providerId?: ProviderId
}): void {
  const files = [traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId ?? 'claude')]
  if (!args.providerId || args.providerId === 'claude') {
    files.push(
      transcriptPath(args.cwd, args.sessionId, args.home),
      archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId),
      legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId)
    )
  }
  for (const fp of files) {
    try {
      unlinkSync(fp)
    } catch {
      /* ignore */
    }
  }
}
