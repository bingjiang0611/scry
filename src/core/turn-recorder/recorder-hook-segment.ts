import type { RecorderEnablement } from './config.js'
import type { RecorderHookInput, RecorderHookResult } from './recorder-contracts.js'
import { recorderSessionRoot as sessionRoot, type RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import { beginContinuationTurn, holdSeal, holdsStopForBackgroundWork } from './recorder-segment.js'
import { readQoderStopTranscript } from './qoder-stop-evidence.js'

export async function holdStopForBackgroundWork(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  input: RecorderHookInput
  sessionId: string
  open: OpenTurnState
  terminalAt: string
  attribution?: 'matched' | 'unproven'
}): Promise<RecorderHookResult | undefined> {
  const { enablement, input, open } = args
  if (!open.transcriptPath || !holdsStopForBackgroundWork(input.provider)) return undefined
  const read = await readQoderStopTranscript(enablement, open)
  if ((read?.pendingBackgroundTasks?.length ?? 0) === 0) return undefined
  const root = sessionRoot(enablement.dataRoot, input.provider, args.sessionId)
  return holdSeal(enablement, root, open, input, 'pending_background_tasks', args.terminalAt,
    args.attribution ? { attribution: args.attribution } : undefined)
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
