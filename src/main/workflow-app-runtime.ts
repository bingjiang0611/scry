import { join } from 'node:path'
import type { AgentStartRequest } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { TraceEvent } from '../shared/trace'
import type { WorkflowProgress, WorkflowRoleBinding } from '../shared/workflow'
import { workflowSystemCopy } from '../shared/constants/copy'
import { workflowAuthoringCopy } from '../shared/constants/workflow-authoring-copy'
import { flattenTraceItems } from './remote/trace-output'
import type { AppRunStartOptions, WorkflowTerminalResult } from './app-run-start'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowSystemHost, type WorkflowReplicaRun } from './workflow-system-host'
import { WorkflowService } from './workflow-service'
import type { WorkflowPlanProvider } from './workflow-service-contracts'
import { workflowPlanningPrompt } from './workflow-program'
import { workflowRoutingPrompt } from '../shared/workflow-route'
import { workflowBindingControls } from './workflow-capability'
import { WorkflowTemplateStore } from './workflow-template-store'
import { WorkflowSlots, WorkflowScopeError, WorkflowDispatch } from './workflow-runner'
import type { ProviderRegistry } from './providers/registry'
import type { WorkflowClassifierAdapter } from '../shared/workflow-classifier'

export interface AppWorkflowRuntimeDependencies {
  userData: string
  providerRegistry: Pick<ProviderRegistry, 'get' | 'isDisabled' | 'isRegistered' | 'runControls'>
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
  startAppRun: (payload: AgentStartRequest, options?: AppRunStartOptions) => Promise<{ runId: string } | RemoteRunCompletion>
  requestRunStop: (runId: string) => boolean
  requestRunStopAgain: (runId: string) => boolean
  resolveTemplateProjectDirectory: (cwd: string) => string | Promise<string>
  onProgress: (progress: WorkflowProgress) => void
  /** Main-owned classifier bridge. Omitted in production until a reviewed adapter exists. */
  classifierAdapter?: WorkflowClassifierAdapter
}

export function createAppWorkflowRuntime(deps: AppWorkflowRuntimeDependencies) {
  function workflowOutput(items: TraceEvent[]): { output?: string; actualModel?: string } {
    const output = flattenTraceItems(items).filter((chunk) => chunk.kind === 'output').map((chunk) => chunk.text).join('')
    const result = [...items].reverse().find((item) => item.kind === 'harness' && item.stage === 'result')
    const actualModel = result?.modelUsage?.length === 1 ? result.modelUsage[0].model : undefined
    return { ...(output ? { output } : {}), ...(actualModel ? { actualModel } : {}) }
  }

  function workflowStartRequest(role: WorkflowRoleBinding, prompt: string, cwd: string): AgentStartRequest {
    return {
      prompt,
      cwd,
      providerId: role.providerId,
      agentId: role.providerId,
      ...(role.agentProfileId ? { agentProfileId: role.agentProfileId } : {}),
      ...(role.requestedModel ? { model: role.requestedModel } : {}),
      ...(role.permissionMode ? { permissionMode: role.permissionMode } : {}),
      expectedExternalSessionId: null
    }
  }

  const workflowCatalogReads = new Map<string, Promise<{
    controls: Awaited<ReturnType<ProviderRegistry['runControls']>>
    descriptor: Awaited<ReturnType<ProviderRegistry['describe']>>[number]
  }>>()
  async function workflowRunControls(role: WorkflowRoleBinding, workspace: string, replica?: WorkflowReplicaRun) {
    const adapter = deps.providerRegistry.get(role.providerId)
    const context = { providerId: role.providerId, cwd: workspace, agentProfileId: role.agentProfileId }
    const key = deps.providerContextKey(role.providerId, workspace, role.agentProfileId)
    let pending = workflowCatalogReads.get(key)
    if (!pending) {
      pending = deps.withProviderOperation(role.providerId, async () => {
        const controls = await deps.providerRegistry.runControls(context)
        // A cold catalog read can establish transport health (notably Codex).
        // Freeze health only afterwards, in the same deduplicated operation.
        return { controls, descriptor: await adapter.describe() }
      }, role.agentProfileId).finally(() => { workflowCatalogReads.delete(key) })
      workflowCatalogReads.set(key, pending)
    }
    const { controls, descriptor: entry } = await pending
    // Read actual copy-local capabilities. Only a live main grant can relocate
    // their identity back to the approved source; all other fingerprint fields
    // must still match. Native config/executable trust below remains copy-local.
    const grant = replica ? await workflowSystems.assertRun(replica, workspace) : undefined
    if (grant && await deps.resolveTemplateProjectDirectory(grant.sourceWorkspace) !== grant.sourceWorkspace) throw new Error(workflowSystemCopy.authority)
    const identityContext = grant ? { ...context, cwd: grant.sourceWorkspace } : context
    return workflowBindingControls(role, identityContext, entry, controls, adapter.workflowExecution, !deps.providerRegistry.isDisabled(role.providerId), adapter.workflowAuthoring)
  }

  const workflowStore = new FileWorkflowStore(deps.userData)
  const workflowTemplates = new WorkflowTemplateStore(deps.userData, deps.resolveTemplateProjectDirectory)
  const workflowSlots = new WorkflowSlots()
  const workflowSystems = new WorkflowSystemHost(join(deps.userData, 'workflow-replicas'), workflowStore)
  type AuthoringResult = Awaited<ReturnType<WorkflowPlanProvider>>
  const runAuthoring = async (input: {
    runId: string
    role: WorkflowRoleBinding
    prompt: string
    workspace: string
    signal?: AbortSignal
    beforeProviderDispatch?: () => Promise<void>
    expectedContinuationKey?: string
    authoringSchema?: Readonly<Record<string, unknown>>
  }): Promise<AuthoringResult> => {
    const dispatch = new WorkflowDispatch()
    let resolve!: (result: AuthoringResult) => void
    let reject!: (error: unknown) => void
    const completion = new Promise<AuthoringResult>((res, rej) => { resolve = res; reject = rej })
    try {
      const authoring = deps.providerRegistry.get(input.role.providerId).workflowAuthoring
      if (!authoring) throw new Error(workflowAuthoringCopy.unavailable)
      await deps.startAppRun(workflowStartRequest(input.role, input.prompt, input.workspace), {
        origin: 'workflow', purpose: 'workflow_authoring', runId: input.runId, stopSignal: input.signal,
        expectedWorkflowCapability: input.role.runtimeIdentity,
        ...(input.authoringSchema ? { authoringSchema: input.authoringSchema } : {}),
        ...(input.beforeProviderDispatch ? { beforeWorkflowAuthoringDispatch: input.beforeProviderDispatch } : {}),
        ...(input.expectedContinuationKey ? { expectedWorkflowContinuationKey: input.expectedContinuationKey } : {}),
        onProviderDispatchAttempt: dispatch.onProviderDispatchAttempt,
        onTerminal: (terminal: WorkflowTerminalResult) => {
          const result = [...terminal.items].reverse().find(item => item.kind === 'harness' && item.stage === 'result')
          const candidate = terminal.structuredOutput
          if (terminal.status === 'completed' && terminal.archiveRef && candidate?.source === authoring.source && result) {
            const actualModel = result.modelUsage?.length === 1 ? result.modelUsage[0].model : undefined
            resolve({ output: candidate.json, outputSource: candidate.source, actualModel, archiveRef: terminal.archiveRef })
          } else reject(new WorkflowScopeError(terminal.status === 'completed'
            ? workflowAuthoringCopy.missingCandidate : workflowAuthoringCopy.providerIncomplete(terminal.status), terminal.settled))
        }
      })
    } catch (error) { reject(dispatch.rejected(error)) }
    return completion
  }

  const workflowService = new WorkflowService({
    store: workflowStore,
    templates: workflowTemplates,
    systems: workflowSystems,
    slots: workflowSlots,
    loadConcurrency: () => workflowStore.readConcurrency(),
    providerRegistered: (providerId) => deps.providerRegistry.isRegistered(providerId) && !deps.providerRegistry.isDisabled(providerId),
    runControls: workflowRunControls,
    plan: ({ workflowId, role, roles, goal, workspace, sizeGuideline, signal, beforeProviderDispatch, expectedContinuationKey, route, routingMode }) => runAuthoring({
      runId: `workflow-plan-${workflowId}`, role, workspace, signal, beforeProviderDispatch, expectedContinuationKey,
      prompt: route
        ? workflowRoutingPrompt(JSON.stringify(roles.map(binding => binding.role)), goal, workflowPlanningPrompt(roles, goal, sizeGuideline.value), routingMode)
        : workflowPlanningPrompt(roles, goal, sizeGuideline.value)
    }),
    execute: ({ attemptId, role, prompt, workspace, replicaRun, onObservation }) => {
      const runId = `workflow-${attemptId}`
      const dispatch = new WorkflowDispatch()
      let startedRunId: string | undefined
      let stopRequested = false
      const stopController = new AbortController()
      let resolve: ((result: import('./workflow-runner').WorkflowProviderExecutionResult) => void) | undefined
      let reject: ((error: unknown) => void) | undefined
      const result = new Promise<import('./workflow-runner').WorkflowProviderExecutionResult>((res, rej) => { resolve = res; reject = rej })
      void deps.startAppRun(workflowStartRequest(role, prompt, workspace), {
        origin: 'workflow', runId, stopSignal: stopController.signal, expectedWorkflowCapability: role.runtimeIdentity,
        workflowReplica: replicaRun,
        onWorkflowObservation: onObservation,
        onProviderDispatchAttempt: dispatch.onProviderDispatchAttempt,
        onTerminal: (terminal: WorkflowTerminalResult) => {
          const observed = workflowOutput(terminal.items)
          const hasTerminalEvidence = terminal.items.some((item) => item.kind === 'harness' && item.stage === 'result')
          resolve?.({ runId, status: terminal.status === 'blocked' ? 'blocked' : terminal.status === 'completed' && hasTerminalEvidence ? 'completed' : terminal.status === 'interrupted' ? 'stopped' : terminal.status === 'failed' ? 'failed' : 'unknown',
            ...observed, ...(terminal.status === 'blocked' ? { error: 'unsupported_interaction' } : {}),
            ...(terminal.archiveRef ? { archiveRef: terminal.archiveRef } : {}), settled: terminal.settled })
        }
      }).then((started) => {
        if ('runId' in started) {
          startedRunId = started.runId
          if (stopRequested) deps.requestRunStop(started.runId)
        }
      }).catch((error) => reject?.(dispatch.rejected(error)))
      return { runId, result, stop: () => {
        if (!stopRequested) {
          stopRequested = true
          stopController.abort()
          return true
        }
        return startedRunId ? deps.requestRunStopAgain(startedRunId) : true
      } }
    },
    onProgress: deps.onProgress,
    classifierAdapter: deps.classifierAdapter
  })

  return { workflowService, workflowStore, workflowTemplates, workflowSystems, workflowRunControls, runAuthoring }
}
