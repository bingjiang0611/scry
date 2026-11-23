import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import type { TraceEvent } from '../../shared/trace.js'
import type { TranscriptRead } from './recorder-contracts.js'
import { readTranscriptWindow, transcriptIdentity } from './recorder-transcript-io.js'

// Native agent-result rows authorize one level of sidecars, not arbitrary paths. More than 64
// children or nested delegation remain partial evidence. The byte limits are read budgets, not
// admission tests: a child transcript that does not fit still contributes every complete row that
// does, because dropping a whole child loses internal tool/model evidence that was readable.
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_FILES = 64
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

type Row = Record<string, unknown>
interface Binding { agentId: string; parentToolUseId: string }
/** A child transcript that was kept only in part, with what the record must say about it. */
export interface SidecarTruncation {
  agentId: string
  path: string
  totalBytes: number
  retainedBytes: number
  reason: string
}

function object(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
}

function rows(content: string): Array<Row | undefined> {
  return content.split('\n').filter(line => line.trim()).map(line => {
    try { return object(JSON.parse(line)) } catch { return undefined }
  })
}

/**
 * A byte-bounded window can end mid-line. Keep whole JSONL rows only: half a row is not evidence and
 * would fail the scoping check that protects against foreign sidecars.
 */
function completeRows(content: string): string {
  const end = content.lastIndexOf('\n')
  return end < 0 ? '' : content.slice(0, end + 1)
}

export async function qoderSidecarEvents(args: {
  transcriptPath: string
  content: string
  runId: string
  sessionId?: string
  cwd?: string
  agentToolUseIds: Set<string>
}): Promise<{
  events: TraceEvent[]
  complete: boolean
  observable: TranscriptRead['observable']
  truncations: SidecarTruncation[]
}> {
  const events: TraceEvent[] = []
  const truncations: SidecarTruncation[] = []
  const observable = { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
  if (!args.agentToolUseIds.size) return { events, complete: true, observable, truncations }
  const { sessionId, cwd } = args
  if (!sessionId || !SAFE_COMPONENT.test(sessionId) || !cwd) return { events, complete: false, observable, truncations }
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
  if (!bindings.size) return { events, complete, observable, truncations }

  let sidecarRoot: string
  try {
    const sessionRoot = join(dirname(await realpath(args.transcriptPath)), sessionId)
    sidecarRoot = join(sessionRoot, 'subagents')
    // Check both components: a regular file under a symlinked session directory
    // would otherwise escape the native transcript tree.
    for (const path of [sessionRoot, sidecarRoot]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return { events, complete: false, observable, truncations }
    }
  } catch {
    return { events, complete: false, observable, truncations }
  }
  let remaining = MAX_TOTAL_BYTES
  for (const binding of bindings.values()) {
    const childPath = join(sidecarRoot, `agent-${binding.agentId}.jsonl`)
    let content: string
    let retainedBytes = 0
    let childTruncation: SidecarTruncation | undefined
    try {
      const info = await lstat(childPath)
      if (!info.isFile() || info.isSymbolicLink() || remaining <= 0) {
        complete = false
        continue
      }
      // The window is the file's prefix, so the identity check still proves the bytes came from the
      // file this binding named; the size cap is what turns an oversized child into partial evidence.
      const limit = Math.min(info.size, MAX_FILE_BYTES, remaining)
      if (limit <= 0) { complete = false; continue }
      const snapshot = await readTranscriptWindow(childPath, limit, 0, transcriptIdentity(info))
      if (!snapshot.consistent) { complete = false; continue }
      remaining -= limit
      content = completeRows(snapshot.content)
      retainedBytes = Buffer.byteLength(content)
      if (retainedBytes === 0) { complete = false; continue }
      if (info.size > limit) {
        childTruncation = {
          agentId: binding.agentId,
          path: childPath,
          totalBytes: info.size,
          retainedBytes,
          reason: `child agent transcript exceeds the ${MAX_FILE_BYTES} byte per-child budget`
        }
        truncations.push(childTruncation)
        complete = false
      }
    } catch {
      complete = false
      continue
    }
    const childRows = rows(content)
    const header = childRows[0]
    // Qoder 1.1.93 的子行把 parent_tool_use_id 写成 null：归属由父结果里的 agentId、
    // 子文件名 agent-<id>.jsonl、sessionId、cwd、agentId 与 isSidechain 共同证明。
    // 字段有值时必须等于父调用 ID；指向别的调用的子文件宁可不收，也不能挂错父。
    const scoped = (row: Row | undefined): boolean => !!row && row.sessionId === sessionId &&
      row.cwd === cwd && row.agentId === binding.agentId &&
      (row.parent_tool_use_id == null || row.parent_tool_use_id === binding.parentToolUseId) &&
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
        runtimeMetadata: {
          ...event.runtimeMetadata, childTranscript: childPath, childAgent: binding.agentId,
          // The child's own rows say which of them came from a transcript kept only in part.
          ...(childTruncation
            ? {
                childTranscriptTruncated: {
                  reason: childTruncation.reason,
                  retainedBytes: childTruncation.retainedBytes,
                  totalBytes: childTruncation.totalBytes
                }
              }
            : {})
        }
      })
      observable.tools ||= ['tool', 'agent', 'skill'].includes(event.kind)
      observable.skills ||= event.kind === 'skill'
      observable.mcps ||= event.isMcp === true
      observable.hooks ||= event.kind === 'hook'
      observable.files ||= !!event.filePath && !!event.fileOp
      observable.errors ||= event.isError === true
    }
  }
  return { events, complete, observable, truncations }
}
