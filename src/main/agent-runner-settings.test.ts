import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ query: vi.fn<(input: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>>() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

import { runAgent, type RunOpts } from './agent-runner'

const cases: Array<{ name: string; sources: RunOpts['settingSources'] }> = [
  { name: 'omitted default', sources: undefined },
  { name: 'explicit filesystem isolation', sources: [] },
  { name: 'ordered explicit sources', sources: ['project', 'local'] }
]

describe('Claude SDK filesystem settings forwarding', () => {
  beforeEach(() => {
    sdk.query.mockReset()
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'settings-fixture' }
      }
    })
  })

  it.each(cases)('preserves $name without changing the safe approval default', async ({ sources }) => {
    await expect(runAgent('fixture', 'settings-fixture', () => {}, { settingSources: sources }).promise).resolves.toMatchObject({ status: 'completed' })
    expect(sdk.query).toHaveBeenCalledTimes(1)
    const options = sdk.query.mock.calls[0][0].options
    expect(Object.hasOwn(options, 'settingSources')).toBe(sources !== undefined)
    if (sources !== undefined) expect(options.settingSources).toEqual(sources)
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(options).not.toHaveProperty('extraArgs')
    expect(options).toMatchObject({ strictMcpConfig: true, mcpServers: {} })
  })
})
