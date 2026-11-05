import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { TraceEvent } from '../shared/trace'
import { isToolContentRef, type RecorderContentPageRequest } from '../shared/tool-content'
import { persistToolEventContent } from '../core/turn-recorder/tool-content'
import { readRecorderContentPage, writeRecorderContentCopies } from '../core/turn-recorder/content-store'

export const APP_TRACE_CONTENT_SOURCE = 'scry_app_trace'
export const TRACE_TOOL_CONTENT_POLICY = {
  toolOutput: 'full' as const,
  toolContentFieldBytes: 8 * 1024,
  toolContentTurnBytes: 128 * 1024
}

// The main process supplies a catalog-authorized canonical cwd, never a renderer path.
// Separate roots keep even a known digest from granting access to another workspace.
export function appTraceContentRoot(userDataDir: string, cwd: string): string {
  return join(userDataDir, 'trace-content-v1', createHash('sha256').update(cwd).digest('hex'))
}

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

export async function readAppTraceContentPage(userDataDir: string, cwd: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_trace_content_request')
  const request = value as Partial<RecorderContentPageRequest>
  if (request.source !== 'app-trace' || !isToolContentRef(request.ref)) throw new Error('invalid_trace_content_ref')
  const limit = request.limit ?? 64 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024) throw new Error('invalid_trace_content_limit')
  return readRecorderContentPage(appTraceContentRoot(userDataDir, cwd), request.ref, { offset: request.offset, limit })
}
