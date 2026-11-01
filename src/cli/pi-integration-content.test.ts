import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { piIntegrationTestRoots } from './pi-integration-test-fixture'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'
import { readRecorderContent } from '../core/turn-recorder/content-store'

const roots = piIntegrationTestRoots()

describe('Pi recorder extension lifecycle', () => {
  it('对 oversized Pi 证据发送显式 partial capture metadata 且保留 UTF-8 边界', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-bounded-'))
    roots.push(root)
    const cli = join(root, 'scry')
    const entry = join(root, 'scry.mjs')
    await build({ entryPoints: [resolve('src/cli/scry.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    await writeFile(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1, workspaceId: 'pi-cas', capture: { prompt: true, assistant: true, toolOutput: 'full', toolContentFieldBytes: 8_192, toolContentTurnBytes: 1_000_000, diff: false, hooks: true }
    }))

    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-bounded', getLeafId: () => 'pi-bounded-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }

    await emit('before_agent_start', { prompt: 'bounded' })
    await emit('tool_execution_start', { toolCallId: 'large-tool', toolName: 'read', args: { text: '你'.repeat(70_000) } })
    const actualToolResult = { text: 'y'.repeat(132_415) }
    await emit('tool_execution_end', { toolCallId: 'large-tool', toolName: 'read', result: actualToolResult })
    const assistantText = '你'.repeat(100_000)
    const message = { role: 'assistant', id: 'large-response', model: 'gpt-5.6-sol', content: [{ type: 'text', text: assistantText }] }
    await emit('message_start', { message })
    await emit('message_end', { message })
    await emit('agent_settled')

    const [record] = await listRecords(join(root, '.scry'))
    const boundedAssistant = '你'.repeat(Math.floor(256 * 1024 / Buffer.byteLength('你')))
    expect(record.provider).toMatchObject({ model: 'gpt-5.6-sol', modelStatus: 'observed', modelSource: 'provider_model_event' })
    expect(record.assistant.status).toBe('partial')
    expect(record.assistant.value?.text).toBe('你'.repeat(Math.floor(32 * 1024 / Buffer.byteLength('你'))))
    expect(Buffer.byteLength(record.assistant.value?.text ?? '')).toBe(32_766)
    expect(record.assistant.value?.contentRefs).toEqual([expect.objectContaining({
      bytes: 262_143, sha256: createHash('sha256').update(boundedAssistant).digest('hex')
    })])
    await expect(readRecorderContent(join(root, '.scry'), record.assistant.value!.contentRefs![0])).resolves.toBe(boundedAssistant)
    expect(record.tools.value).toHaveLength(1)
    const [tool] = record.tools.value!
    expect(tool.inputContent?.contentRef).toBeDefined()
    expect(tool.outputContent?.contentRef).toBeDefined()
    const expectedToolResult = JSON.stringify(actualToolResult)
    const expectedToolResultHash = createHash('sha256').update(expectedToolResult).digest('hex')
    expect(Buffer.byteLength(expectedToolResult)).toBe(132_426)
    expect(tool.outputContent).toMatchObject({
      contentRef: { bytes: Buffer.byteLength(expectedToolResult), sha256: expectedToolResultHash },
      storage: 'truncated'
    })
    expect(Buffer.byteLength(tool.outputContent!.content!)).toBe(8_192)
    expect(tool.outputContent!.content).toBe(expectedToolResult.slice(0, 8_192))
    await expect(readRecorderContent(join(root, '.scry'), tool.inputContent!.contentRef!)).resolves.toBe(JSON.stringify({ text: '你'.repeat(70_000) }))
    await expect(readRecorderContent(join(root, '.scry'), tool.outputContent!.contentRef!)).resolves.toBe(expectedToolResult)
  }, 30_000)

  it('uses the bounded transport boundary at 4 MiB without truncating smaller tool payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-tool-boundary-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' "$payload" >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-boundary', getLeafId: () => 'pi-boundary-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }
    await emit('before_agent_start', { prompt: 'boundary' })
    await emit('tool_execution_start', { toolCallId: 'under', toolName: 'read', args: { text: 'u'.repeat(4 * 1024 * 1024 - 2_000) } })
    await emit('tool_execution_start', { toolCallId: 'over', toolName: 'read', args: { text: 'o'.repeat(4 * 1024 * 1024 + 2_000) } })
    await emit('agent_settled')
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(rows[1].tool_input.text).toHaveLength(4 * 1024 * 1024 - 2_000)
    expect(rows[1].scry_capture).toBeUndefined()
    expect(rows[2].tool_input).toMatchObject({ truncated: true })
    expect(rows[2].scry_capture.fields.tool_input).toMatchObject({ status: 'partial', reason: 'byte_limit' })
  }, 20_000)

  it('keeps failed zero usage unavailable and preserves partial successful usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-usage-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nprintf '\\n' >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1, workspaceId: 'pi-usage', capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
    }))
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-usage', getLeafId: () => 'pi-usage-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }
    await emit('before_agent_start', { prompt: 'usage' })
    const success = { role: 'assistant', usage: { input: 12, output: 2, cacheRead: 3, cost: {} }, content: [] }
    await emit('message_end', { message: success })
    await emit('message_end', { message: { role: 'assistant', stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: { total: 0 } }, content: [] } })
    await emit('agent_settled')
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(rows.at(-1)?.usage).toMatchObject({ input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 3 })
    expect(rows.at(-1)?.usage_complete).toBe(false)
    expect(rows.at(-1)?.usage.reasoning_tokens).toBeUndefined()
    for (const row of rows) {
      const event = row.prompt !== undefined ? 'UserPromptSubmit' : 'Stop'
      await handleRecorderHook({ workspace: root, provider: 'pi', event, payload: row })
    }
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.usage.status).toBe('partial')
    expect(record.usage.value).toMatchObject({ inputTokens: 12, outputTokens: 2, cacheReadTokens: 3 })
    expect(record.usage.value?.reasoningTokens).toBeUndefined()
    expect(record.usage.value?.costUsd).toBeUndefined()
  }, 15_000)

  it('SDK 失败且 usage 全零时保持 usage unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-usage-unavailable-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nprintf '\\n' >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1, workspaceId: 'pi-usage-unavailable', capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
    }))
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-usage-unavailable', getLeafId: () => 'pi-usage-unavailable-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }
    await emit('before_agent_start', { prompt: 'failed usage' })
    await emit('message_end', { message: {
      role: 'assistant', stopReason: 'error',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0 } }, content: []
    } })
    await emit('agent_settled')
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(rows.at(-1)?.usage).toBeUndefined()
    expect(rows.at(-1)?.usage_complete).toBe(false)
    for (const row of rows) {
      const event = row.prompt !== undefined ? 'UserPromptSubmit' : 'Stop'
      await handleRecorderHook({ workspace: root, provider: 'pi', event, payload: row })
    }
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.usage.status).toBe('unavailable')
    expect(record.usage.value).toBeUndefined()
  }, 15_000)

  it('Pi 扩展序列化失败保留 unavailable 来源并使 recorder 正文证据 partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-serialization-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nprintf '\\n' >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1, workspaceId: 'pi-serialization', capture: { prompt: true, assistant: true, toolOutput: 'full', toolContentFieldBytes: 8_192, diff: false, hooks: true }
    }))
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-serialization', getLeafId: () => 'pi-serialization-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }
    await emit('before_agent_start', { prompt: 'serialization' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await emit('tool_execution_start', { toolCallId: 'circular-tool', toolName: 'read', args: circular })
    await emit('agent_settled')
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(rows[1].tool_input).toEqual({ unavailable: true })
    expect(rows[1].scry_capture.fields.tool_input).toMatchObject({ status: 'unavailable', reason: 'serialization_error' })
    for (const row of rows) {
      const event = row.tool_name ? 'PreToolUse:read' : row.prompt !== undefined ? 'UserPromptSubmit' : 'Stop'
      await handleRecorderHook({ workspace: root, provider: 'pi', event, payload: row })
    }
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value?.[0].inputContent).toMatchObject({ sourceCompleteness: 'partial' })
  }, 15_000)
})
