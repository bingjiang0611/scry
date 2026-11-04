import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { RemoteIntentRouting } from './host-controller'
import type { TraceEvent } from '../../shared/trace'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../../shared/runtime'

export interface RemoteRunTrace {
  providerId: string
  cwd: string
  prompt: string
  scryRunId: string
  externalSessionId: string
  providerTurnId?: string
  forkTurnId?: string
  agentProfileId?: string
  attachments: AgentInputAttachment[]
  items: TraceEvent[]
}

export interface RemoteRunCompletion {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  recording: 'committed' | 'failed'
  externalSessionId?: string
  providerTurnId?: string
  forkTurnId?: string
  error?: string
}

export interface RemoteRunBindingDependencies {
  // Production enters startAppRun. The optional provider seam below is only for
  // focused protocol tests and older isolated callers.
  startAppRun?(input: {
    runId: string
    ledgerRunId: string
    request: AgentStartRequest
    providerPrompt?: string
    stopSignal: AbortSignal
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
    onTraceEvent(event: TraceEvent): void
    onSession?(externalSessionId: string): void
    onRegistered?(info: { cwd: string }): void
    permissionModeOverride?: AgentStartRequest['permissionMode']
  }): Promise<RemoteRunCompletion>
  // Legacy seam retained for focused binding tests. Production provides startAppRun.
  run?(providerId: string, request: ProviderRunRequest): ProviderRunHandle
  permissionModeOverride?: AgentStartRequest['permissionMode']
  // scry runId minting; overridable for deterministic tests.
  nextScryRunId?: () => string
  // Optional Mac-catalog side effects so a device-initiated run is VISIBLE in the
  // owner's Scry session history exactly like a local run (the user's expectation:
  // "see the conversation on the Mac"). The binding stays pure - it does not know
  // runtimeProvider or where the catalog lives; index.ts resolves that and writes
  // an AppSession. Absent (tests) => no catalog side effect, run behaviour
  // unchanged. These record REAL identities only (minted scryRunId, the
  // Provider's own externalSessionId); nothing is fabricated.
  onRunStarted?(info: { providerId: string; cwd: string; prompt: string; scryRunId: string; agentProfileId?: string }): void
  onRunSession?(info: { providerId: string; cwd: string; prompt: string; scryRunId: string; externalSessionId: string; agentProfileId?: string }): void
  // Persist the run as a REAL Scry trace archive so the owner can OPEN the
  // conversation transcript on the Mac (not just see it listed). The binding
  // hands over the REAL accumulated trace events + the Provider's own session id;
  // index.ts builds the same trace archive a local run would (managed recorder
  // OFF). Called once on a terminal run that produced a session id. Best-effort:
  // a failed archive write never fails the run. Nothing is fabricated - these are
  // the Provider's real streamed events.
  // Awaited before the observer settles and before the ledger settles, so a
  // reader that sees the run end can already read its archive.
  onRunArchive?(info: RemoteRunTrace & { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; error?: string }): void | Promise<void>
  // Coalesced running evidence for crash recovery, not a fabricated terminal.
  // At most one write in flight; final archiving waits for it before replacing it.
  onRunCheckpoint?(info: RemoteRunTrace): Promise<void>
  // Mac-side live observation of this run (index.ts registers it in the same
  // RunRegistry as local runs). Opened before the Provider starts so no event
  // is missed; settled exactly once after the archive write, on every path.
  observe?(info: { providerId: string; cwd: string; prompt: string; ledgerRunId: string; scryRunId: string; agentProfileId?: string; resume?: string; attachments: AgentInputAttachment[] }): RemoteRunObserver
}

export interface RemoteRunObserver {
  attach(handle: ProviderRunHandle): void
  event(ev: TraceEvent): void
  session(externalSessionId: string): void
  // A native question is pending on the remote broker (request.runId is the
  // scry runId), so the Mac can show it too. Closed exactly once per question,
  // whichever side answered or when the Provider withdrew it.
  question(request: AgentQuestionRequest): void
  questionClosed(questionId: string): void
  // The Provider reached a terminal result; the archive may still be writing.
  done(result: { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; errorText?: string }): void
  settled(): void
}

export interface RemoteRunInput {
  // The durable ledger runId (recorded/dispatched by the dispatcher). Kept in
  // the signature for clarity and for the correlation marker below.
  runId: string
  routing: RemoteIntentRouting
  // Opaque, non-secret, non-terminal progress marker sink (ledger.markProgress).
  progress(detail?: string): void
  // The assistant's REAL trace CONTENT sink (masked + bounded by the log). This
  // is what lets the device render the actual output, not just the lifecycle.
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  requestUserInput?(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
  // Device stop request. Forwarded to the Provider handle's own interrupt; the
  // run still settles from the Provider result (e.g. status `interrupted`).
  stopSignal?: AbortSignal
}
