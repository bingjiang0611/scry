import { open as openFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { captureToolContent, isFullToolContentPolicy } from './tool-content.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { findRecordById, listRecords, updateHealth, safeKey, stableHash } from './store.js'
import { recorderOpenPath as openPath, recorderStatePath as statePath, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { storeLifecycleEvent } from './recorder-turn-state.js'
import { refreshSealWindow } from './recorder-segment.js'
import { CODEX_SUBAGENT_MARKER, nestedRecord, promptOf, providerTurnIdOf, stringAt, type RecorderHookInput, type RecorderHookResult, transcriptPathOf, observedNow } from './recorder-contracts.js'

/** A `<task-notification>` prompt is a continuation, not a user question, for every Provider. */
export function isTaskNotificationPrompt(payload: Record<string, unknown>): boolean {
  const origin = nestedRecord(payload, 'origin')
  return stringAt(origin ?? {}, 'kind') === 'task-notification' ||
    (promptOf(payload)?.trimStart().startsWith('<task-notification>') ?? false)
}

export async function recordTaskNotificationWake(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  root: string,
  open: OpenTurnState | null,
  input: RecorderHookInput,
  providerTurnId: string | undefined
): Promise<RecorderHookResult> {
  if (!open) return { status: 'ignored', reason: 'task notification has no real user turn' }
  if (open.managedByScry) return { status: 'recorded', reason: 'managed task continuation kept in canonical Scry turn' }
  await rememberContinuationProviderTurn(root, open, providerTurnId)
  await storeLifecycleEvent(enablement, open, input.event, input.payload)
  // The wake proves the segment is still alive, so a held Stop waits for quiet again.
  await refreshSealWindow(root, open)
  return { status: 'recorded', reason: 'task notification continued the open turn' }
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

const CODEX_TITLE_INSTRUCTION = 'Generate a concise, single-line task title of at most 36 characters'
const CODEX_TITLE_PROMPT_SEPARATOR = '\n\nUser prompt:\n'

/**
 * Codex asks the model for a short UI title in a throwaway session before the real turn.
 * That request carries the fixed title instruction plus the captured user prompt, so the
 * lifecycle hooks cannot reuse an origin marker. Require the instruction opening, the exact
 * blank-line separator and the instruction's closing sentence together: a real prompt that
 * merely shares the opening words, or mentions "User prompt:" inline, is never ignored.
 */
export function isCodexInternalPrompt(payload: Record<string, unknown>): boolean {
  const prompt = stringAt(payload, 'prompt', 'user_prompt', 'userPrompt')
  if (!prompt) return false
  const normalized = prompt.replace(/^\s+/, '')
  if (!normalized.startsWith(CODEX_TITLE_INSTRUCTION)) return false
  const separator = normalized.indexOf(CODEX_TITLE_PROMPT_SEPARATOR)
  if (separator < 0) return false
  return normalized.slice(0, separator).trimEnd().endsWith('Do not answer the request.')
}

/**
 * The title session has no evidence of its own, but its paired terminal still arrives. Remember
 * the ignored identity so the terminal is ignored too instead of becoming an orphan event that
 * raises `missingStartTerminals` and `lastError` in health.
 */
export async function markCodexInternalTurn(
  dataRoot: string,
  provider: ProviderId,
  sessionId: string,
  turnId: string
): Promise<void> {
  await writeJsonAtomic(internalTurnPath(dataRoot, provider, sessionId, turnId), {
    schemaVersion: 1, sessionId, turnId, at: observedNow()
  })
}

export async function consumeCodexInternalTurn(
  dataRoot: string,
  provider: ProviderId,
  sessionId: string,
  turnId: string
): Promise<boolean> {
  const path = internalTurnPath(dataRoot, provider, sessionId, turnId)
  if (!await readJson(path)) return false
  await rm(path, { force: true })
  return true
}

function internalTurnPath(dataRoot: string, provider: ProviderId, sessionId: string, turnId: string): string {
  return join(dataRoot, 'runtime', provider, 'internal-turns', `${safeKey(sessionId)}-${safeKey(turnId)}.json`)
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

/**
 * Qoder can deliver a Stop several seconds after its completed record and omit every native
 * identity. Text equality is not turn identity. The only no-open fast path is an unchanged,
 * authoritative transcript snapshot for the last record; otherwise the event stays an orphan.
 * Any open turn remains ambiguous and is handled by stale-terminal protection instead.
 */
export async function isLateQoderTerminalDuplicate(
  dataRoot: string,
  root: string,
  sessionId: string,
  payload: Record<string, unknown>,
  open: OpenTurnState | null
): Promise<boolean> {
  if (open || payload.stop_hook_active === true || providerTurnIdOf(payload, 'qoder')) return false
  const assistant = stringAt(payload, 'last_assistant_message', 'lastAssistantMessage')
  const transcriptPath = transcriptPathOf(payload)
  if (!assistant || !transcriptPath) return false
  const state = await readJson<SessionState>(statePath(root))
  if (!state?.lastCommittedRecordId) return false
  const record = await findRecordById(dataRoot, state.lastCommittedRecordId)
  const source = record?.transcript?.status === 'available' ? record.transcript.value : undefined
  if (!record || record.provider.id !== 'qoder' || record.sessionId !== sessionId || record.status !== 'completed' ||
    record.assistant.status !== 'available' || record.assistant.value?.text !== assistant ||
    !source || source.sourcePath !== transcriptPath) return false
  try {
    const current = await stat(transcriptPath)
    return current.dev === source.identity.dev && current.ino === source.identity.ino &&
      current.size === source.identity.size && current.mtimeMs === source.identity.mtimeMs && current.ctimeMs === source.identity.ctimeMs
  } catch {
    return false
  }
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
