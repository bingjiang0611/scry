import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ProviderAdapter } from './types'
import type { AgentSteerInput } from '../../shared/runtime'
import { HistoricalInput } from './historical-input'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'

/** Packaged smoke-only adapter. Enabled only by the explicit test process environment. */
export function createSmokeProviderAdapter(providerId: 'claude' | 'codex' = 'codex'): ProviderAdapter {
  // Test-only entry receipts prove that a rejected production IPC never reached the
  // privileged adapter. This adapter itself requires the existing explicit smoke gate.
  const callsFile = process.env.SCRY_ELECTRON_SMOKE_CALLS
  const recordCall = (operation: string, identity: string): void => {
    if (callsFile) appendFileSync(callsFile, `${JSON.stringify({ operation, identity })}\n`)
  }
  const forkSession: ProviderAdapter['forkSession'] = callsFile ? {
    fork: async (request) => {
      recordCall('fork', request.sourceSessionId)
      return { externalSessionId: `smoke-fork-${request.sourceRunId}` }
    }
  } : undefined
  return {
    forkSession,
    id: providerId,
    runtimeProvider: providerId === 'claude' ? 'claude_sdk' : 'codex_cli',
    historicalContext: true,
    continuationKey: () => `${providerId}:smoke:${process.env.SCRY_ELECTRON_SMOKE_IDENTITY?.trim() || 'default'}`,
    describe: async () => ({
      id: providerId,
      label: `${providerId} Smoke Fixture`,
      runtimeProvider: providerId === 'claude' ? 'claude_sdk' : 'codex_cli',
      transport: 'packaged smoke fixture',
      available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: { state: 'ready', transport: 'packaged smoke fixture' }
    }),
    run: (request) => {
      recordCall('run', request.runId)
      const history = new HistoricalInput(request)
      const outgoingPrompt = history.text(request.prompt)
      const sessionId = request.resume ?? `smoke-session-${request.runId}`
      const inputsFile = process.env.SCRY_ELECTRON_SMOKE_INPUTS
      if (inputsFile) appendFileSync(inputsFile, `${JSON.stringify({ providerId, runId: request.runId, prompt: request.prompt,
        resume: request.resume ?? null, sessionId, historicalContext: request.historicalContext ?? null, outgoingPrompt })}\n`)
      let stopped = false
      const questionAbort = new AbortController()
      const promise = Promise.resolve().then(async () => {
        const startedAt = Date.now()
        request.onExternalSessionId?.(sessionId)
        if (inputsFile) request.emit({ id: `${request.runId}:steer-capability`, runId: request.runId, ts: new Date().toISOString(),
          kind: 'harness', stage: 'runtime:steer_capability', steerCapability: { status: 'available', attachments: false } })
        if (request.trackInputReceipt) {
          history.attempting(outgoingPrompt)
          if (providerId === 'codex' && request.prompt !== 'conversation unknown input') history.accepted(sessionId, 'codex_turn_start_response', `${request.runId}:provider-turn`)
        }
        if (request.managedRecorder && request.cwd) {
          await handleRecorderHook({ provider: providerId, event: 'UserPromptSubmit', workspace: request.cwd, managed: true,
            payload: { session_id: sessionId, turn_id: `${request.runId}:provider-turn`, prompt: request.prompt, timestamp: new Date().toISOString() } })
        }
        if (request.prompt === 'dock badge question smoke' || request.prompt === 'remote provider failure smoke') {
          request.emit({ id: `${request.runId}:assistant`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'model', stage: 'text', text: 'isolated fixture started' })
        }
        if (request.prompt === 'remote provider failure smoke') {
          request.emit({ id: `${request.runId}:result`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'harness', stage: 'result', text: 'fixture_provider_failure', isError: true, durationMs: Date.now() - startedAt })
          throw new Error('fixture_provider_failure')
        }
        if (request.prompt === 'llm performance smoke') {
          request.emit({ id: `${request.runId}:performance-text`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'model', stage: 'text_delta', text: 'main observer performance fixture' })
          if (!request.requestUserInput) throw new Error('Performance smoke requires requestUserInput')
          await request.requestUserInput({ runId: request.runId, questionId: `${request.runId}:performance`, providerId,
            questions: [{ header: 'Performance fixture', question: 'Keep this isolated run open?', options: [], multiSelect: false }]
          }, questionAbort.signal)
        }
        if (request.prompt === 'dock badge question smoke') {
          if (!request.requestUserInput) throw new Error('Question smoke requires requestUserInput')
          for (const step of [1, 2]) {
            if (stopped) break
            await request.requestUserInput({
              runId: request.runId,
              questionId: `${request.runId}:question:${step}`,
              providerId,
              questions: [{
                header: 'Dock badge',
                question: 'Continue the isolated badge smoke?',
                options: [{ label: 'Continue', description: 'Finish the fixture run' }],
                multiSelect: false
              }]
            }, questionAbort.signal)
          }
        }
        if (stopped) {
          request.emit({ id: `${request.runId}:result`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'harness', stage: 'result', text: 'fixture interrupted', durationMs: Date.now() - startedAt })
          return { externalSessionId: sessionId, providerTurnId: `${request.runId}:provider-turn`, stopped, status: 'interrupted' as const }
        }
        if (['desktop remote write one', 'desktop remote write two', 'desktop remote write three'].includes(request.prompt)) {
          if (!request.cwd) throw new Error('remote write fixture requires a workspace')
          const path = request.prompt.endsWith('one') ? 'remote-first.txt' : request.prompt.endsWith('two') ? 'remote-second.txt' : 'remote-third.txt'
          await writeFile(join(request.cwd, path), `${path}\n`)
          request.emit({ id: `${request.runId}:write`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'tool', stage: 'tool_result', tool: 'Write', toolUseId: `${request.runId}:write`,
            fileOp: 'write', filePath: path, text: `wrote ${path}` })
        }
        request.emit({
          id: `${request.runId}:tool`,
          runId: request.runId,
          ts: new Date().toISOString(),
          kind: 'tool',
          stage: 'tool_use',
          tool: 'Read',
          toolUseId: `${request.runId}:tool`,
          input: { file_path: 'README.md', token: 'sk-ant-api03-scry-smoke-not-a-real-key-000000' },
          fileOp: 'read',
          filePath: 'README.md'
        })
        request.emit({
          id: `${request.runId}:tool-result`,
          runId: request.runId,
          ts: new Date().toISOString(),
          kind: 'tool',
          stage: 'tool_result',
          tool: 'Read',
          toolUseId: `${request.runId}:tool`,
          text: 'smoke fixture result Authorization: Bearer sk-ant-api03-scry-smoke-not-a-real-key-000000' +
            (request.prompt === 'packaged fake-provider smoke' ? `\n${'x'.repeat(12 * 1024 * 1024)}\nCOMPLETE_LARGE_TOOL_TAIL` : '')
        })
        if (request.prompt === 'file links smoke') {
          if (!request.cwd) throw new Error('file-link fixture requires a workspace')
          const absolute = pathToFileURL(join(dirname(request.cwd), 'rotom-team/docs/NATIVE-DELIVERY.md')).href
          request.emit({
            id: `${request.runId}:files`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'model', stage: 'text_delta', messageId: `${request.runId}:message`,
            text: `验收总表：\`rotom-team/docs/NATIVE-DELIVERY.md\`\n\n[absolute](${absolute}) [license](../LICENSE) [binary](../asset.custom) [outside](escaped.md) \`missing.md\`\n\n[interactive-mode.ts:1252](packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1252)\n\n\`packages/coding-agent/src/modes/interactive/interactive-mode.ts:1252:3\`\n\n截图留在 \`${join(request.cwd, 'screens')}/\`（\`remote-workspace.png\`、\`remote-hosts.png\`、\`remote-settings.png\`、\`asset.custom\`、\`fail.custom\`）。`
          })
        }
        if (request.prompt === 'performance long stream') {
          // Packaged soak-only pressure path: exercise batching, renderer ACK and the large-stream
          // lightweight Markdown transition without any external Provider or user content.
          for (let index = 0; index < 80; index++) {
            if (stopped) break
            request.emit({
              id: `${request.runId}:delta:${index}`,
              runId: request.runId,
              ts: new Date().toISOString(),
              kind: 'model',
              stage: 'text_delta',
              messageId: `${request.runId}:message`,
              text: `${index % 8 === 0 ? `\n\n## Section ${index}\n\n` : ''}${'stream '.repeat(160)}`
            })
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        }
        if (request.prompt.startsWith('desktop remote ')) {
          // Canonical recorder fixtures need actual assistant evidence, not the
          // harness result summary masquerading as a model message.
          request.emit({ id: `${request.runId}:assistant`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'model', stage: 'text', text: 'isolated remote assistant evidence' })
        }
        request.emit({
          id: `${request.runId}:result`,
          runId: request.runId,
          ts: new Date().toISOString(),
          kind: 'harness',
          stage: 'result',
          text: 'smoke fixture completed',
          tokensIn: 12,
          tokensOut: 4,
          durationMs: 5
        })
        if (request.trackInputReceipt && providerId === 'claude' && !stopped) history.accepted(sessionId, 'claude_sdk_success_result', `${request.runId}:provider-turn`)
        return {
          externalSessionId: sessionId,
          providerTurnId: `${request.runId}:provider-turn`,
          stopped,
          status: stopped ? 'interrupted' as const : 'completed' as const
        }
      })
      return {
        promise,
        interrupt: () => {
          stopped = true
          questionAbort.abort()
        },
        forceKill: () => {
          stopped = true
          questionAbort.abort()
        },
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => sessionId,
        getProviderTurnId: () => `${request.runId}:provider-turn`,
        getInputReceipt: () => history.snapshot(),
        ...(inputsFile ? { steer: async (input: AgentSteerInput) => {
          appendFileSync(inputsFile, `${JSON.stringify({ operation: 'steer', providerId, runId: request.runId, prompt: input.prompt })}\n`)
          return { status: 'accepted' as const }
        } } : {})
      }
    },
    hookTrust: {
      inspect: async (context) => ({ cwd: context.cwd ?? '', hooks: [], warnings: [], errors: [] })
    },
    runControls: {
      read: async (context) => ({
        ...context,
        mode: 'read',
        state: 'ready',
        data: { models: [], permissions: [{ id: 'default', label: '默认审批', description: 'smoke fixture' }] },
        observedAt: Date.now()
      })
    }
  }
}
