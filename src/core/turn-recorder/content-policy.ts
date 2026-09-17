import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace.js'
import type { TurnCall, TurnEvidence } from '../../shared/turn-record.js'
import { parseRecorderConfig } from './config.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { captureToolContent, limitToolContent, redactToolText, sanitizeCapturedContent, sanitizeToolEvents, type ToolContentPolicy } from './tool-content.js'

// Sync App sinks (archive/SQLite outbox) must resolve the same capture policy before their first write.
// Invalid/unreadable configuration must not silently fall back to persisting unredacted bodies.
export function workspaceToolContentPolicy(workspace: string): ToolContentPolicy | undefined {
  if (!workspace) return undefined
  let text: string
  try { text = readFileSync(join(workspace, 'scry.config.json'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('tool content policy unavailable')
  }
  const capture = parseRecorderConfig(JSON.parse(text)).capture
  return capture.toolOutput === 'full-redacted' ? {
    toolOutput: capture.toolOutput,
    toolContentFieldBytes: capture.toolContentFieldBytes,
    toolContentTurnBytes: capture.toolContentTurnBytes
  } : undefined
}

export interface ContentBearingTurn {
  items: TraceEvent[]
  turnEvidence?: TurnEvidence
  toolContentPolicy?: ToolContentPolicy
}

export function protectToolContent<T extends ContentBearingTurn>(turn: T, workspace: string): T {
  // Pin the policy into retry artifacts. A later config change cannot turn a protected retry raw.
  const policy = turn.toolContentPolicy?.toolOutput === 'full-redacted' ? turn.toolContentPolicy : workspaceToolContentPolicy(workspace)
  if (policy?.toolOutput !== 'full-redacted') return turn
  const items = sanitizeToolEvents(turn.items, policy, 'scry_provider_adapter')
  const projected = aggregateTurnEvidence({ events: items, toolContentPolicy: policy, source: 'scry_provider_adapter' })
  const evidence = turn.turnEvidence
  if (!evidence) return { ...turn, toolContentPolicy: policy, items }

  const calls = (key: 'tools' | 'skills' | 'mcps') => {
    const previous = evidence[key]
    if (!previous.value) return previous
    // The canonical call list may be richer than retained trace. Never turn absent trace into []
    // or replace timing/identity with a lower-authority projection just to add body content.
    const value = previous.value.map((call): TurnCall => {
      const matches = (projected[key].value ?? []).filter((candidate) =>
        call.id ? candidate.id === call.id && candidate.name === redactToolText(call.name)
          : call.order !== undefined && candidate.order === call.order && candidate.name === redactToolText(call.name))
      const match = matches.length === 1 ? matches[0] : undefined
      const { input: _input, outputSummary: _summary, error: _error, ...metadata } = call
      return {
        ...metadata,
        name: redactToolText(metadata.name),
        ...(metadata.mcp ? { mcp: {
          server: metadata.mcp.server && redactToolText(metadata.mcp.server),
          action: metadata.mcp.action && redactToolText(metadata.mcp.action),
          tool: metadata.mcp.tool && redactToolText(metadata.mcp.tool)
        } } : {}),
        inputContent: match?.inputContent ?? call.inputContent ?? captureToolContent(call.input, { source: 'canonical_call', maxBytes: policy.toolContentFieldBytes }),
        outputContent: match?.outputContent ?? call.outputContent ?? captureToolContent(call.outputSummary, {
          source: 'canonical_summary', maxBytes: policy.toolContentFieldBytes,
          ...(call.outputSummary !== undefined ? { sourceCompleteness: 'partial', reasons: ['source_truncated'] } : {})
        }),
        ...(call.error ? { error: 'tool failed' } : {})
      }
    })
    return { ...previous, value }
  }
  const sections = { tools: calls('tools'), skills: calls('skills'), mcps: calls('mcps') }
  let remaining = policy.toolContentTurnBytes ?? 128 * 1024
  const candidates = Object.values(sections).flatMap((section) => (section.value ?? []).map((call) => ({ section, call })))
  for (const { section, call } of candidates.sort((a, b) => (a.call.order ?? 0) - (b.call.order ?? 0))) {
    for (const key of ['inputContent', 'outputContent'] as const) {
      const original = call[key]!
      // Defend direct canonical callers as well as trace-derived content; flags are not authorization.
      const checked = sanitizeCapturedContent(original, policy.toolContentFieldBytes)
      const saved = limitToolContent(checked, remaining, 'turn_budget')
      call[key] = saved
      remaining -= saved.savedBytes
      if ((saved.storage !== 'complete' && !saved.contentRef) || saved.sourceCompleteness === 'partial') {
        section.status = 'partial'
        section.quality = 'inferred'
        section.omissionReason = [...new Set([...(section.omissionReason?.split('; ') ?? []), 'tool content missing or limited (inspect field provenance)'])].join('; ')
      }
    }
    const output = call.outputContent?.content
    call.outputSummary = output ? (output.length <= 500 ? output : `${output.slice(0, 500)}…`) : undefined
    if (call.error) call.error = call.outputSummary ?? 'tool failed'
  }
  return {
    ...turn, toolContentPolicy: policy, items,
    turnEvidence: {
      ...evidence, ...sections,
      dangerousOperations: { ...evidence.dangerousOperations, ...(evidence.dangerousOperations.value ? { value: evidence.dangerousOperations.value.map((danger) => ({ ...danger, reason: redactToolText(danger.reason), ...(danger.tool ? { tool: redactToolText(danger.tool) } : {}) })) } : {}) },
      errors: { ...evidence.errors, ...(evidence.errors.value ? { value: evidence.errors.value.map((error) => ({ ...error, message: redactToolText(error.message) })) } : {}) }
    }
  }
}
