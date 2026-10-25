import { createHash, randomUUID } from 'node:crypto'
import { stat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { creditUsageEvidence } from '../../shared/credit-usage.js'
import { qoderCreditRequests } from '../../shared/qoder-credit-requests.js'
import { parseCodexRollout } from './recorder-codex-rollout.js'
import { type ParsedTranscriptTurn, type TranscriptRead, overlapsTurn } from './recorder-contracts.js'
import { readTranscriptWindow, transcriptIdentity, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'


async function codexChildRollout(parentPath: string, sessionId: string): Promise<string | undefined> {
  const dayDir = dirname(parentPath)
  const findIn = async (dir: string): Promise<string | undefined> => {
    try {
      const names = await readdir(dir)
      const name = names.find((candidate) => candidate.endsWith(`-${sessionId}.jsonl`) || candidate === `${sessionId}.jsonl`)
      return name ? join(dir, name) : undefined
    } catch {
      return undefined
    }
  }
  const sameDay = await findIn(dayDir)
  if (sameDay) return sameDay
  // A long parent turn can cross midnight. Bound the fallback to sibling day directories in the same month.
  const monthDir = dirname(dayDir)
  try {
    const days = await readdir(monthDir, { withFileTypes: true })
    for (const day of days) {
      if (!day.isDirectory() || join(monthDir, day.name) === dayDir) continue
      const found = await findIn(join(monthDir, day.name))
      if (found) return found
    }
  } catch {
    // Missing/legacy session layout remains partial evidence, never a recorder failure.
  }
  return undefined
}

async function codexTurnWithChildren(
  turn: ParsedTranscriptTurn,
  transcriptPath: string,
  runId: string,
  seen = new Set<string>()
): Promise<{ events: TraceEvent[]; complete: boolean; observable: TranscriptRead['observable'] }> {
  const events = [...turn.events]
  const observable = { ...turn.observable }
  let complete = true
  for (const child of turn.childThreads) {
    if (seen.has(child.sessionId)) continue
    seen.add(child.sessionId)
    const childPath = await codexChildRollout(transcriptPath, child.sessionId)
    if (!childPath) {
      complete = false
      continue
    }
    let parsed: ReturnType<typeof parseCodexRollout>
    try {
      const childIdentity = transcriptIdentity(await stat(childPath))
      const childTranscript = await readTranscriptWindow(childPath, childIdentity.size, 0, childIdentity)
      parsed = parseCodexRollout(childTranscript.content, runId)
      complete = complete && childTranscript.consistent && !childTranscript.truncated
    } catch {
      complete = false
      continue
    }
    const childTurns = parsed.turns.filter((candidate) => overlapsTurn(turn, candidate))
    if (!parsed.recognized || childTurns.length === 0) {
      complete = false
      continue
    }
    for (const childTurn of childTurns) {
      const nested = await codexTurnWithChildren(childTurn, childPath, runId, seen)
      complete = complete && nested.complete
      observable.skills = observable.skills || nested.observable.skills
      observable.mcps = observable.mcps || nested.observable.mcps
      observable.hooks = observable.hooks || nested.observable.hooks
      observable.files = observable.files || nested.observable.files
      observable.errors = observable.errors || nested.observable.errors
      events.push(...nested.events.flatMap((event): TraceEvent[] => {
        // Root usage and assistant response are authoritative for the user turn; child usage/text must not be added again.
        if (event.kind === 'model' || (event.kind === 'harness' && event.stage === 'result')) return []
        return [{
          ...event,
          agentId: event.agentId ?? child.sessionId,
          parentToolUseId: event.parentToolUseId ?? child.parentToolUseId,
          runtimeMetadata: {
            ...event.runtimeMetadata,
            childTranscript: childPath,
            childAgent: child.name ?? child.sessionId
          }
        }]
      }))
    }
  }
  return { events, complete, observable }
}

export async function parseTranscriptSnapshot(args: {
  path: string
  endOffset: number
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity?: TranscriptSnapshotIdentity
}): Promise<TranscriptRead> {
  const snapshot = await readTranscriptWindow(args.path, args.endOffset, args.startOffset, args.identity)
  const stable = args.stable && snapshot.consistent
  const source = snapshot.consistent && snapshot.identity ? {
    content: snapshot.content,
    sourcePath: args.path,
    startOffset: snapshot.startOffset,
    endOffset: snapshot.endOffset,
    identity: snapshot.identity,
    sourceCompleteness: snapshot.truncated ? 'partial' as const : 'complete' as const
  } : undefined
  if (args.provider === 'codex') {
    const parsed = parseCodexRollout(snapshot.content, args.runId)
    const direct = args.providerTurnId ? parsed.turns.find((turn) => turn.providerTurnId === args.providerTurnId) : undefined
    const matching = args.promptHash
      ? [...parsed.turns].reverse().find((turn) => {
          const candidates = [turn.userText, turn.userText.replace(/^\/[A-Za-z0-9_-]+\s*/, '')]
          return candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === args.promptHash)
        })
      : undefined
    const turn = args.providerTurnId
      ? direct
      : args.promptHash
        ? matching
        : parsed.turns.at(-1)
    const identityMatched = !args.providerTurnId && !args.promptHash ? undefined : !!turn
    const enriched = turn
      ? await codexTurnWithChildren(turn, args.path, args.runId)
      : {
          events: [],
          complete: false,
          observable: {
            tools: false,
            skills: false,
            mcps: false,
            hooks: false,
            usage: false,
            files: false,
            errors: false
          }
        }
    return {
      stable,
      ...(source ? { source } : {}),
      observed: parsed.recognized,
      ...(identityMatched != null ? { identityMatched } : {}),
      complete: stable && !snapshot.truncated && enriched.complete,
      ...(turn?.terminalStatus ? { terminalStatus: turn.terminalStatus } : {}),
      ...(turn?.completedAt ? { completedAt: turn.completedAt } : {}),
      ...(turn?.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn?.durationMs != null ? { durationMs: turn.durationMs } : {}),
      toolStreamComplete: stable && !snapshot.truncated && !!turn && turn.pendingToolCalls.size === 0,
      ...(turn?.userText ? { userText: turn.userText } : {}),
      events: enriched.events,
      observable: enriched.observable
    }
  }
  const turns = parseTranscriptToTurns(snapshot.content, {
    runId: args.runId,
    newId: () => `transcript-${randomUUID()}`,
    now: () => new Date().toISOString()
  })
  const direct = args.providerTurnId
    ? turns.find((turn) => turn.providerTurnId === args.providerTurnId)
    : undefined
  const matching = args.promptHash
    ? [...turns].reverse().find((turn) => {
        const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(turn.userText)
        const candidates = [
          turn.userText,
          ...(command ? [`${command[1]}${command[2].trim() ? ` ${command[2].trim()}` : ''}`] : [])
        ]
        return candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === args.promptHash)
      })
    : undefined
  const turn = args.providerTurnId
    ? direct
    : args.promptHash
      ? matching
      : turns.at(-1)
  const identityMatched = !args.providerTurnId && !args.promptHash ? undefined : !!turn
  const events = [...turn?.items ?? []]
  if (args.provider === 'qoder' && turn) {
    // Prompt text can recover display content, but is not billing identity.
    // Only the hook's authoritative ID may select a root; let the native parser
    // reject duplicate prompt IDs instead of promoting the first parsed UUID.
    const parsed = qoderCreditRequests(snapshot.content, args.providerTurnId ? [{
      runId: args.runId, providerTurnId: args.providerTurnId
    }] : [])
    events.push({
      id: `credits:${args.runId}`, runId: args.runId,
      ts: events.at(-1)?.ts ?? new Date().toISOString(),
      kind: 'harness', stage: 'credit_usage', runtimeProvider: 'qoder_cli',
      creditUsage: creditUsageEvidence(parsed.requests, 'qoder_native_transcript')
    })
  }
  return {
    stable,
    ...(source ? { source } : {}),
    observed: turns.length > 0,
    ...(identityMatched != null ? { identityMatched } : {}),
    complete: stable && !snapshot.truncated,
    ...(turn?.userText ? { userText: turn.userText } : {}),
    events,
    observable: {
      tools: turns.length > 0,
      skills: turns.length > 0,
      mcps: turns.length > 0,
      hooks: events.some((event) => event.kind === 'hook'),
      usage: events.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage')),
      files: events.some((event) => !!event.filePath && !!event.fileOp),
      errors: turns.length > 0
    }
  }
}
