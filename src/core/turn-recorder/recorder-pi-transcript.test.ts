import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecorderContent } from './content-store'
import { handleRecorderHook } from './recorder'
import { listRecords } from './store'
import { stableTranscript } from './recorder-transcript-cache'
import { parsePiTranscript } from './recorder-pi-transcript'

const row = (entry: Record<string, unknown>): string => JSON.stringify(entry)

describe('Pi recorder transcript anchoring', () => {
  it('projects only the anchored v3 ancestry and keeps native user boundaries', () => {
    const content = [
      row({ type: 'session', version: 3, id: 'session-1', cwd: '/fixture' }),
      row({ type: 'message', id: 'old-user', parentId: null, timestamp: '2026-10-24T10:00:00.000Z', message: { role: 'user', content: 'old' } }),
      row({ type: 'message', id: 'before', parentId: 'old-user', timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } }),
      row({ type: 'message', id: 'user-1', parentId: 'before', timestamp: '2026-10-24T10:00:02.000Z', message: { role: 'user', content: 'root prompt' } }),
      row({ type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-10-24T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } }] } }),
      row({ type: 'message', id: 'tool-1', parentId: 'assistant-1', timestamp: '2026-10-24T10:00:04.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] } }),
      row({ type: 'message', id: 'user-2', parentId: 'tool-1', timestamp: '2026-10-24T10:00:05.000Z', message: { role: 'user', content: 'steer prompt' } }),
      row({ type: 'message', id: 'assistant-2', parentId: 'user-2', timestamp: '2026-10-24T10:00:06.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }),
      row({ type: 'message', id: 'abandoned', parentId: 'old-user', timestamp: '2026-10-24T10:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'must not appear' }] } })
    ].join('\n') + '\n'

    const read = parsePiTranscript(content, 'pi:session-1:1', { beforeEntryId: 'before', afterEntryId: 'assistant-2' })
    expect(read).toMatchObject({ identityMatched: true, providerTurnId: 'user-1', userText: 'root prompt', terminalStatus: 'completed' })
    expect(read.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolUseId: 'call-1', stage: expect.stringContaining('read') }),
      expect.objectContaining({ stage: 'tool_result', toolUseId: 'call-1' }),
      expect.objectContaining({ kind: 'human', stage: 'steer', steer: expect.objectContaining({ prompt: 'steer prompt' }) })
    ]))
    expect(JSON.stringify(read.events)).not.toContain('must not appear')
  })

  it('commits a native anchored transcript through the real hook path without duplicating hook tools or usage', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-pi-native-')))
    try {
      await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'pi-fixture',
        repositories: { mode: 'workspace-only' }, capture: { diff: false } }))
      const transcript = join(root, 'native-session.jsonl')
      const prefix = [
        { type: 'session', version: 3, id: 'pi-session', cwd: root },
        { type: 'message', id: 'old-user', parentId: null, timestamp: '2026-10-24T10:00:00.000Z', message: { role: 'user', content: 'old prompt' } },
        { type: 'message', id: 'before', parentId: 'old-user', timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], stopReason: 'stop' } }
      ]
      await writeFile(transcript, prefix.map(row).join('\n') + '\n')
      const payload = { session_id: 'pi-session', turn_id: 'hook-turn', transcript_path: transcript,
        pi_transcript_anchor: { before_entry_id: 'before' } }
      const hook = (event: string, at: string, fields: Record<string, unknown> = {}) => handleRecorderHook({
        provider: 'pi', workspace: root, env: {}, event, payload: { ...payload, timestamp: at, ...fields }
      })
      await hook('UserPromptSubmit', '2026-10-24T10:00:02.000Z', { prompt: 'root prompt' })
      await hook('PreToolUse', '2026-10-24T10:00:03.000Z', { tool_name: 'read', tool_use_id: 'call-1', tool_input: { path: 'README.md' } })
      await hook('PostToolUse', '2026-10-24T10:00:04.000Z', { tool_name: 'read', tool_use_id: 'call-1', tool_response: 'ok' })
      const turn = [
        { type: 'message', id: 'user-1', parentId: 'before', timestamp: '2026-10-24T10:00:02.000Z', message: { role: 'user', content: 'root prompt' } },
        { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-10-24T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } }] } },
        { type: 'message', id: 'tool-1', parentId: 'assistant-1', timestamp: '2026-10-24T10:00:04.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'message', id: 'assistant-2', parentId: 'tool-1', timestamp: '2026-10-24T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }
      ]
      await writeFile(transcript, [...prefix, ...turn].map(row).join('\n') + '\n')
      await hook('Stop', '2026-10-24T10:00:05.000Z', { assistant_response: 'done',
        pi_transcript_anchor: { before_entry_id: 'before', after_entry_id: 'assistant-2' },
        usage: { input_tokens: 12, output_tokens: 4 } })
      const records = await listRecords(join(root, '.scry'))
      expect(records).toHaveLength(1)
      const record = records[0]
      expect(record.transcript).toMatchObject({ status: 'available', quality: 'exact' })
      expect(record.user.value?.text).toBe('root prompt')
      expect(record.assistant.value?.text).toBe('done')
      expect(record.tools.value).toHaveLength(1)
      expect(record.usage.value).toMatchObject({ inputTokens: 12, outputTokens: 4 })
      const raw = await readRecorderContent(join(root, '.scry'), record.transcript.value!.contentRef)
      expect(raw).toContain('user-1')
      expect(raw).not.toContain('old prompt')
      expect(raw).not.toContain('"type":"session"')
      const wrong = { ...prefix[0], id: 'other-session' }
      await writeFile(transcript, [wrong, ...prefix.slice(1), ...turn].map(row).join('\n') + '\n')
      const read = await stableTranscript(transcript, 'run', 'pi', undefined, 'hook-turn', 0, undefined, 'pi-session', root,
        { beforeEntryId: 'before', afterEntryId: 'assistant-2' })
      expect(read.identityMatched).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves extension-authored native custom runs without inventing a human prompt', () => {
    const content = [
      row({ type: 'session', version: 3, id: 'session-1', cwd: '/fixture' }),
      row({ type: 'custom_message', id: 'custom-1', parentId: null, timestamp: '2026-10-24T10:00:00.000Z', customType: 'extension-note', content: 'context', display: true }),
      row({ type: 'message', id: 'assistant-1', parentId: 'custom-1', timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } })
    ].join('\n') + '\n'
    const read = parsePiTranscript(content, 'run', { beforeEntryId: null, afterEntryId: 'assistant-1' })
    expect(read).toMatchObject({ identityMatched: true, complete: true, providerTurnId: 'custom-1' })
    expect(read).not.toHaveProperty('userText')
    expect(read.events.filter(event => event.kind === 'human')).toHaveLength(0)
  })

  it('does not claim a turn when the ending native entry is unavailable', () => {
    const read = parsePiTranscript(row({ type: 'session', version: 3, id: 'session-1', cwd: '/fixture' }), 'run', {
      beforeEntryId: null,
      afterEntryId: 'missing'
    })
    expect(read).toMatchObject({ observed: true, identityMatched: false, complete: false, events: [] })
  })
})
