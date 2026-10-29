import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { qodercliAuth, query, type Query, type SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { workflowAuthoringCopy } from '../../shared/constants/workflow-authoring-copy'
import { resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import { captureProcessIdentity, signalProcessTreeWithIdentity, type ProcessIdentity } from '../process-diagnostics'
import { resolveQoderSdkExecutable } from './qoder'
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from './types'

type Dependencies = Readonly<{ query?: typeof query }>

function textResult(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : undefined
  } catch {
    return undefined
  }
}

function assertRequest(request: ProviderRunRequest): void {
  if (request.purpose !== 'workflow_authoring' || request.resume || request.historicalContext ||
    request.attachments.length || (request.permissionMode && request.permissionMode !== 'default')) {
    throw new Error(workflowAuthoringCopy.invalidRunContext)
  }
}

function authoringRun(request: ProviderRunRequest, runQuery: typeof query): ReturnType<ProviderAdapter['run']> {
  assertRequest(request)
  const controller = new AbortController()
  let stopped = false
  let q: Query | undefined
  let processIdentity: ProcessIdentity | undefined
  let externalSessionId: string | undefined
  const promise: Promise<ProviderRunResult> = (async () => {
    const executable = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
    if (!executable) throw new Error(workflowAuthoringCopy.qoderCliMissing)
    q = runQuery({
      prompt: request.prompt,
      options: {
        auth: qodercliAuth(),
        cwd: request.cwd,
        abortController: controller,
        pathToQoderCLIExecutable: resolveQoderSdkExecutable(executable),
        env: { ...runtimeCliEnv(undefined, { providerId: 'qoder' }), QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0' },
        permissionMode: 'default',
        model: request.model?.id,
        tools: [],
        canUseTool: async () => ({ behavior: 'deny' as const, message: workflowAuthoringCopy.hostToolsDisabled, interrupt: true }),
        skills: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
        includePartialMessages: false,
        includeHookEvents: false,
        spawnQoderCLIProcess: (options: {
          command: string
          args: string[]
          cwd?: string
          env: Record<string, string | undefined>
          signal: AbortSignal
        }) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env as NodeJS.ProcessEnv,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
          })
          processIdentity = captureProcessIdentity(child.pid)
          options.signal.addEventListener('abort', () => { if (processIdentity) signalProcessTreeWithIdentity({ identity: processIdentity, signal: 'SIGTERM' }) }, { once: true })
          return child
        }
      } as never
    })
    let resultText: string | undefined
    let succeeded = false
    for await (const message of q as AsyncIterable<SDKMessage>) {
      request.recordNative?.(`qoder:${message.type}`, message)
      if ('session_id' in message && message.session_id) {
        externalSessionId = message.session_id
        request.onExternalSessionId?.(message.session_id)
      }
      if (message.type === 'result') {
        succeeded = message.subtype === 'success' && !message.is_error
        if (message.subtype === 'success' && !message.is_error) resultText = message.result
      }
    }
    const structured = resultText ? textResult(resultText) : undefined
    if (resultText) request.emit({ id: randomUUID(), runId: request.runId, ts: new Date().toISOString(), kind: 'model', stage: 'text', text: resultText })
    request.emit({ id: randomUUID(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness', stage: 'result',
      text: stopped ? workflowAuthoringCopy.qoderInterrupted : succeeded ? workflowAuthoringCopy.qoderCompleted : workflowAuthoringCopy.qoderFailed,
      isError: !stopped && !succeeded })
    return {
      externalSessionId,
      stopped,
      status: stopped ? 'interrupted' : succeeded ? 'completed' : 'failed',
      ...(structured ? { structuredOutput: { source: 'qoder_cli_success_result' as const, json: structured } } : {})
    }
  })()
  return {
    promise,
    interrupt: () => { stopped = true; controller.abort(); void q?.interrupt().catch(() => {}) },
    forceKill: () => { if (processIdentity) signalProcessTreeWithIdentity({ identity: processIdentity, signal: 'SIGKILL' }) },
    forceKillScope: 'run_scoped',
    getExternalSessionId: () => externalSessionId
  }
}

export function withQoderWorkflowAuthoring(adapter: ProviderAdapter, dependencies: Dependencies = {}): ProviderAdapter {
  const runQuery = dependencies.query ?? query
  return {
    ...adapter,
    workflowAuthoring: {
      source: 'qoder_cli_success_result',
      hostTools: 'disabled',
      permissionBoundary: 'default_only',
      businessQuestions: 'blocked'
    },
    run: request => request.purpose === 'workflow_authoring' ? authoringRun(request, runQuery) : adapter.run(request)
  }
}
