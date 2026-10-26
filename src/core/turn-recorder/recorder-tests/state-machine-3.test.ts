import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, readHealth, safeKey } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite3(): void {


  it('Pi direct lifecycle 记录工具、assistant、usage 与响应耗时', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'pi', event: 'UserPromptSubmit', workspace: root,
      payload: payload('pi-session', { prompt: 'inspect', promptId: 'pi-turn-1' })
    })
    await handleRecorderHook({
      provider: 'pi', event: 'PreToolUse:read', workspace: root,
      payload: payload('pi-session', { promptId: 'pi-turn-1', tool_name: 'read', tool_use_id: 'pi-tool', tool_input: { path: 'README.md' } })
    })
    await handleRecorderHook({
      provider: 'pi', event: 'PostToolUse:read', workspace: root,
      payload: payload('pi-session', { promptId: 'pi-turn-1', tool_name: 'read', tool_use_id: 'pi-tool', tool_response: 'ok' })
    })
    await handleRecorderHook({
      provider: 'pi', event: 'Stop', workspace: root,
      payload: payload('pi-session', {
        promptId: 'pi-turn-1',
        assistant_response: 'done',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
        model_segments: [{ response_id: 'response-1', completed_at: '2026-07-19T12:00:00.900Z', duration_ms: 400 }],
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([{
      provider: { id: 'pi' },
      providerTurnId: 'pi-turn-1',
      assistant: { status: 'available', value: { text: 'done' } },
      usage: { status: 'available', value: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } },
      modelTiming: { status: 'available', value: { method: 'response_intervals', totalCalls: 1, timedCalls: 1 } }
    }])
  })

  it('不再丢弃 200 条之后的原生 model timing segments', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'pi', event: 'UserPromptSubmit', workspace: root,
      payload: payload('pi-many-model-calls', { prompt: 'many calls', promptId: 'pi-many-turn' })
    })
    const modelSegments = Array.from({ length: 250 }, (_, index) => ({
      response_id: `response-${index}`,
      completed_at: new Date(Date.parse('2026-07-19T12:00:00.000Z') + index * 10).toISOString(),
      duration_ms: 5
    }))
    await handleRecorderHook({
      provider: 'pi', event: 'Stop', workspace: root,
      payload: payload('pi-many-model-calls', {
        promptId: 'pi-many-turn', assistant_response: 'done', model_segments: modelSegments,
        timestamp: '2026-07-19T12:00:03.000Z'
      })
    })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.modelTiming?.value?.totalCalls).toBe(250)
    expect(record.modelTiming?.value?.calls).toHaveLength(250)
    expect(record.modelSegments?.status).toBe('available')
  })

  it('相同 prompt 的下一轮不会误去重，open 状态内的重复 prompt 会去重', async () => {
    const root = await workspace()
    const first = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })

    expect(first.status).toBe('started')
    expect(duplicate.status).toBe('duplicate')
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.generation, record.turnIndex])).toEqual([[1, 1], [2, 2]])
  })

  it('Qoder 同一 promptId 的直连与 bridge 包装只开启一轮', async () => {
    const root = await workspace()
    const direct = payload('q1', { prompt: '/rate-workflow 1', promptId: 'qoder-turn-1' })
    const bridged = payload('q1', {
      prompt: '/rate-workflow 1',
      turn_id: 'bridge-envelope-id',
      raw_qoder_payload: { ...direct, promptId: 'qoder-turn-1' }
    })

    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: direct }))
      .toMatchObject({ status: 'started' })
    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: bridged }))
      .toMatchObject({ status: 'duplicate' })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', { promptId: 'qoder-turn-1', timestamp: '2026-07-19T12:00:01.000Z' })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { providerTurnId: 'qoder-turn-1', turnIndex: 1, status: 'completed' }
    ])
  })

  it('Qoder 无 promptId 时按原始 payload 去重直连与 bridge 包装', async () => {
    const root = await workspace()
    const direct = payload('q1', { prompt: '/rate-workflow 1' })
    const bridged = {
      ...direct,
      hook_event_name: 'UserPromptSubmit',
      cwd: root,
      raw_qoder_payload: direct
    }

    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: direct }))
      .toMatchObject({ status: 'started' })
    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: bridged }))
      .toMatchObject({ status: 'duplicate' })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', { timestamp: '2026-07-19T12:00:01.000Z' })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { turnIndex: 1, status: 'completed' }
    ])
  })

  it.each([
    ['qoder', 'UserPromptSubmit', 'Stop'],
    ['opencode', 'chat.message', 'session.idle']
  ] as const)('%s 无 turn id 时延迟 terminal 不关闭替换后的新轮', async (provider, startEvent, endEvent) => {
    const root = await workspace()
    const withoutTimestamp = (prompt?: string) => payload('late-terminal', { timestamp: undefined, ...(prompt ? { prompt } : {}) })
    await handleRecorderHook({ provider, event: startEvent, workspace: root, payload: withoutTimestamp('old') })
    await handleRecorderHook({ provider, event: startEvent, workspace: root, payload: withoutTimestamp('new') })

    await expect(handleRecorderHook({ provider, event: endEvent, workspace: root, payload: withoutTimestamp() }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('deferred') })
    await handleRecorderHook({
      provider,
      event: 'PreToolUse:Read',
      workspace: root,
      payload: payload('late-terminal', { timestamp: undefined, tool_name: 'Read', tool_use_id: 'new-tool', tool_input: { path: 'README.md' } })
    })
    await handleRecorderHook({
      provider,
      event: 'PostToolUse:Read',
      workspace: root,
      payload: payload('late-terminal', { timestamp: undefined, tool_name: 'Read', tool_use_id: 'new-tool', tool_response: 'ok' })
    })
    await handleRecorderHook({ provider, event: endEvent, workspace: root, payload: withoutTimestamp() })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.turnIndex, record.status, record.tools.value?.length ?? 0])).toEqual([
      [1, 'interrupted', 0],
      [2, 'completed', 1]
    ])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0 })
  })

  it('Qoder 已完成上一轮的重复 terminal 不关闭下一轮', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: payload('q-duplicate-stop', { prompt: 'first', timestamp: '2026-07-19T12:00:00.000Z' })
    })
    await handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: root,
      payload: payload('q-duplicate-stop', { timestamp: '2026-07-19T12:00:31.000Z' })
    })
    const noTime = (extra: Record<string, unknown> = {}) => payload('q-duplicate-stop', { timestamp: undefined, ...extra })
    await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: noTime({ prompt: 'second' }) })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: noTime() }))
      .resolves.toMatchObject({ status: 'pending' })
    await handleRecorderHook({
      provider: 'qoder', event: 'PreToolUse:Read', workspace: root,
      payload: noTime({ tool_name: 'Read', tool_use_id: 'second-tool', tool_input: { path: 'README.md' } })
    })
    await handleRecorderHook({
      provider: 'qoder', event: 'PostToolUse:Read', workspace: root,
      payload: noTime({ tool_name: 'Read', tool_use_id: 'second-tool', tool_response: 'ok' })
    })
    await handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: noTime() })

    expect((await listRecords(join(root, '.scry'))).map((record) => [record.turnIndex, record.status, record.tools.value?.length ?? 0])).toEqual([
      [1, 'completed', 0],
      [2, 'completed', 1]
    ])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0 })
  })

  it('Qoder bridge 内显式旧时间的 terminal 直接拒绝且不吞当前 terminal', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: payload('q-stale', { prompt: 'old', timestamp: '2026-07-19T12:00:00.000Z' })
    })
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: payload('q-stale', { prompt: 'new', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: root,
      payload: payload('q-stale', {
        timestamp: undefined,
        raw_qoder_payload: payload('q-stale', { timestamp: '2026-07-19T12:00:01.000Z' })
      })
    })).resolves.toMatchObject({ status: 'duplicate', reason: expect.stringContaining('predates') })
    await handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: root,
      payload: payload('q-stale', { timestamp: '2026-07-19T12:00:33.000Z' })
    })

    expect((await listRecords(join(root, '.scry'))).map((record) => [record.turnIndex, record.status])).toEqual([
      [1, 'interrupted'],
      [2, 'completed']
    ])
  })

  it('无后续活动的早期 terminal 在 grace 到期后由 recovery 收敛', async () => {
    const root = await workspace()
    const noTime = (prompt?: string) => payload('q-grace', { timestamp: undefined, ...(prompt ? { prompt } : {}) })
    await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: noTime('old') })
    await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: noTime('new') })
    await handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: noTime() })
    const openPath = join(root, '.scry', 'runtime', 'qoder', safeKey('q-grace'), 'open.json')
    const open = JSON.parse(await readFile(openPath, 'utf8'))
    await writeFile(openPath, JSON.stringify({ ...open, deferredTerminalAt: '2000-01-01T00:00:00.000Z' }))

    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 1 })
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.turnIndex, record.status])).toEqual([
      [1, 'interrupted'],
      [2, 'completed']
    ])
  })

  it('Qoder 相同 prompt 但不同 promptId 仍保留两个真实轮次', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', { prompt: 'same', promptId: 'qoder-turn-1' })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', {
        prompt: 'same',
        promptId: 'qoder-turn-2',
        timestamp: '2026-07-19T12:00:02.000Z'
      })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', { promptId: 'qoder-turn-2', timestamp: '2026-07-19T12:00:03.000Z' })
    })

    expect((await listRecords(join(root, '.scry'))).map((record) => [record.providerTurnId, record.status])).toEqual([
      ['qoder-turn-1', 'interrupted'],
      ['qoder-turn-2', 'completed']
    ])
  })
}
