import type { ProviderAdapter } from './types'

/** Packaged smoke-only adapter. Enabled only by the explicit test process environment. */
export function createSmokeProviderAdapter(): ProviderAdapter {
  return {
    id: 'codex',
    runtimeProvider: 'codex_cli',
    describe: async () => ({
      id: 'codex',
      label: 'Codex Smoke Fixture',
      runtimeProvider: 'codex_cli',
      transport: 'packaged smoke fixture',
      available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: { state: 'ready', transport: 'packaged smoke fixture' }
    }),
    run: (request) => {
      const sessionId = request.resume ?? `smoke-session-${request.runId}`
      let stopped = false
      const promise = Promise.resolve().then(async () => {
        request.onExternalSessionId?.(sessionId)
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
          text: 'smoke fixture result Authorization: Bearer sk-ant-api03-scry-smoke-not-a-real-key-000000'
        })
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
        return {
          externalSessionId: sessionId,
          providerTurnId: `${request.runId}:provider-turn`,
          stopped,
          status: stopped ? 'interrupted' as const : 'completed' as const
        }
      })
      return {
        promise,
        interrupt: () => { stopped = true },
        forceKill: () => { stopped = true },
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => sessionId,
        getProviderTurnId: () => `${request.runId}:provider-turn`
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
