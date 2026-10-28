import { createTurnWallTimer } from './turn-wall-timing'
import { LlmPerformanceObserver } from './llm-performance'
import { TurnChangeJournal } from '../core/turn-recorder/change-journal'
import { LiveTraceIngestion } from './live-trace-ingestion'
import { WriteCompletionTracker } from './session-diff'
import { attachConfiguredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import { appendUsage, appendLlmPerformance } from './usage-jsonl'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { LlmNetworkConfiguration } from '../shared/llm-performance'
import type { GitTurnDiffCapture } from './git'
import type { PreparedAttachment } from './attachment-store'
import type { AppRunExecutionDeps, AppRunExecutionState } from './app-run-lifecycle-types'

export type AppRunExecutionSetupState = Pick<AppRunExecutionState,
  'contextKey' | 'resume' | 'catalogCwd' | 'cwd' | 'managedRecorderEnabled' | 'managedRecorderEnablement' |
  'runId' | 'request' | 'options' | 'isRemoteRun' | 'isWorkflowRun' | 'isAuthoringRun' | 'providerId' |
  'agentProfileId' | 'runtimeProvider' | 'toolContentPolicy'>

export type AppRunExecutionSetupDeps = Pick<AppRunExecutionDeps,
  'sessionBaselineKey' | 'llmNetworkConfiguration' | 'homeDir' | 'recordTurn' | 'appSessionStore' |
  'win' | 'rendererCanReceive' | 'runs' | 'queueTrace' | 'persistTraceToolEvents' | 'mainEventId' |
  'liveToolContentPolicy' | 'appendTrace'> & { appUserData: () => string }

export interface PreparedAppRunExecution {
  initialDiffContextKey: string
  finishTurnWallTiming: () => TraceEvent
  turnChangeJournal: TurnChangeJournal | null
  runState: ActiveRun
  persistRunData: (sessionId?: string) => void
  cleanupProvisional: () => void
  ingestion: LiveTraceIngestion
  emit: (rawEvent: TraceEvent) => void
  persistLlmPerformance: (failed: boolean, externalSessionId: string) => Promise<void>
  attachments: PreparedAttachment[]
  displayPrompt: string
  unavailableCapture: () => GitTurnDiffCapture
  networkConfiguration: Promise<LlmNetworkConfiguration>
  setNotifyDiffChange: (value: () => void) => void
  setCurrentObservedSessionId: (value: () => string | undefined) => void
}

export async function prepareAppRunExecution(state: AppRunExecutionSetupState, deps: AppRunExecutionSetupDeps): Promise<PreparedAppRunExecution> {
  const { contextKey, resume, catalogCwd, cwd, managedRecorderEnabled, managedRecorderEnablement, runId, request, options, isRemoteRun, isWorkflowRun, isAuthoringRun, providerId, agentProfileId, runtimeProvider, toolContentPolicy } = state
  const { sessionBaselineKey, llmNetworkConfiguration, homeDir, recordTurn, appSessionStore, win, rendererCanReceive, runs, queueTrace, persistTraceToolEvents, appUserData, mainEventId, liveToolContentPolicy, appendTrace } = deps
  const initialDiffContextKey = resume ? sessionBaselineKey(contextKey, resume) : JSON.stringify([contextKey, 'run', runId])
  const finishTurnWallTiming = createTurnWallTimer(runId)
  const llmPerformance = new LlmPerformanceObserver(request.networkLabel)
  // Start collection without delaying Provider startup. Freeze this run's configuration evidence.
  let runNetworkConfiguration: LlmNetworkConfiguration | undefined
  const networkConfiguration: Promise<LlmNetworkConfiguration> = llmNetworkConfiguration.read().then((config: LlmNetworkConfiguration) => {
    runNetworkConfiguration = config
    return config
  })
  const hookConfig = isAuthoringRun ? null :
    providerId === 'claude' && cwd
      ? loadClaudeHookConfig(cwd, homeDir)
      : providerId === 'codex' && cwd
        ? loadCodexHookConfig(cwd, homeDir)
        : null
  const unavailableCapture = (): GitTurnDiffCapture => {
    const beforeAt = new Date().toISOString()
    return { beforeAt, captureMs: 0, status: 'unavailable', reason: 'not_git' }
  }
  const turnChangeJournal = cwd ? new TurnChangeJournal(cwd) : null
  let attachments: PreparedAttachment[] = []
  const displayPrompt = request.prompt
  const runState: ActiveRun = {
    runId,
    providerId,
    agentProfileId,
    cwd,
    externalSessionId: resume,
    sessionId: resume,
    userText: displayPrompt,
    attachments,
    items: [],
    done: false,
    providerSettled: false
  }
  const persistRunData = (sessionId?: string): void => {
    const result = [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')
    if (!recordTurn({
      runId,
      sessionId,
      cwd,
      userText: displayPrompt,
      items: runState.items,
      providerId,
      runtimeProvider,
      billingProvider: result?.billingProvider,
      ...(toolContentPolicy ? { toolContentPolicy } : {})
    })) return
    if (!isWorkflowRun) win?.webContents.send('agent:dataUpdated', { runId, kind: 'turn_recorded' })
  }
  const cleanupProvisional = (): void => {
    if (resume || runState.externalSessionId) return
    const ref = { providerId, agentProfileId, cwd: catalogCwd, externalSessionId: runId }
    if (!appSessionStore().isArchived(ref)) appSessionStore().remove(ref)
  }
  // emit 早于 diffPreviewer 构造，这里留一个前向钩子；构造完成后接上真正的预览刷新。
  let notifyDiffChange: () => void = () => {}
  let currentObservedSessionId: () => string | undefined = () => resume
  // App trace capture does not require a workspace recorder. Keep raw evidence until its
  // durable body exists; then release it from run state and send only the bounded projection.
  const ingestionEnablement = managedRecorderEnablement?.enabled ? managedRecorderEnablement : undefined
  const ingestionRecorderRoot = managedRecorderEnabled && ingestionEnablement?.config.capture.toolOutput === 'full'
    ? ingestionEnablement.dataRoot : undefined
  const ingestion = new LiveTraceIngestion({
    provider: providerId,
    publish: (event) => { if (runs.isViewed(runId)) queueTrace(event) },
    persist: async (event) => {
      const [persisted] = await persistTraceToolEvents(appUserData(), catalogCwd, [event], ingestionRecorderRoot)
      return persisted
    },
    onPersisted: (event) => {
      const index = runState.items.findIndex((item) => item.id === event.id)
      if (index >= 0) runState.items[index] = event
    },
    onError: (error) => console.warn('[scry] trace content persistence failed; retaining raw evidence:', error)
  })
  // 结构化 write/edit 的 start → tool_result 关联器：预览只跟着「已落盘」的结果走。
  const writeCompletions = new WriteCompletionTracker()
  const emit = (rawEvent: TraceEvent): void => {
    const decorated = hookConfig ? attachConfiguredHookCommands(rawEvent, hookConfig) : rawEvent
    const ev = !decorated.agentId && !decorated.parentToolUseId
      ? { ...decorated, llmPerformance: { ...llmPerformance.observe(decorated, runState.items), networkConfiguration: runNetworkConfiguration } }
      : decorated
    turnChangeJournal?.record(ev)
    if (ev.llmPerformance) runState.llmPerformance = ev.llmPerformance
    if (ev.kind === 'harness' && ev.stage === 'result') {
      appendUsage(
        appUserData(),
        { providerId, agentProfileId, runtimeProvider, cwd, externalSessionId: currentObservedSessionId(), runId, source: ev.usageSource },
        ev
      )
    }
    const liveEvent = sanitizeToolEvents([ev], liveToolContentPolicy, 'live_renderer')[0]
    appendTrace(runState.items, ev)
    ingestion.enqueue(ev, liveEvent)
    if (ev.backgroundWork && !isWorkflowRun && rendererCanReceive()) win?.webContents.send('agent:backgroundWork', { runId, work: ev.backgroundWork })
    // 结构化写入的 tool_result 到达 = 那次写入已经结束（成功或失败都可能已落盘）→ 刷新运行中 Diff
    // 预览。绝不在 tool start 上刷：那时文件通常还没写盘，预览会读到写前状态。
    if (writeCompletions.observe(ev)) notifyDiffChange()
    if (isRemoteRun) options.onTraceEvent?.(ev)
  }
  let performanceRecorded = false
  const persistLlmPerformance = async (failed: boolean, externalSessionId: string): Promise<void> => {
    if (performanceRecorded) return
    performanceRecorded = true
    const performance = [...runState.items].reverse().find(event => event.stage === 'runtime:turn_wall')?.llmPerformance
    const result = [...runState.items].reverse().find(event => event.kind === 'harness' && event.stage === 'result')
    if (!performance) return
    const model = result?.modelUsage?.length === 1 ? result.modelUsage[0].model
      : result?.modelUsage?.length ? '多模型'
        : result?.contextModel ?? (request.model ? `所选：${request.model.id}` : '未知模型')
    try {
      await appendLlmPerformance(appUserData(), { cwd: catalogCwd, externalSessionId }, {
        runId, ts: performance.observedAt, providerId, agentProfileId,
        model,
        upstreamProvider: result?.modelUsage?.length === 1 ? result.modelUsage[0].upstreamProvider : result?.upstreamProvider,
        networkLabel: request.networkLabel ?? '', failed: failed || result?.isError === true,
        performance: { ...performance, networkConfiguration: await networkConfiguration }
      })
    } catch (error) {
      console.warn('[scry] LLM performance history write failed:', error)
    }
  }
  emit({
    id: mainEventId('controls', runId),
    ts: new Date().toISOString(),
    runId,
    kind: 'harness',
    stage: 'runtime:controls',
    input: {
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
      ...(options.permissionModeOverride ? { effectivePermissionMode: options.permissionModeOverride } : {})
    }
  })

  return { initialDiffContextKey, finishTurnWallTiming, turnChangeJournal, runState, persistRunData, cleanupProvisional, ingestion, emit, persistLlmPerformance, attachments, displayPrompt, unavailableCapture, networkConfiguration, setNotifyDiffChange: (value: () => void) => { notifyDiffChange = value }, setCurrentObservedSessionId: (value: () => string | undefined) => { currentObservedSessionId = value } }
}
