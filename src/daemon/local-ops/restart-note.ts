import { canonicalJson, sha256Hex } from '../../host-runtime/orchestration/canonical-json'
import { findNativeSession } from '../../host-runtime/orchestration/native-session-lookup'
import { takeRestartBackgroundNote } from '../restart-background-note'
import type { DaemonLocalOpGroup } from './deps'

/**
 * C4: a restart cancels the background work a run was waiting on. The automatic note reaches exactly
 * one turn on its own; this is the *explicit* "继续" over the same evidence, because the user asked
 * for a button instead of another silent instruction.
 */
export const CONTINUE_AFTER_RESTART_PROMPT = '续做被重启取消的后台任务'

interface SessionRef {
  sessionId: string
  providerId?: string
  agentProfileId?: string | null
  cwd?: string
}

function readRef(input: unknown): SessionRef {
  const value = (input ?? {}) as Record<string, unknown>
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) throw new Error('invalid_session_id')
  const providerId = value.providerId
  if (providerId !== undefined && (typeof providerId !== 'string' || providerId.length > 128)) throw new Error('invalid_provider_id')
  const cwd = value.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0'))) throw new Error('invalid_cwd')
  const agentProfileId = value.agentProfileId
  if (agentProfileId !== undefined && agentProfileId !== null && typeof agentProfileId !== 'string') {
    throw new Error('invalid_agent_profile_id')
  }
  return {
    sessionId,
    ...(providerId === undefined ? {} : { providerId }),
    ...(agentProfileId === undefined ? {} : { agentProfileId }),
    ...(cwd === undefined ? {} : { cwd })
  }
}

const NOTE_KEY_PREFIX = 'restart_background_note:'

/** The reader is the sink's read half; the press needs the write half, as the queue release does. */
type WritableReader = { execute: (command: unknown) => { kind: string; reason?: string }; isWriteIndeterminate: () => boolean }

function resolveSessionKey(
  reader: { getSession: (key: string) => { sessionKey: string } | undefined },
  ref: SessionRef
): string | undefined {
  const bound = findNativeSession(reader as never, {
    sessionId: ref.sessionId,
    provider: ref.providerId ?? 'legacy_unknown',
    profile: ref.agentProfileId ?? null,
    cwd: ref.cwd
  })
  return bound?.sessionKey ?? reader.getSession(ref.sessionId)?.sessionKey
}

/** A note is one press: the run id is derived from it so a replayed submit is the same run. */
function continueRunId(sessionKey: string, note: string): string {
  const hex = sha256Hex(`${sessionKey}\u0000${note}`)
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Whether this session still owes the user a "继续". The read does not consume the note — only the
 * press does — so a panel that re-renders cannot eat the offer.
 */
export const restartNoteLocalOps: DaemonLocalOpGroup = (deps) => ({
  'agent:restartNote': async (input: unknown): Promise<{ resolved: boolean; pending: boolean }> => {
    const ref = readRef(input)
    const reader = deps.orchestrationReader?.()
    if (!reader) throw new Error('orchestration_unavailable')
    const sessionKey = resolveSessionKey(reader, ref)
    if (!sessionKey) return { resolved: false, pending: false }
    return {
      resolved: true,
      pending: Boolean(reader.handle.db.prepare('SELECT 1 FROM orch_meta WHERE key = ?').get(`${NOTE_KEY_PREFIX}${sessionKey}`))
    }
  },

  /**
   * The press. Taking the note is the loop protection: it can happen once, so a second press — or a
   * retry after an unknown write — submits nothing and says why, instead of sending the same
   * instruction again.
   */
  'agent:continueAfterRestart': async (input: unknown) => {
    const ref = readRef(input)
    const sink = deps.orchestrationReader?.()
    if (!sink || !('execute' in sink)) throw new Error('orchestration_unavailable')
    const writable = sink as unknown as WritableReader
    if (writable.isWriteIndeterminate()) return { ok: false, reason: 'orchestration_write_indeterminate' }
    const sessionKey = resolveSessionKey(sink, ref)
    if (!sessionKey) return { ok: false, reason: 'session_not_found' }
    const session = sink.getSession(sessionKey)
    if (!session) return { ok: false, reason: 'session_not_found' }
    const note = takeRestartBackgroundNote(sink.handle.db, sessionKey)
    if (!note) return { ok: false, reason: 'no_pending_note' }
    const cwd = session.cwd ?? ref.cwd ?? ''
    const runId = continueRunId(sessionKey, note)
    const commandId = `restart-continue:${sha256Hex(note).slice(0, 16)}`
    const payload = {
      runId,
      sessionKey,
      provider: session.provider,
      profile: session.profile,
      cwd,
      promptPreview: CONTINUE_AFTER_RESTART_PROMPT,
      userTextPreview: CONTINUE_AFTER_RESTART_PROMPT,
      claimMode: 'queued' as const,
      origin: 'agent' as const,
      body: {
        storage: 'inline' as const,
        sha256: sha256Hex(Buffer.from(CONTINUE_AFTER_RESTART_PROMPT, 'utf8')),
        bytes: Buffer.byteLength(CONTINUE_AFTER_RESTART_PROMPT, 'utf8'),
        inline: CONTINUE_AFTER_RESTART_PROMPT
      }
    }
    const result = writable.execute({
      type: 'run.submit',
      commandId,
      actor: 'system',
      scope: 'system',
      at: Date.now(),
      cwd,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    } as never)
    if (result.kind === 'rejected') {
      // Nothing is dispatched, so the note must stay on offer.
      sink.handle.db
        .prepare('INSERT INTO orch_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(`${NOTE_KEY_PREFIX}${sessionKey}`, note)
      return { ok: false, reason: result.reason ?? 'submit_rejected' }
    }
    // A queued submit is an outbox row; nothing drains it unless something pumps.
    deps.pumpOrchestration?.()
    return { ok: true, runId }
  }
})
