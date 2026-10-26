import { open as openFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { captureToolContent, isFullToolContentPolicy } from './tool-content.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { listRecords, updateHealth, stableHash } from './store.js'
import { recorderOpenPath as openPath, recorderStatePath as statePath, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { CODEX_SUBAGENT_MARKER, nestedRecord, promptOf, stringAt, type RecorderHookInput, transcriptPathOf, observedNow } from './recorder-contracts.js'

export function isClaudeTaskNotification(payload: Record<string, unknown>): boolean {
  const origin = nestedRecord(payload, 'origin')
  return stringAt(origin ?? {}, 'kind') === 'task-notification' ||
    (promptOf(payload)?.trimStart().startsWith('<task-notification>') ?? false)
}

export function continuationProviderTurnIds(open: OpenTurnState): string[] {
  return open.continuationProviderTurnIds ?? []
}

export async function rememberContinuationProviderTurn(
  root: string,
  open: OpenTurnState,
  providerTurnId: string | undefined
): Promise<void> {
  if (!providerTurnId || providerTurnId === open.providerTurnId) return
  const ids = [...new Set([...continuationProviderTurnIds(open), providerTurnId])].slice(-200)
  open.continuationProviderTurnIds = ids
  await writeJsonAtomic(openPath(root), open, { sync: false })
}

export function isContinuationProviderTurn(open: OpenTurnState, providerTurnId: string | undefined): boolean {
  return !!providerTurnId && continuationProviderTurnIds(open).includes(providerTurnId)
}

export function isSynthetic(payload: Record<string, unknown>): boolean {
  return payload.isMeta === true || payload.synthetic === true || stringAt(payload, 'source') === 'synthetic'
}

/**
 * Codex guardian (auto-review) subagents reuse the parent session_id and carry no agent_id,
 * but their transcript_path is the child's own rollout, whose first `session_meta` row
 * declares `source.subagent`. A rollout named after the session itself is the main thread
 * and is never opened.
 */
export async function codexSubagentTranscript(payload: Record<string, unknown>, sessionId: string): Promise<boolean> {
  const path = transcriptPathOf(payload)
  if (!path) return false
  const name = basename(path)
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || name.includes(sessionId)) return false
  let handle
  try {
    handle = await openFile(path, 'r')
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      const newline = slice.indexOf(0x0a)
      chunks.push(newline >= 0 ? slice.subarray(0, newline) : slice)
      total += bytesRead
      if (newline >= 0 || total >= 4 * 1024 * 1024) break
    }
    const first = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const meta = first.type === 'session_meta' ? nestedRecord(first, 'payload') : undefined
    const source = meta ? nestedRecord(meta, 'source') : undefined
    return !!source && 'subagent' in source
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

export function trustedManagedIdentityPayload(
  payload: Record<string, unknown>,
  managed: boolean | undefined,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  const trusted = { ...payload }
  delete trusted.scry_managed_run_id
  delete trusted.scry_managed_prompt_hash
  delete trusted[CODEX_SUBAGENT_MARKER]
  if (!managed) return trusted
  const runId = env.SCRY_MANAGED_RUN_ID?.trim()
  const promptHash = env.SCRY_MANAGED_PROMPT_HASH?.trim()
  if (runId && runId.length <= 256 && !/[\r\n]/.test(runId) && promptHash && /^[a-f0-9]{64}$/.test(promptHash)) {
    trusted.scry_managed_run_id = runId
    trusted.scry_managed_prompt_hash = promptHash
  }
  return trusted
}

export async function isCommittedProviderTurn(
  dataRoot: string,
  root: string,
  provider: ProviderId,
  sessionId: string,
  providerTurnId: string
): Promise<boolean> {
  const state = await readJson<SessionState>(statePath(root))
  if (state?.committedProviderTurnIds?.includes(providerTurnId)) return true
  return (await listRecords(dataRoot)).some((record) =>
    record.provider.id === provider &&
    record.sessionId === sessionId &&
    record.providerTurnId === providerTurnId
  )
}

export async function storeOrphanEvent(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  root: string,
  input: RecorderHookInput,
  missingStart: boolean
): Promise<{ status: 'orphan' }> {
  const id = stableHash({ event: input.event, payload: input.payload })
  const path = join(root, 'orphans', `${id}.json`)
  // The session lock serializes delivery and inbox replay. Replays keep the first observation.
  if (await readJson(path)) return { status: 'orphan' }
  const capture = enablement.config.capture
  // Opaque payloads mix prompts, assistant text and tools. Do not bypass disabled categories.
  const capturePayload = capture.prompt && capture.assistant && isFullToolContentPolicy(capture)
  const reason = missingStart ? 'missing_start' : 'no_matching_open_turn'
  const at = observedNow()
  await writeJsonAtomic(path, {
    schemaVersion: 1, event: input.event, observedAt: at, reason,
    payload: captureToolContent(capturePayload ? input.payload : undefined, {
      source: 'orphan_hook', maxBytes: Math.min(capture.toolContentFieldBytes ?? 8 * 1024, capture.toolContentTurnBytes ?? 128 * 1024)
    }),
    ...(!capturePayload ? { omissionReason: 'capture_policy' } : {})
  })
  await updateHealth(enablement.dataRoot, {
    lastError: { at, message: `orphan recorder event: ${input.event} (${reason})` },
    increment: { orphanEvents: 1, ...(missingStart ? { missingStartTerminals: 1 } : {}) }
  })
  await appendRotatingLog(join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${at} WARN orphan ${input.provider} ${input.event} ${reason} id=${id}`)
  return { status: 'orphan' }
}
