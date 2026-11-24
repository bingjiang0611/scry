import { randomUUID } from 'node:crypto'
import {
  ProcessTransport,
  getSessionMessages,
  query,
  type McpServerStatus,
  type Query,
  type QueryTransportCreateOptions,
  type SDKUserMessage
} from '@qoder-ai/qoder-agent-sdk'
import type { TraceEvent } from '../../shared/trace'
import type { NormalizeCtx } from '../normalize-core'
import type { ProcessIdentity } from '../process-diagnostics'
import { QoderCreditCollector } from '../../shared/credit-usage'
import { QoderBackgroundMonitor } from './qoder-background-work'
import { normalizeQoderMessage, QoderBackgroundTasks } from './qoder-messages'
import { QoderTaskControlTransport } from './qoder-task-control'
import { HistoricalInput } from './historical-input'
import {
  qoderContextTokensFromUsage,
  qoderLiveContext,
  qoderTrace,
  type QoderContextEvidence
} from './qoder-evidence'
import {
  qoderProviderTurnId,
  type QoderHookFallbackState,
  isAgentLaunchStatus,
  isAgentTerminalStatus,
  observedAgentStatus
} from './qoder-hooks'
import { livePrompt, QoderStderrTail, qoderExecutable, qoderMcpLaunch, qoderOptions, signalProcessTree, type QoderMcpLaunch } from './qoder-launch'
import { expandQoderProjectCommand, projectCommandMatch } from './qoder-commands'
import { qoderMcpSnapshot } from './qoder-mcp'
import { qoderCanUseTool } from './qoder-run-permissions'
import { applyQoderLogFallback } from './qoder-log-fallback'
import { settleQoderTurn } from './qoder-turn-settlement'
import type { QoderSessionPool } from './qoder-session-pool'
import type { QoderTurnChannel } from './qoder-session'
import { newId } from './qoder-shared'
import { qoderContinuationKey } from './host-continuation-identity'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

export interface QoderRunDependencies {
  homeDir: string
  /** Adapter-level diagnostics read by `describe()`; not execution evidence. */
  hookFallback: QoderHookFallbackState
  /**
   * C1: when the host supplies a pool, one CLI session serves the conversation instead of one
   * process per turn. Without it every turn keeps its own process, as before.
   */
  qoderSessions?: QoderSessionPool
}

/**
 * Reuse is safe only when the next turn asks for exactly what the session was opened with. The key
 * therefore carries the continuation identity and every turn option that the SDK fixes at open time.
 */
function qoderSessionKey(request: ProviderRunRequest): string {
  return [
    // Without a consumer-supplied identity, the conversation is still identified by where it runs.
    request.expectedContinuationKey ?? `unverified:${request.cwd ?? ''}`,
    request.resume ?? 'fresh',
    request.permissionMode ?? 'default',
    request.requestUserInput ? 'ask' : 'no_ask',
    request.model?.id ?? 'default',
    request.effort ?? 'default',
    JSON.stringify(request.mcpExecution ?? null)
  ].join('|')
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
  const stderrTail = new QoderStderrTail()
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
  // Owns the private MCP config file for this launch; removed when the run settles.
  let mcpLaunch: QoderMcpLaunch | undefined
  const promise: Promise<ProviderRunResult> = (async (): Promise<ProviderRunResult> => {
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
    // Written before the attempt is recorded: a failed write sends nothing.
    const mcp = qoderMcpLaunch(request.mcpExecution)
    mcpLaunch = mcp
    // The CLI consumes this stream as soon as the transport starts, so the
    // attempt observation must precede query(), not the transcript read.
    history.attempting(outgoingText)
    const openQuery = (promptStream: AsyncIterable<SDKUserMessage>): Query => query({
      // Keep control-response stdin open while Qoder-owned Agents or Bash
      // tasks are active, including model-policy requests on notification turns.
      prompt: promptStream,
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
          mcp.options,
          request.managedRecorderIdentity,
          stderrTail
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
    let turnChannel: QoderTurnChannel | undefined
    const sessions = deps.qoderSessions
    const lease = sessions
      ? sessions.acquire(qoderSessionKey(request), (promptStream) => ({ query: openQuery(promptStream as AsyncIterable<SDKUserMessage>) }))
      : undefined
    if (lease) {
      q = lease.query
      // The session's prompt stream stays open across turns; each turn contributes one user message.
      lease.send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: outgoingText }] },
        parent_tool_use_id: null,
        // Scry-owned identity for the submitted message: the native transcript must keep it.
        uuid: submittedUserUuid
      })
      // The root result ends the turn, not the session: the channel hands the reader back.
      const turn = lease.beginTurn()
      turnChannel = turn
      releaseProviderPrompt = () => turn.end()
    } else {
      const prompt = livePrompt(outgoingText, submittedUserUuid)
      releaseProviderPrompt = prompt.release
      q = openQuery(prompt.stream)
    }
    let statuses: McpServerStatus[] | undefined
    let terminalError: unknown
    try {
      try {
        await Promise.race([
          (async () => {
            for await (const message of turnChannel ?? q!) {
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
                lease?.recordNativeSession(raw.session_id)
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
      if (lease) {
        // The turn is over; the session stays open for the next turn under the shared idle window.
        lease.release()
      } else {
        try {
          await q.close()
        } catch (error) {
          if (!providerFailureSeen && terminalError == null) terminalError = error
        }
      }
    }
    if (await applyQoderLogFallback({
      request,
      hookFallback: deps.hookFallback,
      pid: qoderPid,
      externalSessionId,
      sdkHooks,
      terminalAgentCalls,
      backgroundTasks,
      stopped,
      observeProviderTurnId,
      emitAgentFallback
    })) providerStatus = 'failed'
    const settlement = await settleQoderTurn({
      request, history, backgroundTasks, backgroundMonitor, activeAgentCalls,
      settleUnreportedAgents, stopped, externalSessionId, forkBaseline,
      submittedUserUuid, outgoingText, currentProviderTurnId
    })
    if (settlement.failed) providerStatus = 'failed'
    if (settlement.forkTurnId) forkTurnId = settlement.forkTurnId
    if (terminalError != null) throw stderrTail.attach(terminalError)
    return {
      externalSessionId,
      providerTurnId: currentProviderTurnId(),
      forkTurnId,
      stopped,
      status: stopped ? 'interrupted' : providerStatus,
      mcp: statuses ? qoderMcpSnapshot(statuses) : undefined
    }
    // A session-owned MCP config outlives the turn; only a per-turn launch is disposed here.
  })().finally(() => { if (!deps.qoderSessions) mcpLaunch?.dispose() })
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
