import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t

describe('Qoder provider adapter · session forks', () => {
  beforeEach(() => resetQoderTestState(t))

  it('forks Qoder immediately before the edited native prompt', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'assistant', uuid: 'assistant-previous' },
      { type: 'user', uuid: 'prompt-last' },
      { type: 'assistant', uuid: 'assistant-last' }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-forked' })

    await expect(createQoderAdapter().forkLastTurn!.fork({
      sourceSessionId: 'session-source',
      originalPrompt: 'old prompt',
      replaceRunId: 'run-last',
      replaceProviderTurnId: 'qoder-turn-last',
      replaceForkTurnId: 'prompt-last',
      previousProviderTurnId: 'qoder-turn-previous',
      previousForkTurnId: 'prompt-previous',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-forked' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-previous',
      title: 'Edited branch'
    })
  })

  it.each(['EPERM', 'EACCES'])('explains %s without retrying a potentially dispatched fork', async (code) => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'user-1', message: { content: 'prompt' } },
      { type: 'assistant', uuid: 'assistant-1', message: { content: 'answer' } }
    ])
    sdk.forkSession.mockRejectedValue(Object.assign(new Error('operation not permitted'), { code, path: '/qoder/session.jsonl' }))
    await expect(createQoderAdapter().forkSession!.fork({
      providerId: 'qoder', sourceSessionId: 'session-source', sourceRunId: 'run-1', sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'user-1', cwd: '/repo'
    })).rejects.toThrow(`Qoder 会话文件访问被系统拒绝（${code}）`)
    expect(sdk.forkSession).toHaveBeenCalledTimes(1)
  })

  it('forks a legacy Qoder promptId through its exact UUID and all tool responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-qoder-fork-'))
    const previous = process.env.QODER_CONFIG_DIR
    const sessionId = '11111111-1111-4111-8111-111111111111'
    try {
      process.env.QODER_CONFIG_DIR = root
      const dir = join(root, 'projects', 'project')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'user', uuid: 'user-uuid', promptId: 'legacy-prompt-id', sessionId, cwd: '/repo'
      }) + '\n')
      sdk.getSessionMessages.mockResolvedValue([
        { type: 'user', uuid: 'user-uuid', message: { content: 'same prompt' } },
        { type: 'assistant', uuid: 'tool-call' },
        { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result' }] } },
        { type: 'assistant', uuid: 'final-response' },
        { type: 'user', uuid: 'next-user', message: { content: 'same prompt' } }
      ])
      sdk.forkSession.mockResolvedValue({ sessionId: 'new-session' })
      const request = {
        providerId: 'qoder' as const, sourceSessionId: sessionId, sourceRunId: 'run-old',
        sourceProviderTurnId: 'legacy-prompt-id', sourceForkTurnId: 'legacy-prompt-id', cwd: '/repo'
      }
      await expect(createQoderAdapter().forkSession!.fork(request))
        .resolves.toEqual({ externalSessionId: 'new-session' })
      expect(sdk.forkSession).toHaveBeenCalledWith(sessionId, {
        dir: '/repo', upToMessageId: 'final-response', title: 'Scry branch'
      })
      sdk.forkSession.mockClear()
      sdk.getSessionMessages.mockResolvedValue([{ type: 'user', uuid: 'different-user' }])
      await expect(createQoderAdapter().forkSession!.fork(request)).rejects.toThrow('不在原生活动分支')
      expect(sdk.forkSession).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forks Qoder after the selected completed turn', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'prompt-1' },
      { type: 'assistant', uuid: 'assistant-1' },
      { type: 'user', uuid: 'prompt-2' },
      { type: 'assistant', uuid: 'assistant-2' }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-branched' })

    await expect(createQoderAdapter().forkSession!.fork({
      providerId: 'qoder',
      sourceSessionId: 'session-source',
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'qoder-turn-1',
      sourceForkTurnId: 'prompt-1',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-branched' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-1',
      title: 'Scry branch'
    })
  })

  it('用 transcript user content 回退定位旧 archive 中没有 forkTurnId 的 Qoder prompt', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'prompt-previous', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'assistant-previous', message: { role: 'assistant', content: [] } },
      { type: 'user', uuid: 'native-prompt-last', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] } },
      { type: 'assistant', uuid: 'assistant-last', message: { role: 'assistant', content: [] } }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-forked' })

    await expect(createQoderAdapter().forkLastTurn!.fork({
      sourceSessionId: 'session-source',
      originalPrompt: 'old prompt',
      replaceRunId: 'run-last',
      replaceProviderTurnId: 'legacy-prompt-id',
      replaceForkTurnId: 'legacy-prompt-id',
      previousProviderTurnId: 'previous-prompt-id',
      previousForkTurnId: 'previous-prompt-id',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-forked' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-previous',
      title: 'Edited branch'
    })
  })
})
