import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import type { TraceEvent } from '../../shared/trace.js'
import type { TranscriptRead } from './recorder-contracts.js'
import { readTranscriptWindow, transcriptIdentity } from './recorder-transcript-io.js'

// Native agent-result rows authorize one level of sidecars, not arbitrary paths.
// Larger files, more than 64 children, or nested delegation remain partial evidence.
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_FILES = 64
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

type Row = Record<string, unknown>
interface Binding { agentId: string; parentToolUseId: string }

function object(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
}

function rows(content: string): Array<Row | undefined> {
  return content.split('\n').filter(line => line.trim()).map(line => {
    try { return object(JSON.parse(line)) } catch { return undefined }
  })
}

export async function qoderSidecarEvents(args: {
  transcriptPath: string
  content: string
  runId: string
  sessionId?: string
  cwd?: string
  agentToolUseIds: Set<string>
}): Promise<{ events: TraceEvent[]; complete: boolean; observable: TranscriptRead['observable'] }> {
  const events: TraceEvent[] = []
  const observable = { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
  if (!args.agentToolUseIds.size) return { events, complete: true, observable }
  const { sessionId, cwd } = args
  if (!sessionId || !SAFE_COMPONENT.test(sessionId) || !cwd) return { events, complete: false, observable }
  const bindings = new Map<string, Binding>()
  const rejected = new Set<string>()
  let complete = true
  for (const row of rows(args.content)) {
    if (!row || row.type !== 'user') continue
    const result = object(row.toolUseResult)
    if (result?.kind !== 'agent-result') continue
    const blocks = object(row.message)?.content
    const block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
    const toolUseId = block?.tool_use_id
    // Other turns in the same snapshot do not authorize this turn's children.
    if (typeof toolUseId !== 'string' || !args.agentToolUseIds.has(toolUseId)) continue
    const agentId = result.agentId
    if (block?.type !== 'tool_result' || typeof agentId !== 'string' || !SAFE_COMPONENT.test(agentId) ||
        row.sessionId !== sessionId || row.cwd !== cwd || row.parent_tool_use_id != null ||
        row.isSidechain === true || row.isReplay === true || row.forkedFrom ||
        bindings.has(toolUseId) && bindings.get(toolUseId)!.agentId !== agentId) {
      rejected.add(toolUseId)
      bindings.delete(toolUseId)
      complete = false
      continue
    }
    if (rejected.has(toolUseId)) continue
    if (!bindings.has(toolUseId) && bindings.size >= MAX_FILES) { complete = false; continue }
    bindings.set(toolUseId, { agentId, parentToolUseId: toolUseId })
  }
  if (bindings.size !== args.agentToolUseIds.size) complete = false
  if (!bindings.size) return { events, complete, observable }

  let sidecarRoot: string
  try {
    const sessionRoot = join(dirname(await realpath(args.transcriptPath)), sessionId)
    sidecarRoot = join(sessionRoot, 'subagents')
    // Check both components: a regular file under a symlinked session directory
    // would otherwise escape the native transcript tree.
    for (const path of [sessionRoot, sidecarRoot]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return { events, complete: false, observable }
    }
  } catch {
    return { events, complete: false, observable }
  }
  let remaining = MAX_TOTAL_BYTES
  for (const binding of bindings.values()) {
    const childPath = join(sidecarRoot, `agent-${binding.agentId}.jsonl`)
    let content: string
    try {
      const info = await lstat(childPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || info.size > remaining) {
        complete = false
        continue
      }
      remaining -= info.size
      const snapshot = await readTranscriptWindow(childPath, info.size, 0, transcriptIdentity(info))
      if (!snapshot.consistent || snapshot.truncated) { complete = false; continue }
      content = snapshot.content
    } catch {
      complete = false
      continue
    }
    const childRows = rows(content)
    const header = childRows[0]
    const scoped = (row: Row | undefined): boolean => !!row && row.sessionId === sessionId &&
      row.cwd === cwd && row.agentId === binding.agentId && row.parent_tool_use_id === binding.parentToolUseId &&
      row.isSidechain === true && row.isReplay !== true && !row.forkedFrom
    if (!header || header.type !== 'user' || header.isDelegatedTask !== true || !scoped(header) ||
        childRows.some(row => !row || (row.type === 'user' || row.type === 'assistant') && !scoped(row))) {
      complete = false
      continue
    }
    const turns = parseTranscriptToTurns(content, {
      runId: args.runId, agentId: binding.agentId, cwd,
      newId: () => `qoder-sidecar-${randomUUID()}`, now: () => new Date().toISOString()
    })
    if (!turns.length) { complete = false; continue }
    for (const event of turns.flatMap(turn => turn.items)) {
      // Main request accounting is authoritative; retain child text separately,
      // but do not add child token/cost/credit totals to it a second time.
      if (event.kind === 'harness' && ['result', 'credit_usage'].includes(event.stage)) continue
      if (event.kind === 'agent') complete = false
      events.push({
        ...event, agentId: binding.agentId,
        parentToolUseId: event.parentToolUseId ?? binding.parentToolUseId,
        runtimeMetadata: { ...event.runtimeMetadata, childTranscript: childPath, childAgent: binding.agentId }
      })
      observable.tools ||= ['tool', 'agent', 'skill'].includes(event.kind)
      observable.skills ||= event.kind === 'skill'
      observable.mcps ||= event.isMcp === true
      observable.hooks ||= event.kind === 'hook'
      observable.files ||= !!event.filePath && !!event.fileOp
      observable.errors ||= event.isError === true
    }
  }
  return { events, complete, observable }
}
