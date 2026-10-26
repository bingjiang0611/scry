import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { safeKey, listRecords, readHealth } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite7(): void {


  it('managed Codex lifecycle 只维护身份，Stop 不用 rollout 抢先提交', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('managed-1', { prompt: '/rate-workflow 1', turn_id: 'root-turn' }),
      managed: true
    })
    const child = await handleRecorderHook({
      provider: 'codex',
      event: 'PreToolUse:Bash',
      workspace: root,
      payload: payload('managed-1', { turn_id: 'child-turn', tool_name: 'Bash', tool_use_id: 'child-call' })
    })
    const stopped = await handleRecorderHook({
      provider: 'codex',
      event: 'Stop',
      workspace: root,
      payload: payload('managed-1', { turn_id: 'root-turn', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    const open = JSON.parse(await readFile(
      join(root, '.scry', 'runtime', 'codex', safeKey('managed-1'), 'open.json'),
      'utf8'
    )) as Record<string, unknown>

    expect(child.status).toBe('recorded')
    expect(stopped).toMatchObject({ status: 'pending', reason: 'managed turn awaits canonical Scry evidence' })
    expect(open).toMatchObject({ managedByScry: true, status: 'closing', captures: [] })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0, pendingCount: 1 })
  })

  it('重复上报同一 toolUseId 时正式记录只保留一次逻辑调用', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'turn.started', workspace: root, payload: payload('c1', { prompt: 'dedupe', turn_id: 't1' }) })
    for (const timestamp of ['2026-07-19T12:00:00.100Z', '2026-07-19T12:00:00.200Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'printf ok' } })
      })
    }
    for (const timestamp of ['2026-07-19T12:00:00.300Z', '2026-07-19T12:00:00.400Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_response: 'ok' })
      })
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z', turn_id: 't1' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-1', status: 'success' })
    ])
  })
}
