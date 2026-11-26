import type { TurnEvidence } from '../../shared/turn-record.js'
import { available, disabled, partial, unavailable } from '../../shared/turn-record.js'
import type { RecorderEnablement } from './config.js'
import { writeRecorderContent } from './content-store.js'
import { PENDING_QODER_TRANSCRIPT_REASON } from './pending-qoder-transcript.js'
import type { TranscriptRead } from './recorder-contracts.js'
import type { RecorderOpenTurnState } from './runtime-state.js'
import { isFullToolContentPolicy, type ToolContentPolicy } from './tool-content.js'

export async function transcriptTurnEvidence(args: {
  open: RecorderOpenTurnState
  enablement: Extract<RecorderEnablement, { enabled: true }>
  transcript: TranscriptRead
  contentPolicy: ToolContentPolicy
  pendingTranscript: boolean
  unreadReason?: string
  incompleteReplyReason?: string
  transcriptUnavailable?: string
  terminalOnlyTranscript?: TranscriptRead
}): Promise<NonNullable<TurnEvidence['transcript']>> {
  const { open, enablement, transcript, contentPolicy, pendingTranscript } = args
  if (args.unreadReason) return unavailable(args.unreadReason)
  if (!open.transcriptPath) return unavailable(pendingTranscript
    ? PENDING_QODER_TRANSCRIPT_REASON : 'provider transcript path was not observable')
  if (!enablement.config.capture.prompt || !enablement.config.capture.assistant || !isFullToolContentPolicy(contentPolicy)) {
    return disabled('raw transcript capture disabled by content policy')
  }
  if (!transcript.source) {
    return unavailable(args.transcriptUnavailable ?? args.terminalOnlyTranscript?.incompleteReasons?.join('; ') ??
      'stable transcript bytes were not available for this turn')
  }
  const source = transcript.source
  if (Buffer.byteLength(source.content) !== source.endOffset - source.startOffset) {
    return unavailable('transcript range was not valid UTF-8 and could not be stored exactly')
  }
  const contentRef = await writeRecorderContent(enablement.dataRoot, source.content, 'utf8')
  const value = {
    contentRef,
    sourcePath: source.sourcePath,
    startOffset: source.startOffset,
    endOffset: source.endOffset,
    identity: source.identity,
    sourceCompleteness: source.sourceCompleteness
  }
  return source.sourceCompleteness === 'complete' && !args.incompleteReplyReason
    ? available(value, ['provider_transcript'])
    : partial(value, ['provider_transcript'],
      transcript.incompleteReasons?.join('; ') || 'transcript parser window started after an incomplete source line', 'exact')
  }
