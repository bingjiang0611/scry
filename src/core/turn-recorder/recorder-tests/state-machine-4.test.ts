import { writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, archiveRecords } from '../store'
import { readRecorderContent } from '../content-store'
import { workspace, payload } from './fixture.test'

export function registerSuite4(): void {


  it('Qoder compact transcript 保留原始 hook prompt，并合并 compact 前后 assistant', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-session.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'qoder-turn-1',
        message: {
          role: 'user',
          content: '<command-name>/rate-native-rate-workflow</command-name><command-args>84959911</command-args>'
        }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'qoder-turn-1',
        message: { content: [{ type: 'text', text: 'compact 前' }] }
      }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', isCompactSummary: true }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: [{ type: 'text', text: 'synthetic summary' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'qoder-turn-1',
        message: { content: [{ type: 'text', text: 'compact 后' }] }
      })
    ].join('\n'))
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', {
        prompt: '/rate-native-rate-workflow 84959911',
        promptId: 'qoder-turn-1',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', {
        promptId: 'qoder-turn-1',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.user.value?.text).toBe('/rate-native-rate-workflow 84959911')
    expect(record.assistant.value?.text).toBe('compact 前compact 后')
    expect(record.assistant.value?.text).not.toContain('synthetic summary')
    expect(record.compactions?.value).toEqual([
      expect.objectContaining({ eventId: expect.any(String) })
    ])
  })

  it('Claude 三条 task-notification 延续首轮，最终只提交两个真实轮次并保留原始 slash prompt', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-continuations.jsonl')
    const user = (promptId: string, content: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'user',
      promptId,
      message: { role: 'user', content },
      ...extra
    })
    const tool = (promptId: string, id: string) => JSON.stringify({
      type: 'assistant',
      promptId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `printf ${id}` } }]
      }
    })
    const notificationText = (taskId: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`
    const slashEnvelope = '<command-message>rate-workflow</command-message>\n' +
      '<command-name>/rate-workflow</command-name>\n' +
      '<command-args>85076624 写技术方案前停下</command-args>'
    await writeFile(transcript, `${[
      user('real-1', slashEnvelope),
      tool('real-1', 'root-tool')
    ].join('\n')}\n`)

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-session', {
        prompt: '/rate-workflow 85076624 写技术方案前停下',
        promptId: 'real-1',
        transcript_path: transcript
      })
    })
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-session', {
        promptId: 'real-1',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })).resolves.toMatchObject({ status: 'pending' })

    for (const [index, taskId] of ['task-a', 'task-b', 'task-a'].entries()) {
      const promptId = `notification-${index + 1}`
      const toolId = `continuation-tool-${index + 1}`
      await appendFile(transcript, `${[
        user(promptId, notificationText(taskId), { origin: { kind: 'task-notification' }, promptSource: 'sdk' }),
        tool(promptId, toolId)
      ].join('\n')}\n`)
      await expect(handleRecorderHook({
        provider: 'claude',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('claude-session', {
          prompt: notificationText(taskId),
          promptId,
          origin: { kind: 'task-notification' },
          transcript_path: transcript,
          timestamp: `2026-07-19T12:00:0${index + 2}.000Z`
        })
      })).resolves.toMatchObject({ status: 'recorded' })
      await handleRecorderHook({
        provider: 'claude',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('claude-session', {
          promptId,
          tool_name: 'Bash',
          tool_use_id: toolId,
          tool_input: { command: `printf ${toolId}` }
        })
      })
      await expect(handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: root,
        payload: payload('claude-session', {
          promptId,
          transcript_path: transcript,
          timestamp: `2026-07-19T12:00:0${index + 5}.000Z`
        })
      })).resolves.toMatchObject({ status: 'pending' })
    }

    await appendFile(transcript, `${[
      user('real-2', '确认 写技术方案前停下'),
      tool('real-2', 'second-turn-tool')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-session', {
        prompt: '确认 写技术方案前停下',
        promptId: 'real-2',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:09.000Z'
      })
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-session', {
        promptId: 'real-2',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:10.000Z'
      })
    })).resolves.toMatchObject({ status: 'pending' })
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.providerTurnId, record.turnIndex, record.status, record.user.value?.text])).toEqual([
      ['real-1', 1, 'completed', '/rate-workflow 85076624 写技术方案前停下'],
      ['real-2', 2, 'completed', '确认 写技术方案前停下']
    ])
    expect(records[0].tools.value?.map((call) => call.id)).toEqual([
      'root-tool',
      'continuation-tool-1',
      'continuation-tool-2',
      'continuation-tool-3'
    ])
    expect(records.flatMap((record) => record.user.value?.text ?? []).join('\n')).not.toContain('<task-notification>')
  })

  it('Claude 指定 providerTurnId 未出现在 transcript 时保持 pending，绝不借用最后一轮', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-unmatched-id.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'other-turn',
        message: { role: 'user', content: 'other prompt' }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'other-turn',
        message: { role: 'assistant', content: [{ type: 'text', text: 'other answer' }] }
      })
    ].join('\n'))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-unmatched', {
        prompt: 'target prompt',
        promptId: 'target-turn',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-unmatched', {
        promptId: 'target-turn',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 1, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])

    await appendFile(transcript, `\n${JSON.stringify({
      type: 'user',
      promptId: 'target-turn',
      message: { role: 'user', content: 'target prompt' }
    })}\n`)
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      {
        providerTurnId: 'target-turn',
        user: { value: { text: 'target prompt' } }
      }
    ])
  })

  it('Claude 超过旧 rewind 大小的单行 prompt 仍按完整身份归档', async () => {
    const root = await workspace()
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.capture.toolOutput = 'full'
    await writeFile(configPath, JSON.stringify(config))
    const transcript = join(root, 'claude-large-prompt.jsonl')
    const prompt = `large:${'p'.repeat(4 * 1024 * 1024 + 128)}`
    await writeFile(transcript, JSON.stringify({
      type: 'user',
      promptId: 'large-prompt-turn',
      message: { role: 'user', content: prompt }
    }) + '\n')
    await handleRecorderHook({
      provider: 'claude', event: 'UserPromptSubmit', workspace: root,
      payload: payload('claude-large-prompt', {
        prompt, promptId: 'large-prompt-turn', transcript_path: transcript
      })
    })
    await appendFile(transcript, JSON.stringify({
      type: 'assistant',
      promptId: 'large-prompt-turn',
      message: { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }] }
    }) + '\n')
    await handleRecorderHook({
      provider: 'claude', event: 'Stop', workspace: root,
      payload: payload('claude-large-prompt', {
        promptId: 'large-prompt-turn', transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })
    await recoverRecorder(root)
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      providerTurnId: 'large-prompt-turn',
      assistant: { value: { text: 'complete answer' } }
    })
    expect(records[0].user.value?.text.length).toBe(prompt.length)
    const source = await readFile(transcript, 'utf8')
    const transcriptEvidence = records[0].transcript
    expect(transcriptEvidence).toMatchObject({
      status: 'available', quality: 'exact',
      value: {
        sourcePath: transcript,
        startOffset: 0,
        endOffset: Buffer.byteLength(source),
        sourceCompleteness: 'complete'
      }
    })
    const ref = transcriptEvidence!.value!.contentRef
    expect(ref.bytes).toBe(Buffer.byteLength(source))
    await writeFile(transcript, 'rotated-away\n')
    await expect(readRecorderContent(join(root, '.scry'), ref)).resolves.toBe(source)

    const target = join(root, 'transcript-archive')
    await archiveRecords(join(root, '.scry'), { throughSequence: 1, target })
    await rm(join(root, '.scry', 'content'), { recursive: true, force: true })
    await expect(readRecorderContent(target, ref)).resolves.toBe(source)
  })

  it.each([
    ['promptId 优先于 turnId', { promptId: 'claude-root', turn_id: 'different-turn' }],
    ['promptEventId 可作为兼容回退', { prompt_event_id: 'claude-root' }]
  ])('Claude %s 并与 transcript promptId 对齐', async (_case, identity) => {
    const root = await workspace()
    const transcript = join(root, 'claude-provider-id-priority.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'claude-root',
        message: { role: 'user', content: 'root prompt' }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'claude-root',
        message: { role: 'assistant', content: [{ type: 'text', text: 'root answer' }] }
      })
    ].join('\n'))

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-id-priority', {
        ...identity,
        prompt: 'root prompt',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-id-priority', {
        ...identity,
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      { providerTurnId: 'claude-root', user: { value: { text: 'root prompt' } } }
    ])
  })
}
