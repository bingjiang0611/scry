import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { TraceEvent } from '../../shared/trace'

// A controllable fake of providerRegistry.run: it never spawns a CLI. The test
// drives emit/promise so we can assert the seam's wiring, progress mapping and
// terminal handling without real Provider cost.
export function fakeRun(script: (req: ProviderRunRequest) => Promise<{ status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' }>) {
  const calls: ProviderRunRequest[] = []
  const run = (_providerId: string, request: ProviderRunRequest): ProviderRunHandle => {
    calls.push(request)
    return {
      promise: script(request).then(r => ({ ...r })),
      interrupt: () => {},
      forceKill: () => {},
      forceKillScope: 'run_scoped',
      getExternalSessionId: () => undefined
    }
  }
  return { run, calls }
}

export const result = (isError: boolean): TraceEvent => ({
  id: 'r', ts: '2020', runId: 'x', kind: 'harness', stage: 'result', isError,
  tokensIn: 11, tokensOut: 22, costUsd: 0.5
})
export const textEvent = (text: string): TraceEvent => ({ id: 't', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text })
export const thinkingEvent = (thinking: string): TraceEvent => ({ id: 'k', ts: '2020', runId: 'x', kind: 'model', stage: 'thinking', thinking })
export const toolUse = (tool: string, filePath?: string): TraceEvent => ({ id: 'u', ts: '2020', runId: 'x', kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: 'tu1', ...(filePath ? { filePath } : {}) })
export const toolResult = (output: string): TraceEvent => ({ id: 'o', ts: '2020', runId: 'x', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', output })
