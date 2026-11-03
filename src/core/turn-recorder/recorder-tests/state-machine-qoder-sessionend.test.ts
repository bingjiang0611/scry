import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, safeKey } from '../store'
import { workspace } from './fixture.test'

export function registerQoderSessionEndSuite(): void {
  it('Qoder SessionEnd does not bless an unidentified completed Stop without matching transcript evidence', async () => {
    const root = await workspace()
    const sessionId = 'qoder-stale-completed-stop'
    const base = { provider: 'qoder' as const, workspace: root }
    const native = {
      session_id: sessionId,
      cwd: root,
      transcript_path: join(root, 'missing-qoder.jsonl')
    }
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: {
      ...native, hook_event_name: 'UserPromptSubmit', prompt: 'current turn'
    } })
    await expect(handleRecorderHook({ ...base, event: 'Stop', payload: {
      ...native, hook_event_name: 'Stop', assistant_response: 'possibly from the previous turn'
    } })).resolves.toMatchObject({ status: 'pending' })

    const sessionEnd = { ...base, event: 'SessionEnd', payload: {
      ...native, hook_event_name: 'SessionEnd', reason: 'other'
    } }
    await expect(handleRecorderHook(sessionEnd)).resolves.toMatchObject({ status: 'pending' })
    const openPath = join(root, '.scry/runtime/qoder', safeKey(sessionId), 'open.json')
    expect(JSON.parse(await readFile(openPath, 'utf8'))).toMatchObject({
      status: 'closing',
      endReason: 'session_end',
      terminalFallbackStatus: 'interrupted'
    })

    await recoverRecorder(root)
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionId,
      status: 'interrupted',
      termination: { value: { reason: 'session_end' } },
      assistant: { status: 'unavailable' },
      diff: { status: 'unavailable' }
    })
    expect(records[0].diff.omissionReason).toBe('turn diff capture was disabled or unavailable')
    expect(JSON.stringify(records)).not.toContain('possibly from the previous turn')
  })

  it('Qoder activity after a deferred Stop clears every stale terminal verdict', async () => {
    const root = await workspace()
    const sessionId = 'qoder-revoked-deferred-stop'
    const base = { provider: 'qoder' as const, workspace: root }
    const native = { session_id: sessionId, cwd: root }
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: {
      ...native, hook_event_name: 'UserPromptSubmit', prompt: 'keep working'
    } })
    await expect(handleRecorderHook({ ...base, event: 'Stop', payload: {
      ...native, hook_event_name: 'Stop', assistant_response: 'premature completion'
    } })).resolves.toMatchObject({ status: 'pending' })
    await expect(handleRecorderHook({ ...base, event: 'PreToolUse', payload: {
      ...native, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'still-running'
    } })).resolves.toMatchObject({ status: 'recorded' })

    const openPath = join(root, '.scry/runtime/qoder', safeKey(sessionId), 'open.json')
    expect(JSON.parse(await readFile(openPath, 'utf8'))).toMatchObject({ status: 'open' })
    const open = JSON.parse(await readFile(openPath, 'utf8'))
    expect(open).not.toHaveProperty('closingAt')
    expect(open).not.toHaveProperty('terminalAt')
    expect(open).not.toHaveProperty('terminalFallbackStatus')
    expect(open).not.toHaveProperty('endReason')
    expect(open).not.toHaveProperty('deferredTerminalEventId')
    expect(open).not.toHaveProperty('terminalDiffs')
  })
}
