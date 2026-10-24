import type { ProviderRunRequest } from './types'
import type { TraceEvent } from '../../shared/trace'
import { record, serialized, bounded, type JsonRecord } from './pi-shared'
import { classifyTool, fileOpOf, mcpPayloadFailed, parseMcp, contextCompactionOf } from '../../shared/trace'
import { piEvent, piEventSequence } from './pi-rpc'
import type { PiRpcProcess } from './pi-rpc'
import type { PiRunState } from './pi-types'
import { PiBackgroundWork } from './pi-background-work'
import { PiQuestionnaire } from './pi-questionnaire'
import type { UsageAggregate } from './pi-usage'
import { addAssistantUsage, piLlmCall } from './pi-usage'
import { nativeCustomAnswerOption, questionFromExtension, extensionResponse } from './pi-events'

export interface PiEventHandlerContext {
  rpc: PiRpcProcess
  request: ProviderRunRequest
  state: PiRunState
  emitBackground: (work: ReturnType<PiBackgroundWork['observe']>) => void
  background: PiBackgroundWork
  agentEnded: boolean
  agentSettled: boolean
  agentCycleEnd: Promise<void>
  resolveAgentCycleEnd: () => void
  settledResolve: (() => void) | undefined
  nativeIdle: boolean
  agentStarted: boolean
  steerCapabilityEmitted: boolean
  steerPending: boolean
  streamedText: boolean
  streamedThinking: boolean
  assistantToolCallIds: Set<string>
  toolTermination: TraceEvent['toolTermination']
  assistantMessageId: string | undefined
  assistantFirstContentAtMs: number | undefined
  nextAssistantMessageId: (message: JsonRecord) => string
  currentAssistantMessageId: (message?: JsonRecord) => string
  usage: UsageAggregate
  modelContextWindows: Map<string, number>
  extensionCommand: string | undefined
  extensionCommandError: string | undefined
  historyReaderReady: boolean
  questionnaires: Map<string, PiQuestionnaire>
  stagedCustomAnswer: { value: string; inputTitle: string } | undefined
  abortController: AbortController
  toolNames: Map<string, string>
  toolStarts: Map<string, number>
}

export function attachPiEventHandlers(ctx: PiEventHandlerContext): () => void {
  return ctx.rpc.onEvent((event) => {
    ctx.request.recordNative?.(typeof event.type === 'string' ? event.type : 'unknown', event)
    ctx.emitBackground(ctx.background.observe(event))
    // Owned follow-up/Goal work can begin another agent cycle before canonical settlement.
    // Rearm only on agent_start, never on a late message from an ended cycle.
    if (event.type === 'agent_start' && ctx.agentEnded && !ctx.agentSettled) {
      ctx.agentEnded = false
      ctx.agentCycleEnd = new Promise<void>(resolve => { ctx.resolveAgentCycleEnd = resolve })
    }
    if (event.type === 'agent_start') ctx.nativeIdle = false
    if (event.type === 'agent_start' || event.type === 'tool_execution_start' ||
      (event.type === 'message_start' || event.type === 'message_end') &&
      ['user', 'assistant', 'toolResult'].includes(String(record(event.message).role))) {
      ctx.agentStarted = true
      if (!ctx.steerCapabilityEmitted && !ctx.agentSettled && !ctx.state.stopped) {
        ctx.steerCapabilityEmitted = true
        ctx.request.emit(piEvent(ctx.request.runId, {
          kind: 'harness', stage: 'runtime:steer_capability', providerId: 'pi', runtimeProvider: 'pi_rpc',
          steerCapability: { status: 'available', attachments: true }
        }))
      }
    }
    if (event.type === 'agent_end') {
      if (ctx.steerPending) ctx.state.steerAdmissionUncertain = true
      ctx.agentEnded = true
      ctx.resolveAgentCycleEnd()
    }
    if (event.type === 'agent_settled') {
      if (ctx.steerPending) ctx.state.steerAdmissionUncertain = true
      ctx.agentEnded = true
      ctx.resolveAgentCycleEnd()
      // Native idle does not include detached extension work. Keep this run's
      // listener/usage/recorder owner until the child result and parent continuation —
      // but only while the Provider still reports child evidence. An extension that
      // clears its async widget ends observation, so the release below settles the run
      // instead of holding it open for a terminal row that cannot arrive.
      if (event.aborted !== true && ctx.background.pending && !ctx.state.stopped) {
        ctx.nativeIdle = true
        return
      }
      ctx.nativeIdle = false
      ctx.agentSettled = true
      ctx.settledResolve?.()
      return
    }
    if (ctx.nativeIdle && !ctx.agentSettled && !ctx.state.stopped && !ctx.background.pending) {
      ctx.nativeIdle = false
      ctx.agentSettled = true
      ctx.settledResolve?.()
      return
    }
    if (event.type === 'message_start') {
      const message = record(event.message)
      if (message.role === 'assistant') {
        ctx.streamedText = false
        ctx.streamedThinking = false
        ctx.assistantToolCallIds.clear()
        ctx.toolTermination = undefined
        ctx.assistantMessageId = ctx.nextAssistantMessageId(message)
        ctx.assistantFirstContentAtMs = undefined
      }
      return
    }
    if (event.type === 'message_update') {
      ctx.assistantFirstContentAtMs ??= Date.now()
      const delta = record(event.assistantMessageEvent)
      const messageId = ctx.currentAssistantMessageId()
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
        ctx.streamedText = true
        ctx.request.emit(piEvent(ctx.request.runId, { kind: 'model', stage: 'text_delta', text: delta.delta, messageId }))
      } else if (delta.type === 'thinking_delta' && typeof delta.delta === 'string') {
        ctx.streamedThinking = true
        ctx.request.emit(piEvent(ctx.request.runId, { kind: 'model', stage: 'thinking', thinking: delta.delta, messageId }))
      }
      return
    }
    if (event.type === 'message_end') {
      const message = record(event.message)
      if (message.role === 'custom' && message.display === true) {
        ctx.request.emit(piEvent(ctx.request.runId, {
          kind: 'harness', stage: 'runtime:extension_message', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: typeof message.content === 'string' ? message.content :
            (Array.isArray(message.content) ? message.content.map(record) : [])
              .filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n'),
          runtimeMetadata: { customType: message.customType }
        }))
      }
      if (message.role !== 'assistant') return
      const messageId = ctx.currentAssistantMessageId(message)
      if (addAssistantUsage(ctx.usage, message, ctx.modelContextWindows)) {
        // A request-level sample, not a turn result: never feed these snapshots into billing totals.
        ctx.request.emit(piEvent(ctx.request.runId, {
          kind: 'harness',
          stage: 'context_usage',
          messageId,
          contextTokens: ctx.usage.lastContextTokens,
          contextModel: ctx.usage.lastContextModel,
          contextProvider: ctx.usage.lastContextProvider,
          contextUsageSource: ctx.usage.contextUsageSource,
          contextUsageQuality: ctx.usage.contextUsageQuality,
          modelUsage: [{
            model: ctx.usage.lastContextModel!,
            upstreamProvider: ctx.usage.lastContextProvider,
            contextWindow: ctx.modelContextWindows.get(`${ctx.usage.lastContextProvider ?? ''}\0${ctx.usage.lastContextModel}`)
          }]
        }))
      }
      ctx.assistantToolCallIds = new Set(
        (Array.isArray(message.content) ? message.content.map(record) : [])
          .filter((block) => block.type === 'toolCall' && typeof block.id === 'string')
          .map((block) => block.id as string)
      )
      if (!ctx.streamedText || !ctx.streamedThinking) {
        const content = Array.isArray(message.content) ? message.content.map(record) : []
        for (const block of content) {
          if (!ctx.streamedText && block.type === 'text' && typeof block.text === 'string') {
            ctx.request.emit(piEvent(ctx.request.runId, {
              kind: 'model', stage: 'text_delta', text: block.text, messageId,
              runtimeMetadata: { bufferedOutput: true }
            }))
          }
          if (!ctx.streamedThinking && block.type === 'thinking' && typeof block.thinking === 'string') {
            ctx.request.emit(piEvent(ctx.request.runId, { kind: 'model', stage: 'thinking', thinking: block.thinking, messageId }))
          }
        }
      }
      ctx.request.emit(piEvent(ctx.request.runId, { kind: 'harness', stage: 'runtime:llm_stream_end', messageId, ...piLlmCall(message, Date.now(), ctx.assistantFirstContentAtMs) }))
      ctx.assistantMessageId = undefined
      ctx.assistantFirstContentAtMs = undefined
      return
    }
    if (event.type === 'tool_execution_start') {
      const toolUseId = typeof event.toolCallId === 'string' ? event.toolCallId : `pi-tool-${piEventSequence()}`
      const rawName = typeof event.toolName === 'string' ? event.toolName : 'Tool'
      const toolName = rawName === 'subagent' ? 'Agent' : rawName
      const input = record(event.args)
      if (rawName === 'ask_user_question') {
        const questionnaire = PiQuestionnaire.fromTool(ctx.request.runId, toolUseId, input)
        if (questionnaire) ctx.questionnaires.set(toolUseId, questionnaire)
      }
      const classified = classifyTool(toolName, input)
      ctx.toolNames.set(toolUseId, toolName)
      ctx.toolStarts.set(toolUseId, Date.now())
      ctx.request.emit(piEvent(ctx.request.runId, {
        kind: classified.kind,
        stage: `${classified.kind}:${classified.name}`,
        tool: toolName,
        name: classified.name,
        toolUseId,
        input,
        ...parseMcp(rawName, input),
        ...fileOpOf(toolName, input)
      }))
      return
    }
    if (event.type === 'tool_execution_end') {
      const toolUseId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
      const rawName = typeof event.toolName === 'string' ? event.toolName : ctx.toolNames.get(toolUseId ?? '') ?? 'Tool'
      const toolName = rawName === 'subagent' ? 'Agent' : rawName
      const output = serialized(event.result)
      const result = record(event.result)
      // The native loop may intentionally end after a tool (Goal pause/complete/continue).
      // Only the current assistant's explicit termination receipt proves this boundary;
      // tool names, human text, child events and an unexplained toolUse are not sufficient.
      if (result.terminate === true && toolUseId && ctx.assistantToolCallIds.has(toolUseId)) {
        const content = Array.isArray(result.content) ? result.content.map(record) : []
        ctx.toolTermination = {
          tool: toolName,
          message: bounded(content.filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n'), 4_000)
        }
      }
      const mcp = parseMcp(rawName, record(event.args))
      const startedAt = toolUseId ? ctx.toolStarts.get(toolUseId) : undefined
      ctx.request.emit(piEvent(ctx.request.runId, {
        kind: 'tool',
        stage: 'tool_result',
        tool: toolName,
        toolUseId,
        output,
        text: output,
        durationMs: startedAt == null ? undefined : Date.now() - startedAt,
        ...mcp,
        isError: event.isError === true || (mcp.isMcp && mcpPayloadFailed(output))
      }))
      if (toolUseId) {
        ctx.toolNames.delete(toolUseId)
        ctx.toolStarts.delete(toolUseId)
        ctx.questionnaires.delete(toolUseId)
      }
      return
    }
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      const lifecycle = piEvent(ctx.request.runId, {
        kind: 'harness',
        stage: event.type,
        runtimeMetadata: event
      })
      const compaction = contextCompactionOf(lifecycle)
      if (compaction) {
        lifecycle.stage = 'context_compaction'
        lifecycle.compaction = compaction
        // The pre-compaction request no longer describes the active context. Wait for new usage.
        ctx.usage.lastContextTokens = undefined
        ctx.usage.lastContextModel = undefined
        ctx.usage.lastContextProvider = undefined
        ctx.usage.contextUsageSource = undefined
        ctx.usage.contextUsageQuality = undefined
      }
      ctx.request.emit(lifecycle)
      return
    }
    if (event.type === 'extension_error') {
      if (ctx.extensionCommand && event.event === 'command' && event.extensionPath === `command:${ctx.extensionCommand}`) {
        ctx.extensionCommandError = bounded(event.error, 4_000)
      }
      ctx.request.emit(piEvent(ctx.request.runId, {
        kind: 'harness',
        stage: 'runtime:extension_error',
        text: bounded(event.error, 4_000),
        isError: true,
        runtimeMetadata: { extensionPath: event.extensionPath, event: event.event }
      }))
      return
    }
    if (event.type !== 'extension_ui_request') return
    if (ctx.request.historyReader && event.method === 'notify' && event.message === `scry_history_ready:${ctx.request.historyReader.snapshotId}`) {
      ctx.historyReaderReady = true
      return
    }
    const question = questionFromExtension(ctx.request.runId, event)
    if (question && ctx.request.requestUserInput && ctx.questionnaires.size > 0) {
      const matches = [...ctx.questionnaires.values()].filter((candidate) => candidate.matches(event))
      if (matches.length === 1) {
        void matches[0].reply(event, (group) => ctx.request.requestUserInput!(group, ctx.abortController.signal))
          .then((reply) => ctx.rpc.notify(ctx.abortController.signal.aborted
            ? { type: 'extension_ui_response', id: event.id, cancelled: true } : reply))
          .catch(() => ctx.rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true }))
        return
      }
      // A different/changed native dialog must never consume answers approved for this group.
      ctx.questionnaires.clear()
    }
    if (question && ctx.stagedCustomAnswer !== undefined) {
      const answer = ctx.stagedCustomAnswer
      ctx.stagedCustomAnswer = undefined
      // The questionnaire follows its sentinel with the same question + input label.
      // Older versions sent only the label; do not accept another question's suffix.
      if (event.method === 'input' && (event.title === answer.inputTitle || event.title === 'Type your answer:')) {
        ctx.rpc.notify(ctx.abortController.signal.aborted
          ? { type: 'extension_ui_response', id: event.id, cancelled: true }
          : { type: 'extension_ui_response', id: event.id, value: answer.value })
        return
      }
    }
    if (!question || !ctx.request.requestUserInput) {
      if (question) ctx.rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true })
      else ctx.request.emit(piEvent(ctx.request.runId, {
        kind: 'harness',
        stage: 'runtime:extension_ui',
        providerId: 'pi', runtimeProvider: 'pi_rpc',
        isError: event.method === 'notify' && event.notifyType === 'error',
        text: bounded(event.method === 'notify' ? event.message : event, 4_000),
        runtimeMetadata: { method: event.method, notifyType: event.notifyType }
      }))
      return
    }
    void ctx.request.requestUserInput(question, ctx.abortController.signal)
      .then((response) => {
        const customOption = nativeCustomAnswerOption(event)
        if (customOption && response.behavior === 'answered') {
          const prompt = question.questions[0]
          const answer = response.answers[prompt.question]
          if (response.nativeCustomAnswer || !prompt.options.some((option) => (option.answerValue ?? option.label) === answer)) {
            // RPC select titles append previews; the follow-up input omits them.
            // Use the raw title, not the bounded display copy in question.questions.
            const title = String(event.title ?? 'Pi Extension').split(/\n\n--- \d+\. [^\n]+ preview ---\n/, 1)[0]
            ctx.stagedCustomAnswer = { value: answer, inputTitle: `${title}\n\nType your answer:` }
            ctx.rpc.notify({ type: 'extension_ui_response', id: event.id, value: customOption })
            return
          }
        }
        ctx.rpc.notify(extensionResponse(event, question, response))
      })
      .catch(() => ctx.rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true }))
  })
}
