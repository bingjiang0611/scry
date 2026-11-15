import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { TraceEvent } from '../shared/trace'
import { isToolContentRef, type RecorderContentPageRequest, type ToolContentRef } from '../shared/tool-content'
import { persistToolEventContent } from '../core/turn-recorder/tool-content'
import { appTraceContentRoot } from '../core/turn-recorder/app-trace-content'
import { contentPath, readRecorderContentPage, writeRecorderContentCopies } from '../core/turn-recorder/content-store'

export { appTraceContentRoot }

export const APP_TRACE_CONTENT_SOURCE = 'scry_app_trace'
export const TRACE_TOOL_CONTENT_POLICY = {
  toolOutput: 'full' as const,
  toolContentFieldBytes: 8 * 1024,
  toolContentTurnBytes: 128 * 1024
}

// The main process supplies a catalog-authorized canonical cwd, never a renderer path.
// Separate roots keep even a known digest from granting access to another workspace.

/**
 * A workspace recorder owns the turn: its store must hold every body the record keeps. Tool input is
 * always recorded, tool output only under the full capture policy, so the two authorities diverge
 * exactly where the capture policy says they may.
 */
export interface TraceRecorderIngestion {
  root: string
  toolOutput: 'none' | 'summary' | 'full'
}

export async function persistTraceToolEvents(
  userDataDir: string,
  cwd: string,
  events: TraceEvent[],
  recorder?: TraceRecorderIngestion
): Promise<TraceEvent[]> {
  const bounded: TraceEvent[] = []
  // Do not retain every serialized body in a turn concurrently while loading old archives.
  for (const event of events) {
    // One event remains the batch boundary. Both authorities must be durable before the live queue
    // can publish its reference; the offline CLI cannot depend on App data.
    const appRoot = appTraceContentRoot(userDataDir, cwd)
    // 采集策略按字段判定，不按事件类型：tool_result 也可能带工具入参正文，而工具入参始终属于工作区库。
    const roots = (field: 'input' | 'output'): [string, ...string[]] =>
      recorder && (field === 'input' || recorder.toolOutput === 'full') ? [appRoot, recorder.root] : [appRoot]
    bounded.push(...await persistToolEventContent([event], TRACE_TOOL_CONTENT_POLICY, APP_TRACE_CONTENT_SOURCE,
      async (content, encoding, field) => writeRecorderContentCopies(roots(field), content, encoding)))
  }
  return bounded
}

/**
 * Blobs this process already published or verified-and-synced through the history path, by root
 * and digest. Opening history re-persists the same transcript bodies every time (the transcript
 * cache hands out fresh copies); repeating the full readback compare and fsync of a blob this
 * process already proved durable adds no durability. A hit still requires the file to exist at the
 * expected size, so a removed or truncated blob is rewritten. Reads verify the digest regardless,
 * so a corrupted blob surfaces as an integrity error, never as other content. Bounded; process-local.
 * Live recorder ingestion does not use it and keeps verifying every write.
 */
const verifiedHistoryContent = new Map<string, true>()
const VERIFIED_HISTORY_CONTENT_LIMIT = 20_000

async function persistHistoryContent(root: string, content: string, encoding: ToolContentRef['encoding']): Promise<ToolContentRef> {
  const sha256 = createHash('sha256').update(content).digest('hex')
  const bytes = Buffer.byteLength(content, 'utf8')
  const key = `${root}\0${sha256}`
  if (verifiedHistoryContent.delete(key)) {
    try {
      const stat = await lstat(contentPath(root, sha256))
      if (stat.isFile() && stat.size === bytes) {
        verifiedHistoryContent.set(key, true)
        return { storage: 'recorder-content-v1', sha256, bytes, encoding }
      }
    } catch { /* missing: publish again below */ }
  }
  const ref = await writeRecorderContentCopies([root], content, encoding)
  verifiedHistoryContent.set(key, true)
  if (verifiedHistoryContent.size > VERIFIED_HISTORY_CONTENT_LIMIT) {
    verifiedHistoryContent.delete(verifiedHistoryContent.keys().next().value!)
  }
  return ref
}

/** History-load persistence: same policy, source and refs as `persistTraceToolEvents` without a recorder. */
export async function persistHistoryToolEvents(userDataDir: string, cwd: string, events: TraceEvent[]): Promise<TraceEvent[]> {
  const appRoot = appTraceContentRoot(userDataDir, cwd)
  const bounded: TraceEvent[] = []
  for (const event of events) {
    bounded.push(...await persistToolEventContent([event], TRACE_TOOL_CONTENT_POLICY, APP_TRACE_CONTENT_SOURCE,
      (content, encoding) => persistHistoryContent(appRoot, content, encoding)))
  }
  return bounded
}

/** Test seam: forget verification state. */
export function resetVerifiedHistoryContent(): void {
  verifiedHistoryContent.clear()
}

export async function readAppTraceContentPage(userDataDir: string, cwd: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_trace_content_request')
  const request = value as Partial<RecorderContentPageRequest>
  if (request.source !== 'app-trace' || !isToolContentRef(request.ref)) throw new Error('invalid_trace_content_ref')
  const limit = request.limit ?? 64 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024) throw new Error('invalid_trace_content_limit')
  return readRecorderContentPage(appTraceContentRoot(userDataDir, cwd), request.ref, { offset: request.offset, limit })
}
