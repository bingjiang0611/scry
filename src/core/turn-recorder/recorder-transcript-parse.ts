import { createHash, randomUUID } from 'node:crypto'
import { stat, opendir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { creditUsageEvidence } from '../../shared/credit-usage.js'
import { qoderCreditRequests } from '../../shared/qoder-credit-requests.js'
import { parseCodexRollout } from './recorder-codex-rollout.js'
import { qoderSidecarEvents } from './recorder-qoder-sidecars.js'
import { type CodexRolloutIdentity, type ParsedTranscriptTurn, type TranscriptRead, overlapsTurn } from './recorder-contracts.js'
import { readTranscriptWindow, transcriptIdentity, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'
import { parsePiTranscript } from './recorder-pi-transcript.js'


async function codexChildRollout(parentPath: string, sessionId: string): Promise<string | undefined> {
  const dayDir = dirname(await realpath(parentPath))
  let scanned = 0
  const findIn = async (dir: string): Promise<string | undefined> => {
    try {
      const entries = await opendir(dir)
      for await (const entry of entries) {
        if (++scanned > 4096) return undefined
        if (entry.isFile() && (entry.name.endsWith(`-${sessionId}.jsonl`) || entry.name === `${sessionId}.jsonl`))
          return join(dir, entry.name)
      }
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const sameDay = await findIn(dayDir)
  if (sameDay) return sameDay
  // Only the native YYYY/MM/DD layout authorizes a sibling-day lookup; never scan
  // arbitrary siblings of a custom transcript directory. Symlink entries are excluded.
  if (!/[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}$/.test(dayDir)) return undefined
  const monthDir = dirname(dayDir)
  try {
    const days = await opendir(monthDir)
    for await (const day of days) {
      if (++scanned > 4096) break
      if (!day.isDirectory() || !/^\d{2}$/.test(day.name) || join(monthDir, day.name) === dayDir) continue
      const found = await findIn(join(monthDir, day.name))
      if (found) return found
    }
  } catch {
    // Missing/legacy session layout remains partial evidence, never a recorder failure.
  }
  return undefined
}

function trustedCodexChild(
  child: { sessionId: string },
  childIdentity: CodexRolloutIdentity,
  parentIdentity: CodexRolloutIdentity
): boolean {
  if (!parentIdentity.sessionId || !parentIdentity.cwd || !childIdentity.isSubagent) return false
  return childIdentity.sessionId === child.sessionId &&
    childIdentity.parentSessionId === parentIdentity.sessionId &&
    childIdentity.parentThreadId === parentIdentity.sessionId &&
    childIdentity.forkedFromId === parentIdentity.sessionId &&
    childIdentity.cwd === parentIdentity.cwd
}

async function codexTurnWithChildren(
  turn: ParsedTranscriptTurn,
  transcriptPath: string,
  runId: string,
  parentIdentity: CodexRolloutIdentity,
  budget = { seen: new Set<string>(), remainingBytes: 64 * 1024 * 1024 }
): Promise<{ events: TraceEvent[]; complete: boolean; observable: TranscriptRead['observable'] }> {
  const events = [...turn.events]
  const observable = { ...turn.observable }
  let complete = true
  for (const child of turn.childThreads) {
    if (budget.seen.has(child.sessionId)) continue
    if (budget.seen.size >= 64) { complete = false; break }
    budget.seen.add(child.sessionId)
    let childPath: string | undefined
    let parsed: ReturnType<typeof parseCodexRollout>
    try {
      childPath = await codexChildRollout(transcriptPath, child.sessionId)
      if (!childPath) { complete = false; continue }
      const childIdentity = transcriptIdentity(await stat(childPath))
      // Child logs contain copied ancestor history. Bound the entire traversal,
      // not just the count of files; over-budget evidence stays explicitly partial.
      if (childIdentity.size > 16 * 1024 * 1024 || childIdentity.size > budget.remainingBytes) {
        complete = false
        continue
      }
      budget.remainingBytes -= childIdentity.size
      const childTranscript = await readTranscriptWindow(childPath, childIdentity.size, 0, childIdentity)
      parsed = parseCodexRollout(childTranscript.content, runId)
      complete = complete && childTranscript.consistent && !childTranscript.truncated
    } catch {
      complete = false
      continue
    }
    if (!trustedCodexChild(child, parsed.identity, parentIdentity)) {
      complete = false
      continue
    }
    const childTurns = parsed.turns.filter((candidate) =>
      overlapsTurn(turn, candidate) && (!child.parentTurnId || candidate.parentTurnId === child.parentTurnId)
    )
    if (!parsed.recognized || childTurns.length === 0) {
      complete = false
      continue
    }
    for (const childTurn of childTurns) {
      const nested = await codexTurnWithChildren(childTurn, childPath, runId, parsed.identity, budget)
      complete = complete && nested.complete
      observable.skills = observable.skills || nested.observable.skills
      observable.mcps = observable.mcps || nested.observable.mcps
      observable.hooks = observable.hooks || nested.observable.hooks
      observable.files = observable.files || nested.observable.files
      observable.errors = observable.errors || nested.observable.errors
      events.push(...nested.events.flatMap((event): TraceEvent[] => {
        // Child text retains its scope in modelSegments; only root usage is authoritative.
        if (event.kind === 'harness' && event.stage === 'result') return []
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
  requestSetId?: string
  sessionId?: string
  cwd?: string
  piTranscriptAnchor?: import('./recorder-contracts.js').PiTranscriptAnchor
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
  if (args.provider === 'pi') {
    // The bounded turn window excludes the session header. Check it against the
    // same file identity before trusting native entry IDs from that window.
    let content = snapshot.content
    if (snapshot.startOffset > 0 && snapshot.identity) {
      const header = await readTranscriptWindow(args.path, Math.min(snapshot.identity.size, 256 * 1024), 0, snapshot.identity)
      const newline = header.content.indexOf('\n')
      content = header.consistent && newline >= 0 ? header.content.slice(0, newline + 1) + content : ''
    }
    const parsed = parsePiTranscript(content, args.runId, args.piTranscriptAnchor, {
      sessionId: args.sessionId,
      cwd: args.cwd
    })
    return {
      ...parsed,
      stable,
      ...(source ? { source } : {}),
      complete: stable && !snapshot.truncated && parsed.complete === true
    }
  }
  if (args.provider === 'codex') {
    let sessionIdentity: CodexRolloutIdentity | undefined
    // Turn anchoring excludes the session header. Child activity needs that identity;
    // ordinary turns do not pay for another read. The head must match this snapshot.
    const hasChildActivity = snapshot.content.includes('"SubAgentActivity"') || snapshot.content.includes('"sub_agent_activity"')
    if (hasChildActivity && snapshot.startOffset > 0 && snapshot.identity) {
      const header = await readTranscriptWindow(args.path, Math.min(snapshot.identity.size, 256 * 1024), 0, snapshot.identity)
      if (header.consistent) {
        const newline = header.content.indexOf('\n')
        if (newline >= 0) sessionIdentity = parseCodexRollout(header.content.slice(0, newline + 1), args.runId).identity
      }
    }
    const parsed = parseCodexRollout(snapshot.content, args.runId, sessionIdentity)
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
      ? await codexTurnWithChildren(turn, args.path, args.runId, parsed.identity)
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
      ...(turn?.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
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
  const identityEligible = (turn: typeof turns[number]): boolean =>
    turn.identityEligible !== false && turn.identityContradictory !== true
  const direct = args.providerTurnId
    ? turns.find((turn) => identityEligible(turn) && turn.providerTurnId === args.providerTurnId)
    : args.requestSetId
      ? (() => {
          const matches = turns.filter((turn) => identityEligible(turn) && turn.requestSetId === args.requestSetId && !!turn.providerTurnId)
          return matches.length === 1 ? matches[0] : undefined
        })()
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
  const turn = args.providerTurnId || args.requestSetId
    ? direct
    : args.promptHash
      ? matching
      : turns.at(-1)
  const identityMatched = !args.providerTurnId && !args.requestSetId && !args.promptHash ? undefined : !!turn
  const events = [...turn?.items ?? []]
  let qoderSidecarsComplete = true
  let qoderSidecarObservable: TranscriptRead['observable'] | undefined
  if (args.provider === 'qoder' && turn) {
    // Prompt text can recover display content, but is not billing identity.
    // Only the hook's authoritative ID may select a root; let the native parser
    // reject duplicate prompt IDs instead of promoting the first parsed UUID.
    const parsed = qoderCreditRequests(snapshot.content, args.providerTurnId || args.requestSetId ? [{
      runId: args.runId, providerTurnId: args.providerTurnId, requestSetId: args.requestSetId
    }] : [])
    events.push({
      id: `credits:${args.runId}`, runId: args.runId,
      ts: events.at(-1)?.ts ?? new Date().toISOString(),
      kind: 'harness', stage: 'credit_usage', runtimeProvider: 'qoder_cli',
      creditUsage: creditUsageEvidence(parsed.requests, 'qoder_native_transcript')
    })
    const agentToolUseIds = new Set(events.filter((event) => event.kind === 'agent' && event.toolUseId).map(event => event.toolUseId!))
    const sidecars = await qoderSidecarEvents({ transcriptPath: args.path, content: snapshot.content, runId: args.runId, sessionId: args.sessionId, cwd: args.cwd, agentToolUseIds })
    events.push(...sidecars.events)
    qoderSidecarsComplete = sidecars.complete
    qoderSidecarObservable = sidecars.observable
  }
  return {
    stable,
    ...(source ? { source } : {}),
    observed: turns.length > 0,
    ...(identityMatched != null ? { identityMatched } : {}),
    ...(turn?.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
    complete: stable && !snapshot.truncated && qoderSidecarsComplete,
    ...(turn?.userText ? { userText: turn.userText } : {}),
    events,
    observable: {
      tools: turns.length > 0 || qoderSidecarObservable?.tools === true,
      skills: turns.length > 0 || qoderSidecarObservable?.skills === true,
      mcps: turns.length > 0 || qoderSidecarObservable?.mcps === true,
      hooks: events.some((event) => event.kind === 'hook') || qoderSidecarObservable?.hooks === true,
      usage: events.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage')),
      files: events.some((event) => !!event.filePath && !!event.fileOp) || qoderSidecarObservable?.files === true,
      errors: turns.length > 0 || qoderSidecarObservable?.errors === true
    }
  }
}
