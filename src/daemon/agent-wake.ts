import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { OrchestrationCommand } from '../host-runtime/orchestration/orchestrator-commands'

/**
 * C3: when work the model left running finishes, the host wakes the session with a run of its own
 * instead of leaving the reply stranded in the transcript. The wake is a normal queued submit, so
 * it waits behind anything live (D1) and the App shows it as an agent turn, not the user's.
 *
 * The command id is derived from the background task, so a task that reports completion twice
 * wakes the session once.
 */
export interface AgentWakeInput {
  taskId: string
  sessionKey: string
  provider: string
  profile: string | null
  cwd: string
  prompt: string
  /** Inline intent body stays small: the wake prompt describes the finished task, not its output. */
  promptPreview?: string
}

export interface AgentWakeResult {
  status: 'recorded' | 'duplicate' | 'unavailable'
  runId?: string
  reason?: string
}

function uuidFromTask(taskId: string, sessionKey: string): string {
  const hex = sha256Hex(`${sessionKey}\u0000${taskId}`)
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function submitAgentWake(sink: EventSink | undefined, input: AgentWakeInput, now: number): AgentWakeResult {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  if (!input.taskId || !input.sessionKey) return { status: 'unavailable', reason: 'agent_wake_missing_identity' }
  // Derived from the task, so a repeated completion is the same command with the same payload:
  // the receipt turns it into a duplicate instead of a second wake.
  const runId = uuidFromTask(input.taskId, input.sessionKey)
  const payload = {
    runId,
    sessionKey: input.sessionKey,
    provider: input.provider,
    profile: input.profile,
    cwd: input.cwd,
    promptPreview: input.promptPreview ?? input.prompt,
    userTextPreview: input.prompt,
    claimMode: 'queued' as const,
    origin: 'agent' as const,
    body: {
      storage: 'inline' as const,
      sha256: sha256Hex(Buffer.from(input.prompt, 'utf8')),
      bytes: Buffer.byteLength(input.prompt, 'utf8'),
      inline: input.prompt
    }
  }
  const result = sink.execute({
    type: 'run.submit',
    commandId: `agent-wake:${input.taskId}`,
    actor: 'system',
    scope: 'system',
    at: now,
    cwd: input.cwd,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  } as OrchestrationCommand)
  if (result.kind === 'rejected') return { status: 'unavailable', reason: result.reason }
  // The run id is derived from the task, so a duplicate names the same run without reading the
  // earlier receipt back.
  if (result.kind === 'duplicate') return { status: 'duplicate', runId }
  return { status: 'recorded', runId }
}
