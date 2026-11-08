import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, safeKey } from '../store'
import { workspace } from './fixture.test'

export function registerQoderSessionEndSuite(): void {
  it('Qoder command wrapper inherits the injected identity so Stop commits the first turn and the next turn remains separate', async () => {
    const root = await workspace()
    const sessionId = 'qoder-command-wrapper'
    const transcript = join(root, 'qoder.jsonl')
    const base = { provider: 'qoder' as const, workspace: root }
    const command = '<command-name>/rate-native</command-name><command-args>42</command-args>'
    const native = { session_id: sessionId, cwd: root, transcript_path: transcript }

    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: {
      ...native, request_set_id: 'request-1', prompt: '/rate-native 42', timestamp: '2026-07-19T12:00:00.000Z', hook_event_name: 'UserPromptSubmit'
    } })
    await writeFile(transcript, [
      { type: 'user', message: { role: 'user', content: command } },
      {
        type: 'user', isMeta: true, promptId: 'prompt-1', requestSetId: 'request-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/commands' }] }
      },
      { type: 'assistant', promptId: 'prompt-1', message: { content: [{ type: 'text', text: 'first answer' }] } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const firstStop = await handleRecorderHook({ ...base, event: 'Stop', payload: {
      ...native, parent_request_set_id: 'request-1', timestamp: '2026-07-19T12:00:01.000Z', hook_event_name: 'Stop', assistant_response: 'first answer'
    } })
    expect(firstStop).toMatchObject({ status: 'committed' })
    const firstRecords = await listRecords(join(root, '.scry'))
    expect(firstRecords).toHaveLength(1)
    expect(firstRecords[0]).toMatchObject({
      providerTurnId: 'prompt-1',
      user: { value: { text: '/rate-native 42' } },
      assistant: { value: { text: 'first answer' } }
    })

    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: {
      ...native, request_set_id: 'request-2', prompt: 'next prompt', timestamp: '2026-07-19T12:00:02.000Z', hook_event_name: 'UserPromptSubmit'
    } })
    await writeFile(transcript, [
      { type: 'user', promptId: 'prompt-2', requestSetId: 'request-2', message: { role: 'user', content: 'next prompt' } },
      { type: 'assistant', promptId: 'prompt-2', message: { content: [{ type: 'text', text: 'next answer' }] } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n', { flag: 'a' })
    const secondStop = await handleRecorderHook({ ...base, event: 'Stop', payload: {
      ...native, parent_request_set_id: 'request-2', timestamp: '2026-07-19T12:00:03.000Z', hook_event_name: 'Stop', assistant_response: 'next answer'
    } })
    expect(secondStop).toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    expect(records).toMatchObject([
      {
        providerTurnId: 'prompt-1',
        user: { value: { text: '/rate-native 42' } },
        assistant: { value: { text: 'first answer' } }
      },
      {
        providerTurnId: 'prompt-2',
        user: { value: { text: 'next prompt' } },
        assistant: { value: { text: 'next answer' } }
      }
    ])
    expect(records.map((record) => [record.providerTurnId, record.status])).toEqual([
      ['prompt-1', 'completed'],
      ['prompt-2', 'completed']
    ])
  })

  it('Qoder SessionEnd does not bless an unidentified completed Stop without matching transcript evidence', async () => {
    const root = await workspace()
    const sessionId = 'qoder-stale-completed-stop'
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.capture.diff = true
    await writeFile(configPath, JSON.stringify(config))
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
    expect(records[0].diff.omissionReason).toBe('turn diff snapshot was not captured')
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
