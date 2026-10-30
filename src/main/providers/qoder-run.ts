import { randomUUID } from 'node:crypto'
import {
  ProcessTransport,
  getSessionMessages,
  query,
  type McpServerStatus,
  type Query,
  type QueryTransportCreateOptions
} from '@qoder-ai/qoder-agent-sdk'
import type { TraceEvent } from '../../shared/trace'
import type { NormalizeCtx } from '../normalize-core'
import type { ProcessIdentity } from '../process-diagnostics'
import { QoderCreditCollector } from '../../shared/credit-usage'
import { QoderBackgroundMonitor } from './qoder-background-work'
import { normalizeQoderMessage, QoderBackgroundTasks } from './qoder-messages'
import { QoderTaskControlTransport } from './qoder-task-control'
import { HistoricalInput } from './historical-input'
import { isTranscriptUserPrompt } from './session-fork-boundary'
import { settleQoderInputReceipt, type QoderTranscriptMessage } from './qoder-input-receipt'
import {
  qoderContextTokensFromUsage,
  qoderLiveContext,
  qoderTrace,
  type QoderContextEvidence
} from './qoder-evidence'
import {
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderHookLog,
  qoderProviderTurnId,
  qoderProviderTurnIdFromLog,
  type QoderHookFallbackState,
  isAgentLaunchStatus,
  isAgentTerminalStatus,
  observedAgentStatus
} from './qoder-hooks'
import { livePrompt, qoderExecutable, qoderOptions, signalProcessTree } from './qoder-launch'
import { expandQoderProjectCommand, projectCommandMatch } from './qoder-commands'
import { qoderMcpSnapshot } from './qoder-mcp'
import { qoderCanUseTool } from './qoder-run-permissions'
import { newId } from './qoder-shared'
import { qoderContinuationKey } from './host-continuation-identity'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

export interface QoderRunDependencies {
  homeDir: string
  /** Adapter-level diagnostics read by `describe()`; not execution evidence. */
  hookFallback: QoderHookFallbackState
}

export function runQoder(request: ProviderRunRequest, deps: QoderRunDependencies): ProviderRunHandle {
  const history = new HistoricalInput(request)
  const submittedUserUuid = randomUUID()
  const controller = new AbortController()
  let stopped = false
  let externalSessionId = request.resume
  let providerTurnId: string | undefined
  let forkTurnId: string | undefined
  let providerTurnIdAmbiguous = false
  let providerStatus: 'completed' | 'failed' = 'completed'
  const observeProviderTurnId = (value: string | undefined): void => {
    if (!value || providerTurnIdAmbiguous) return
    if (!providerTurnId) providerTurnId = value
    else if (providerTurnId !== value) providerTurnIdAmbiguous = true
  }
  const currentProviderTurnId = (): string | undefined => providerTurnIdAmbiguous ? undefined : providerTurnId
  let q: Query | undefined
  let qoderPid: number | undefined
  let qoderIdentityPromise: Promise<ProcessIdentity | undefined> | undefined
  let streamSettled = false
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let rejectUnexpectedExit: (error: Error) => void = () => {}
  const unexpectedExit = new Promise<never>((_resolve, reject) => {
    rejectUnexpectedExit = reject
  })
  let providerFailureSeen = false
  let streamedText = ''
  let releaseProviderPrompt = (): void => {}
  const sdkHooks: TraceEvent[] = []
  const credits = new QoderCreditCollector()
  const activeAgentCalls = new Set<string>()
  const terminalAgentCalls = new Set<string>()
  const backgroundTasks = new QoderBackgroundTasks()
  let taskControl: QoderTaskControlTransport | undefined
  const backgroundMonitor = new QoderBackgroundMonitor(backgroundTasks, () => !stopped && !streamSettled && taskControl?.canStopTask === true, (backgroundWork) => {
    request.emit({
      id: newId(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness',
      stage: 'runtime:background_work', backgroundWork,
      runtimeMetadata: { source: 'qoder_background_observation' }
    })
  })
  const waitForUser = async <T>(action: () => Promise<T>): Promise<T> => {
    backgroundMonitor.pause()
    try { return await action() } finally { backgroundMonitor.resume() }
  }
  const hasPendingBackgroundWork = (): boolean => activeAgentCalls.size > 0 || backgroundTasks.pending
  const ctx: NormalizeCtx = {
    runId: request.runId,
    cwd: request.cwd,
    newId,
    now: () => new Date().toISOString(),
    contextTokensFromUsage: qoderContextTokensFromUsage
  }
  const observeAgentEvent = (event: TraceEvent, hasTerminalEvidence = true): void => {
    if (!event.toolUseId || terminalAgentCalls.has(event.toolUseId)) return
    const status = observedAgentStatus(event)
    if (event.stage === 'agent_activity' || isAgentLaunchStatus(status)) {
      activeAgentCalls.add(event.toolUseId)
      return
    }
    if (event.tool === 'Agent' && event.stage === 'tool_result' && isAgentTerminalStatus(status)) {
      activeAgentCalls.delete(event.toolUseId)
      terminalAgentCalls.add(event.toolUseId)
      if (hasTerminalEvidence) backgroundTasks.settleCall(event.toolUseId, 'Agent')
    }
  }
  const emitAgentFallback = (event: TraceEvent, hasTerminalEvidence: boolean): void => {
    if (!event.toolUseId || terminalAgentCalls.has(event.toolUseId)) return
    observeAgentEvent(event, hasTerminalEvidence)
    request.emit(event)
  }
  const settleUnreportedAgents = (agentStatus: 'failed' | 'stopped', source: string): void => {
    for (const toolUseId of activeAgentCalls) {
      emitAgentFallback({
        id: `qoder-fallback:agent:${request.runId}:${toolUseId}:${agentStatus}`,
        runId: request.runId,
        ts: new Date().toISOString(),
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Agent',
        toolUseId,
        text: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
        output: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
        isError: agentStatus === 'failed',
        runtimeMetadata: { source, agentStatus }
      }, false)
    }
  }
  const promise: Promise<ProviderRunResult> = (async () => {
    if (request.expectedContinuationKey) {
      // Settings can change between the consumer's decision and the dispatch, so the
      // identity is re-derived here from the same inputs the adapter reports.
      const actual = await qoderContinuationKey(
        { providerId: 'qoder', cwd: request.cwd, agentProfileId: request.agentProfileId },
        deps.homeDir,
        qoderExecutable()
      )
      // No CLI process exists yet, so a refusal keeps the receipt at `not_sent`.
      if (actual !== request.expectedContinuationKey) throw new Error('Qoder 接续身份已变化，输入未投递')
    }
    if (stopped) {
      return { externalSessionId: request.resume, providerTurnId: undefined, forkTurnId: undefined,
        stopped: true, status: 'interrupted', mcp: undefined }
    }
    const forkBaseline = new Set<string>()
    if (request.resume) {
      try {
        for (const message of await getSessionMessages(request.resume, { dir: request.cwd, includeSystemMessages: true })) {
          if (message.uuid) forkBaseline.add(message.uuid)
        }
      } catch {
        // Fork identity is optional for this turn; the Provider run itself must remain usable.
      }
    }
    const providerPrompt = request.cwd && projectCommandMatch(request.prompt)
      ? await expandQoderProjectCommand(request.prompt, request.cwd)
      : request.prompt
    // The run-owned UUID is the only user identity Scry can later match in the
    // native transcript; it is not a receipt by itself.
    const outgoingText = history.text(providerPrompt)
    const prompt = livePrompt(outgoingText, submittedUserUuid)
    releaseProviderPrompt = prompt.release
    // The CLI consumes this stream as soon as the transport starts, so the
    // attempt observation must precede query(), not the transcript read.
    history.attempting(outgoingText)
    q = query({
      // Keep control-response stdin open while Qoder-owned Agents or Bash
      // tasks are active, including model-policy requests on notification turns.
      prompt: prompt.stream,
      options: {
        transport: {
          create(options: QueryTransportCreateOptions) {
            taskControl = new QoderTaskControlTransport(new ProcessTransport(options))
            return taskControl
          }
        },
        ...qoderOptions(
          request.cwd,
          request.resume,
          (pid, identityPromise) => { qoderPid = pid; qoderIdentityPromise = identityPromise },
          (code, signal) => {
            if (stopped || streamSettled) return
            exitTimer = setTimeout(() => {
              rejectUnexpectedExit(new Error(`Qoder CLI 已退出，但 SDK 事件流未结束（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`))
            }, 1000)
          },
          request.permissionMode,
          request.managedRecorder === true,
          request.mcpExecution,
          request.managedRecorderIdentity
        ),
        ...(request.model && !request.effort ? { model: request.model.id } : {}),
        ...(request.model && request.effort
          ? {
              resolveModel: () => ({
                model: request.model!.id,
                parameters: { reasoningEffort: request.effort }
              })
            }
          : {}),
        ...(request.requestUserInput ? { canUseTool: qoderCanUseTool(request, waitForUser) } : {}),
        abortController: controller
      } as never
    })
    let statuses: McpServerStatus[] | undefined
    let terminalError: unknown
    try {
      try {
        await Promise.race([
          (async () => {
            for await (const message of q!) {
              const raw = message as unknown as Record<string, unknown>
              request.recordNative?.(typeof raw.type === 'string' ? raw.type : 'unknown', raw)
              credits.observe(raw)
              backgroundTasks.observe(raw)
              observeProviderTurnId(qoderProviderTurnId(raw))
              if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
                externalSessionId = raw.session_id
                // A resumed run must never accept input into a different native session.
                history.verifySession(raw.session_id)
                request.onExternalSessionId?.(raw.session_id)
              }
              if (raw.type === 'system' && raw.subtype === 'init' && Array.isArray(raw.mcp_servers)) {
                statuses = (raw.mcp_servers as Array<{ name: string; status: McpServerStatus['status'] }>).map((server) => ({
                  name: server.name,
                  status: server.status
                }))
              }
              if (raw.type === 'result' && (raw.subtype !== 'success' || raw.is_error === true)) {
                providerStatus = 'failed'
              }
              let contextEvidence: QoderContextEvidence | undefined
              if (raw.type === 'result' && !hasPendingBackgroundWork() && typeof q!.getContextUsage === 'function') {
                contextEvidence = await qoderLiveContext(q!)
              }
              for (const rawEvent of normalizeQoderMessage(message, ctx)) {
                const event = qoderTrace(rawEvent, contextEvidence)
                // Qoder flushes queued progress and duplicate terminals at query
                // end. A settled Agent must not reopen in either host state or UI.
                if (event.tool === 'Agent' && event.toolUseId && terminalAgentCalls.has(event.toolUseId) &&
                    (event.stage === 'agent_activity' || event.stage === 'tool_result')) continue
                observeAgentEvent(event)
                if (event.kind === 'harness' && event.stage === 'result' && event.isError) providerFailureSeen = true
                if (event.kind === 'hook') sdkHooks.push(event)
                if (event.kind === 'model' && event.stage === 'text_delta') {
                  streamedText += event.text ?? ''
                  request.emit(event)
                } else if (event.kind === 'model' && event.stage === 'text' && streamedText) {
                  const full = event.text ?? ''
                  const remainder = full.startsWith(streamedText) ? full.slice(streamedText.length) : full
                  streamedText = ''
                  if (remainder) request.emit({ ...event, text: remainder })
                } else {
                  request.emit(event)
                }
              }
              // A launch result is not terminal while background work remains.
              // Release only on the root result following the last notification.
              backgroundMonitor.observe(raw, hasPendingBackgroundWork())
              if (raw.type === 'result' && !hasPendingBackgroundWork()) releaseProviderPrompt()
            }
          })(),
          unexpectedExit
        ])
      } catch (error) {
        if (!providerFailureSeen) terminalError = error
      }
    } finally {
      request.emit({
        id: `credits:${request.runId}`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'harness', stage: 'credit_usage', runtimeProvider: 'qoder_cli',
        creditUsage: credits.evidence()
      })
      streamSettled = true
      // Stop diagnostics/controls now, but converge native log terminals before
      // publishing the final snapshot. Host interruption is not task evidence.
      backgroundMonitor.pause()
      releaseProviderPrompt()
      if (exitTimer) clearTimeout(exitTimer)
      try {
        await q.close()
      } catch (error) {
        if (!providerFailureSeen && terminalError == null) terminalError = error
      }
    }
    const logHooksEnabled = process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0'
    if ((request.managedRecorder === true || logHooksEnabled) && qoderPid) {
      try {
        const log = await qoderHookLog(qoderPid)
        observeProviderTurnId(qoderProviderTurnIdFromLog(log, externalSessionId))
        const backgroundFailures = parseQoderBackgroundTaskFailures(request.runId, log, externalSessionId)
        for (const event of backgroundFailures) {
          if (event.toolUseId) backgroundTasks.settleCall(event.toolUseId, 'Bash')
          request.emit(event)
        }
        if (backgroundFailures.length > 0) providerStatus = 'failed'
        const subagentTerminals = parseQoderSubagentTerminals(request.runId, log, externalSessionId)
        const missingSubagentTerminals = subagentTerminals.filter(
          (event) => event.toolUseId && !terminalAgentCalls.has(event.toolUseId)
        )
        for (const event of missingSubagentTerminals) emitAgentFallback(event, true)
        if (!stopped && missingSubagentTerminals.some((event) => observedAgentStatus(event) !== 'completed')) {
          providerStatus = 'failed'
        }
        if (logHooksEnabled) {
          const fallback = parseQoderHookLog(request.runId, log, externalSessionId)
          for (const event of qoderHookFallbackOnly(sdkHooks, fallback)) request.emit(event)
          deps.hookFallback.observed = true
        }
        deps.hookFallback.error = undefined
      } catch (error) {
        deps.hookFallback.error = String((error as Error).message)
        request.emit({
          id: newId(), runId: request.runId, ts: new Date().toISOString(),
          kind: 'harness', stage: 'runtime:telemetry_degraded', text: deps.hookFallback.error,
          runtimeMetadata: { source: 'qoder_cli_log', capability: 'hooks' }
        })
      }
    } else if ((request.managedRecorder === true || logHooksEnabled) && !qoderPid) {
      deps.hookFallback.error = 'Qoder log fallback could not identify the current CLI process'
    }
    if (backgroundTasks.pending && !stopped) {
      providerStatus = 'failed'
      request.emit({
        id: newId(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness',
        stage: 'runtime:background_unresolved',
        text: 'Qoder 连接已结束，但后台任务未返回终态；任务完成情况未知，请先核验文件，勿直接重试写入。',
        runtimeMetadata: { source: 'qoder_transport_ended', pendingTaskIds: backgroundTasks.tasks.map((task) => task.taskId) }
      })
    }
    if (activeAgentCalls.size > 0) {
      if (stopped) {
        settleUnreportedAgents('stopped', 'qoder_host_interruption')
      } else {
        settleUnreportedAgents('failed', 'qoder_transport_ended')
        providerStatus = 'failed'
      }
    }
    backgroundMonitor.dispose()
    if (externalSessionId) {
      try {
        const messages = await getSessionMessages(externalSessionId, { dir: request.cwd, includeSystemMessages: true })
        const candidates = messages.filter((message) =>
          isTranscriptUserPrompt(message) && !forkBaseline.has(message.uuid)
        )
        if (candidates.length === 1) forkTurnId = candidates[0].uuid
        // One transcript read serves the optional fork identity and the input receipt.
        // Acceptance follows the native evidence; the failed/interrupted outcome is
        // reported separately by this run and is never upgraded by this call.
        if (history.snapshot()?.status === 'unknown') {
          settleQoderInputReceipt({
            history,
            messages: messages as readonly QoderTranscriptMessage[],
            submittedUserUuid,
            outgoingText,
            externalSessionId,
            providerTurnId: currentProviderTurnId()
          })
        }
      } catch (error) {
        // The completed turn remains valid even when its optional fork identity is unavailable.
        if (history.snapshot()?.status === 'unknown') {
          history.unverified(`Qoder 原生 transcript 不可读取：${(error as Error).message}`)
        }
      }
    }
    if (terminalError != null) throw terminalError
    return {
      externalSessionId,
      providerTurnId: currentProviderTurnId(),
      forkTurnId,
      stopped,
      status: stopped ? 'interrupted' : providerStatus,
      mcp: statuses ? qoderMcpSnapshot(statuses) : undefined
    }
  })()
  const interrupt = (): void => {
    stopped = true
    backgroundMonitor.pause()
    releaseProviderPrompt()
    controller.abort()
    void q?.interrupt().catch(() => {})
  }
  return {
    promise,
    stopBackgroundTask: async (taskId) => {
      const task = backgroundTasks.tasks.find((task) => task.taskId === taskId)
      if (stopped || streamSettled || !task || task.stopState) {
        return { status: 'rejected', message: '该任务不属于当前活动轮次、已结束或已请求停止。' }
      }
      if (!taskControl?.canStopTask) return { status: 'unavailable', message: '当前 Qoder 版本不支持已验证的单任务停止，请使用停止本轮。' }
      backgroundTasks.markStop(taskId, 'requested')
      backgroundMonitor.refresh()
      const result = await taskControl.stopTask(taskId)
      backgroundTasks.markStop(taskId, result.status === 'unknown' ? 'unconfirmed' : result.status === 'requested' ? 'requested' : undefined)
      backgroundMonitor.refresh()
      return result
    },
    interrupt,
    forceKill: () => signalProcessTree(qoderIdentityPromise, 'SIGKILL'),
    // qoderPid 是本轮 spawn 的 CLI 进程树：硬杀不会波及其他 run。
    forceKillScope: 'run_scoped',
    getExternalSessionId: () => externalSessionId,
    getProviderTurnId: currentProviderTurnId,
    getForkTurnId: () => forkTurnId,
    getInputReceipt: () => history.snapshot()
  }
}
