import type { DesktopLaneName } from './desktop-lane'
import { DESKTOP_WORKBENCH_READ_METHODS } from '../../shared/desktop-workbench'


// Writes stay on the control lane: cancelling a large read must never tear down an
// in-flight write, and a write is never replayed after its bytes were written.
const writeOperations = new Set([
  'answerQuestion', 'attachmentChunk', 'attachmentCommit', 'attachmentStart',
  'executionTargetResult', 'resolveIntent', 'sessionAction', 'sessionDelete', 'sessionFork', 'stop', 'submit', 'submitAtLog'
])
const targetWorkOperations = new Set(['executionTargetWork'])
// Short and idempotent: on the control lane, and replayable because it changes nothing twice.
const idempotentControlOperations = new Set(['attentionViewed'])
const bulkDesktopKinds = new Set(['history', 'trace', 'trace_delta', 'image_chunk'])

// `desktopWorkbench` carries its own method: file writes, Git/PR mutations, drafts and
// PTY input are writes like the ones above, whichever device or App sends them. They take
// their own lane: a push or merge can last the whole timeout, and stop/answer on control
// must not queue behind it.
function workbenchWrite(op: string, request: unknown): boolean {
  if (op !== 'desktopWorkbench') return false
  const method = (request as { query?: { method?: unknown } }).query?.method
  return typeof method !== 'string' || !DESKTOP_WORKBENCH_READ_METHODS.has(method)
}

// The daemon App's terminal (P3-terminal.md): typing and output on their own lane;
// recording pages, up to 512 KiB, read on bulk.
const terminalBulkMethods = new Set(['recordingList', 'recordingRead'])
const terminalReadMethods = new Set(['active', 'recordingList', 'recordingRead'])
function terminalLane(op: string, request: unknown): DesktopLaneName | undefined {
  if (op === 'terminalFeed') return 'terminal'
  if (op !== 'terminal') return undefined
  const method = (request as { method?: unknown }).method
  return typeof method === 'string' && terminalBulkMethods.has(method) ? 'bulk' : 'terminal'
}

export function laneForRequest(request: unknown, transport: 'local' | 'network' = 'local'): DesktopLaneName {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  if (typeof op !== 'string') return 'control'
  const terminal = terminalLane(op, request)
  if (terminal) return terminal
  // MCP starts servers and may wait for a browser sign-in; a billing sync reads pages.
  // Cancelling a live check must not queue behind the check it cancels, so it takes the
  // short control lane while the snapshot holds `long`.
  if (op === 'mcp') return (request as { method?: unknown }).method === 'cancelMcpSnapshot' ? 'control' : 'long'
  if (op === 'billing' && (request as { method?: unknown }).method === 'syncBillingAdmin') return 'long'
  // Cancelling a running push/fetch must not queue behind it on the workbench lane.
  if (op === 'desktopWorkbench' && (request as { query?: { method?: unknown } }).query?.method === 'cancel') return 'control'
  if (workbenchWrite(op, request)) return 'workbench'
  if (writeOperations.has(op)) return 'control'
  if (idempotentControlOperations.has(op)) return 'control'
  if (op === 'subscribe') {
    const { views } = request as { views?: unknown }
    if (Array.isArray(views) && views.includes('detail')) return 'watch'
    return transport === 'network' ? 'status' : 'events'
  }
  if (targetWorkOperations.has(op)) return 'targetWork'
  if (op === 'desktop') {
    const kind = (request as { query?: { kind?: unknown } }).query?.kind
    return typeof kind === 'string' && bulkDesktopKinds.has(kind) ? 'bulk' : 'control'
  }
  return 'bulk'
}

export function replayableRequest(request: unknown): boolean {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  // Aborting an already-aborted check changes nothing, so a lost reply may be asked again.
  if (op === 'mcp') {
    const method = (request as { method?: unknown }).method
    return method === 'mcpGuardScan' || method === 'cancelMcpSnapshot'
  }
  if (op === 'terminal') {
    const method = (request as { method?: unknown }).method
    return typeof method === 'string' && terminalReadMethods.has(method)
  }
  return !(typeof op === 'string' && (writeOperations.has(op) || workbenchWrite(op, request)))
}
