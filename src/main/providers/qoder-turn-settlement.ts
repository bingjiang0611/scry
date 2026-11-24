import { getSessionMessages } from '@qoder-ai/qoder-agent-sdk'
import type { HistoricalInput } from './historical-input'
import type { QoderBackgroundMonitor } from './qoder-background-work'
import type { QoderBackgroundTasks } from './qoder-messages'
import { isTranscriptUserPrompt } from './session-fork-boundary'
import { settleQoderInputReceipt, type QoderTranscriptMessage } from './qoder-input-receipt'
import { newId } from './qoder-shared'
import type { ProviderRunRequest } from './types'

export interface QoderTurnSettlementInput {
  request: ProviderRunRequest
  history: HistoricalInput
  backgroundTasks: QoderBackgroundTasks
  backgroundMonitor: QoderBackgroundMonitor
  activeAgentCalls: ReadonlySet<string>
  settleUnreportedAgents: (status: 'failed' | 'stopped', source: string) => void
  stopped: boolean
  externalSessionId: string | undefined
  /** Prompts already in the native transcript before this turn started. */
  forkBaseline: ReadonlySet<string>
  submittedUserUuid: string
  outgoingText: string
  currentProviderTurnId: () => string | undefined
}

/**
 * Converges what the stream left open when a Qoder turn ends.
 *
 * Two rules: an unsettled background task or Agent is reported as unknown rather than assumed
 * done, and a transcript read may complete the input receipt but never upgrades this run's own
 * failed or interrupted outcome.
 *
 * Returns the fork turn id this turn produced, and whether the turn must be reported as failed.
 */
export async function settleQoderTurn(input: QoderTurnSettlementInput): Promise<{
  failed: boolean
  forkTurnId: string | undefined
}> {
  const { request, backgroundTasks, history, stopped } = input
  let failed = false
  if (backgroundTasks.pending && !stopped) {
    failed = true
    request.emit({
      id: newId(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness',
      stage: 'runtime:background_unresolved',
      text: 'Qoder 连接已结束，但后台任务未返回终态；任务完成情况未知，请先核验文件，勿直接重试写入。',
      runtimeMetadata: { source: 'qoder_transport_ended', pendingTaskIds: backgroundTasks.tasks.map((task) => task.taskId) }
    })
  }
  if (input.activeAgentCalls.size > 0) {
    if (stopped) {
      input.settleUnreportedAgents('stopped', 'qoder_host_interruption')
    } else {
      input.settleUnreportedAgents('failed', 'qoder_transport_ended')
      failed = true
    }
  }
  input.backgroundMonitor.dispose()
  let forkTurnId: string | undefined
  if (input.externalSessionId) {
    try {
      const messages = await getSessionMessages(input.externalSessionId, { dir: request.cwd, includeSystemMessages: true })
      const candidates = messages.filter((message) => isTranscriptUserPrompt(message) && !input.forkBaseline.has(message.uuid))
      if (candidates.length === 1) forkTurnId = candidates[0].uuid
      // One transcript read serves the optional fork identity and the input receipt.
      if (history.snapshot()?.status === 'unknown') {
        settleQoderInputReceipt({
          history,
          messages: messages as readonly QoderTranscriptMessage[],
          submittedUserUuid: input.submittedUserUuid,
          outgoingText: input.outgoingText,
          externalSessionId: input.externalSessionId,
          providerTurnId: input.currentProviderTurnId()
        })
      }
    } catch (error) {
      // The completed turn remains valid even when its optional fork identity is unavailable.
      if (history.snapshot()?.status === 'unknown') {
        history.unverified(`Qoder 原生 transcript 不可读取：${(error as Error).message}`)
      }
    }
  }
  return { failed, forkTurnId }
}
