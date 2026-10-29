import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentStartRequest } from '../../src/shared/runtime'
import type { AppRunStartOptions } from '../../src/main/app-run-start'
import { createAppWorkflowRuntime } from '../../src/main/workflow-app-runtime'
import { ProviderRegistry } from '../../src/main/providers/registry'
import { createSmokeProviderAdapter } from '../../src/main/providers/smoke'

const [root, mode] = process.argv.slice(2)
if (!root || !['crash', 'recover'].includes(mode ?? '')) throw new Error('usage: fixture <root> <crash|recover>')
process.env.SCRY_ELECTRON_SMOKE_WORKFLOW = '1'

const adapter = { ...createSmokeProviderAdapter('codex'), workflowAuthoring: {
  source: 'claude_sdk_success_result' as const,
  hostTools: 'disabled' as const
} }
let executionDispatches = 0
const startAppRun = async (_request: AgentStartRequest, options?: AppRunStartOptions) => {
  if (!options?.runId || !options.onTerminal) throw new Error('Missing workflow callbacks')
  options.onProviderDispatchAttempt?.()
  const base = { runId: options.runId, ts: new Date().toISOString() }
  if (options.purpose === 'workflow_authoring') {
    const output = JSON.stringify({ schemaVersion: 1, roles: [], body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'work', role: 'worker', prompt: 'work' },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'work' } }
    ] } })
    await options.onTerminal({ runId: options.runId, status: 'completed', settled: true,
      items: [{ ...base, id: 'authoring-result', kind: 'harness', stage: 'result' }], archiveRef: 'archive:' + options.runId,
      structuredOutput: { source: 'claude_sdk_success_result', json: output } })
  } else {
    executionDispatches += 1
    await options.onTerminal({ runId: options.runId, status: 'completed', settled: true, archiveRef: 'archive:' + options.runId,
      items: [
        { ...base, id: 'answer', kind: 'model', stage: 'text', text: 'recovered work' },
        { ...base, id: 'execution-result', kind: 'harness', stage: 'result', modelUsage: [{ model: 'workflow-fixture', inputTokens: 1, outputTokens: 1 }] }
      ] })
  }
  return { runId: options.runId }
}
const runtime = createAppWorkflowRuntime({
  userData: root,
  providerRegistry: new ProviderRegistry([adapter]),
  providerContextKey: (provider, cwd, profile) => JSON.stringify([provider, cwd, profile]),
  withProviderOperation: async (_provider, operation) => await operation(),
  startAppRun,
  requestRunStop: () => true,
  requestRunStopAgain: () => true,
  resolveTemplateProjectDirectory: cwd => cwd,
  onProgress: () => {},
  ...(mode === 'crash' ? { onRunSettlementPersisted: async settlement => {
    process.send?.({ type: 'settlement_persisted', settlement })
    await new Promise<void>(resolve => process.once('message', message => { if (message === 'release') resolve() }))
  } } : {})
})

const binding = { providerId: 'codex' as const, requestedModel: { id: 'workflow-fixture' }, permissionMode: 'default' as const }
if (mode === 'crash') {
  const preview = await runtime.workflowService.planCommand({ command: '/scry-workflow run settlement crash recovery', commandId: 'settlement-plan', workspace: root,
    orchestrator: { ...binding, role: 'orchestrator' }, roles: [{ ...binding, role: 'worker' }] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await runtime.workflowService.approve(approval)
  await writeFile(join(root, 'settlement-case.json'), JSON.stringify({ preview, approval }) + '\n')
  await runtime.workflowService.start(preview.workflowId, approval, 'settlement-start')
} else {
  const { preview, approval } = JSON.parse(await readFile(join(root, 'settlement-case.json'), 'utf8')) as {
    preview: { workflowId: string; programRevision: string }
    approval: { workflowId: string; programRevision: string; approvedAt: number }
  }
  const before = await runtime.workflowService.snapshot(preview.workflowId)
  if (!before || typeof before.revision !== 'number') throw new Error('Missing recovered workflow')
  const oldAttempt = before.attempts[0]
  if (!oldAttempt) throw new Error('Missing recovered attempt')
  const after = await runtime.workflowService.restartStalled(preview.workflowId, approval, {
    taskId: oldAttempt.taskId,
    attemptId: oldAttempt.attemptId,
    expectedRevision: before.revision
  }, 'settlement-restart')
  await writeFile(join(root, 'settlement-result.json'), JSON.stringify({ before, after, executionDispatches }, null, 2) + '\n')
}
