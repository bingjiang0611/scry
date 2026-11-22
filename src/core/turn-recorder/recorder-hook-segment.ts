import type { RecorderEnablement } from './config.js'
import type { RecorderHookInput, RecorderHookResult } from './recorder-contracts.js'
import { recorderSessionRoot as sessionRoot, type RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import { beginContinuationTurn, holdSeal, holdsStopForBackgroundWork } from './recorder-segment.js'
import { stableTranscript } from './recorder-transcript-cache.js'

export async function holdStopForBackgroundWork(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  input: RecorderHookInput
  sessionId: string
  open: OpenTurnState
  terminalAt: string
}): Promise<RecorderHookResult | undefined> {
  const { enablement, input, open } = args
  if (!open.transcriptPath || !holdsStopForBackgroundWork(input.provider)) return undefined
  const read = await stableTranscript(
    open.transcriptPath, `${open.provider}:${open.sessionId}:${open.generation}`, open.provider,
    open.promptHash, open.providerTurnId, 0, open.requestSetId, open.sessionId, enablement.workspaceRoot,
    undefined, open.captureTranscriptEndOffset
  )
  if ((read.pendingBackgroundTasks?.length ?? 0) === 0) return undefined
  const root = sessionRoot(enablement.dataRoot, input.provider, args.sessionId)
  return holdSeal(enablement, root, open, input, 'pending_background_tasks', args.terminalAt)
}

export async function openContinuationSegment(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  input: RecorderHookInput
  sessionId: string
}): Promise<RecorderHookResult> {
  const continuation = await beginContinuationTurn(args.enablement, args.input, args.sessionId)
  return continuation
    ? { status: 'started', reason: 'background wake continued a sealed turn' }
    : { status: 'ignored', reason: 'background wake has no sealed turn to continue' }
}
