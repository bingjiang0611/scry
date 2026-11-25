import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { ProviderAdapter } from './types'
import { runtimeProviderForProviderId, type AgentSteerInput } from '../../shared/runtime'
import { HistoricalInput } from './historical-input'
import { smokeHistoryReaderFacet, smokeReaderRead } from './smoke-history-reader'
import { emitLargeTrace, emitLongStream, emitPacedStream, isLargeTracePrompt, isLongStreamPrompt, isPacedStreamPrompt } from './smoke-paced-stream'
import { runSmokePostToolScenarios, runSmokePromptScenarios } from './smoke-scenarios'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'

export type SmokeFixtureProviderId = 'claude' | 'codex' | 'qoder' | 'opencode' | 'pi'

/** Packaged smoke-only adapter. Enabled only by the explicit test process environment. */
export function createSmokeProviderAdapter(providerId: SmokeFixtureProviderId = 'codex'): ProviderAdapter {
  // Test-only entry receipts prove that a rejected production IPC never reached the
  // privileged adapter. This adapter itself requires the existing explicit smoke gate.
  const callsFile = process.env.SCRY_ELECTRON_SMOKE_CALLS
  const recordCall = (operation: string, identity: string): void => {
    if (callsFile) appendFileSync(callsFile, `${JSON.stringify({ operation, identity })}\n`)
  }
  const forkSession: ProviderAdapter['forkSession'] = callsFile ? {
    fork: async (request) => {
      await request.beforeFork?.()
      recordCall('fork', request.sourceSessionId)
      return { externalSessionId: `smoke-fork-${request.sourceRunId}` }
    }
  } : undefined
  return {
    forkSession,
    ...smokeHistoryReaderFacet,
    id: providerId,
    runtimeProvider: runtimeProviderForProviderId(providerId),
    historicalContext: true,
    continuationKey: context => `${providerId}:${context.agentProfileId ?? 'default'}:smoke:${process.env.SCRY_ELECTRON_SMOKE_IDENTITY?.trim() || 'default'}`,
    describe: async () => ({
      id: providerId,
      label: `${providerId} Smoke Fixture`,
      runtimeProvider: runtimeProviderForProviderId(providerId),
      transport: 'packaged smoke fixture',
      available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: { state: 'ready', transport: 'packaged smoke fixture' }
    }),
    run: (request) => {
      recordCall('run', request.runId)
      const history = new HistoricalInput(request)
      const outgoingPrompt = history.text(request.prompt)
      const readerRead = smokeReaderRead(request)
      const sessionId = request.resume ?? `smoke-session-${request.runId}`
      const inputsFile = process.env.SCRY_ELECTRON_SMOKE_INPUTS
      if (inputsFile) appendFileSync(inputsFile, `${JSON.stringify({ providerId, agentProfileId: request.agentProfileId, cwd: request.cwd, runId: request.runId, prompt: request.prompt,
        resume: request.resume ?? null, sessionId, historicalContext: request.historicalContext ?? null, outgoingPrompt,
        ...(request.attachments.length ? { attachments: request.attachments.map(attachment => ({ kind: attachment.kind, name: attachment.name,
          path: attachment.path, mimeType: attachment.mimeType, contentHash: createHash('sha256').update(Buffer.from(attachment.dataBase64, 'base64')).digest('hex') })) } : {}) })}\n`)
      let stopped = false
      const composerProbe = request.prompt.startsWith('native composer ')
      const deferredNativeTurn = request.prompt.startsWith('native composer stop-immediate ')
      const questionAbort = new AbortController()
      const promise = Promise.resolve().then(async () => {
        const startedAt = Date.now()
        // The retrieval runs before the provider claims acceptance of the input.
        await readerRead
        if (!deferredNativeTurn) request.onExternalSessionId?.(sessionId)
        if (inputsFile) request.emit({ id: `${request.runId}:steer-capability`, runId: request.runId, ts: new Date().toISOString(),
          kind: 'harness', stage: 'runtime:steer_capability', steerCapability: { status: 'available', attachments: false } })
        if (request.trackInputReceipt) {
          history.attempting(outgoingPrompt)
          // Model acceptance with provider-specific receipt kinds. These receipts
          // come from the fixture, not from a native Provider run.
          if (providerId === 'codex' && request.prompt !== 'conversation unknown input') history.accepted(sessionId, 'codex_turn_start_response', `${request.runId}:provider-turn`)
          if (providerId === 'pi') history.accepted(sessionId, 'pi_persisted_session_entry', `${request.runId}:provider-turn`)
          if (providerId === 'qoder') history.accepted(sessionId, 'qoder_transcript_user_uuid', `${request.runId}:provider-turn`)
          if (providerId === 'opencode') history.accepted(sessionId, 'opencode_prompt_user_message', `${request.runId}:provider-turn`)
        }
        if (request.managedRecorder && request.cwd) {
          await handleRecorderHook({ provider: providerId, event: 'UserPromptSubmit', workspace: request.cwd, managed: true,
            payload: { session_id: sessionId, turn_id: deferredNativeTurn ? undefined : `${request.runId}:provider-turn`, prompt: request.prompt, timestamp: new Date().toISOString() } })
        }
        await runSmokePromptScenarios({
          providerId,
          request,
          startedAt,
          isStopped: () => stopped,
          questionSignal: questionAbort.signal,
          composerProbe,
          deferredNativeTurn
        })
        if (stopped) {
          request.emit({ id: `${request.runId}:result`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'harness', stage: 'result', text: 'fixture interrupted', durationMs: Date.now() - startedAt })
          return { externalSessionId: sessionId, providerTurnId: deferredNativeTurn ? undefined : `${request.runId}:provider-turn`, stopped, status: 'interrupted' as const }
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
        await runSmokePostToolScenarios({
          providerId,
          request,
          isStopped: () => stopped,
          questionSignal: questionAbort.signal
        })
        if (isPacedStreamPrompt(request.prompt)) {
          await emitPacedStream({ runId: request.runId, emit: request.emit, stopped: () => stopped })
        }
        if (isLongStreamPrompt(request.prompt)) {
          await emitLongStream({ runId: request.runId, emit: request.emit, stopped: () => stopped })
        }
        if (isLargeTracePrompt(request.prompt)) await emitLargeTrace({ runId: request.runId, emit: request.emit, held: questionAbort.signal })
        if (request.prompt.startsWith('desktop remote ')) {
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
        getProviderTurnId: () => deferredNativeTurn ? undefined : `${request.runId}:provider-turn`,
        getInputReceipt: () => history.snapshot(),
        ...(inputsFile ? { steer: async (input: AgentSteerInput) => {
          appendFileSync(inputsFile, `${JSON.stringify({ operation: 'steer', providerId, runId: request.runId, prompt: input.prompt })}\n`)
          if (input.prompt === 'steer-unknown') return { status: 'unknown' as const, message: 'Synthetic lost receipt' }
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
        data: { models: [], permissions: providerId === 'pi'
          ? [{ id: 'full_access', label: '本机完全访问', description: 'synthetic Pi fixture; no sandbox' }]
          : [{ id: 'default', label: '默认审批', description: 'smoke fixture' }] },
        observedAt: Date.now()
      })
    }
  }
}
