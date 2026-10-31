import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderAdapter, ProviderRunRequest } from '../../src/main/providers/types'
import { HistoricalInput } from '../../src/main/providers/historical-input'

// Offline, fixed-rate workload. Hook payloads and tool evidence use the same identities.
export function runConcurrentFixture(request: ProviderRunRequest, providerId: 'claude' | 'codex' | 'pi'): ReturnType<ProviderAdapter['run']> {
  assert.equal(providerId, 'claude')
  assert.ok(request.cwd && request.managedRecorder && request.managedRecorderIdentity)
  const cwd = request.cwd
  const identity = request.managedRecorderIdentity
  const sessionId = `concurrent-${request.runId}`
  const turnId = `${request.runId}:provider-turn`
  let stopped = false
  const emit: ProviderRunRequest['emit'] = event => request.emit(event)
  const event = (id: string) => ({ id: `${request.runId}:${id}`, runId: request.runId, ts: new Date().toISOString() })
  const hook = async (name: string, extra: Record<string, unknown> = {}) => {
    const child = spawn('/bin/sh', [join(cwd, '.scry/provider-hook.sh'), providerId, name], {
      cwd,
      env: { ...process.env, SCRY_RECORDER_MANAGED: '1', SCRY_MANAGED_RUN_ID: identity.runId,
        SCRY_MANAGED_PROMPT_HASH: identity.promptHash,
        NODE_OPTIONS: `--require=${JSON.stringify(process.env.SCRY_CONCURRENT_PROBE)}`,
        SCRY_CONCURRENT_ROLE: 'hook' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let error = ''
    child.stderr.on('data', chunk => { error += String(chunk) })
    child.stdout.resume()
    child.stdin.end(JSON.stringify({ session_id: sessionId, turn_id: turnId, prompt: request.prompt,
      timestamp: new Date().toISOString(), ...extra }))
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Hook ${name} exited ${code}: ${error}`)))
    })
  }
  const promise = Promise.resolve().then(async () => {
    const startedAt = Date.now()
    request.onExternalSessionId?.(sessionId)
    const history = new HistoricalInput(request)
    if (request.trackInputReceipt) {
      history.attempting(history.text(request.prompt))
      history.accepted(sessionId, 'claude_sdk_success_result', turnId)
    }
    await hook('UserPromptSubmit')
    // 20 tool calls and 400 deltas/session; a slow hook stretches duration, never drops work.
    for (let step = 0; step < 20 && !stopped; step++) {
      const cycleAt = performance.now()
      const toolUseId = `${request.runId}:write:${step}`
      const filePath = `fixture-${request.runId}-${step}.txt`
      await hook('PreToolUse', { tool_name: 'Write', tool_use_id: toolUseId, tool_input: { file_path: filePath } })
      emit({ ...event(`tool-start:${step}`), kind: 'tool', stage: 'tool_start', tool: 'Write', toolUseId,
        fileOp: 'write', filePath, input: { file_path: filePath } })
      const content = `${request.runId} step ${step}\n${'fixed file payload\n'.repeat(128)}`
      await writeFile(join(cwd, filePath), content)
      await hook('PostToolUse', { tool_name: 'Write', tool_use_id: toolUseId, tool_response: content })
      emit({ ...event(`tool-result:${step}`), kind: 'tool', stage: 'tool_result', tool: 'Write', toolUseId,
        fileOp: 'write', filePath, text: content })
      for (let delta = 0; delta < 20 && !stopped; delta++) {
        emit({ ...event(`text:${step}:${delta}`), kind: 'model', stage: 'text_delta',
          messageId: `${request.runId}:message:${step}`, text: `Step ${step}, delta ${delta}. ${'stream content '.repeat(16)}\n` })
        const remaining = cycleAt + (delta + 1) * 50 - performance.now()
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      }
    }
    await hook('Stop')
    emit({ ...event('final'), kind: 'model', stage: 'text', messageId: `${request.runId}:final`, text: 'CONCURRENT_FIXTURE_COMPLETE' })
    emit({ ...event('result'), kind: 'harness', stage: 'result', text: 'concurrent fixture completed', durationMs: Date.now() - startedAt })
    return { externalSessionId: sessionId, providerTurnId: turnId, stopped, status: stopped ? 'interrupted' as const : 'completed' as const }
  })
  return { promise, interrupt: () => { stopped = true }, forceKill: () => { stopped = true },
    forceKillScope: 'run_scoped', getExternalSessionId: () => sessionId, getProviderTurnId: () => turnId }
}
