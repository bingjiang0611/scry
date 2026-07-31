import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraceArchive } from './transcript-archive'
import { mergeSessionTurns } from './session-history'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session history merge', () => {
  it('drops transcript usage shadows when the archive has the canonical terminal result', () => {
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'claude',
      turns: [{
        runId: 'run-1',
        userText: 'inspect',
        items: [{ id: 'canonical', ts: '2026-08-01T00:00:02.000Z', runId: 'run-1', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5 }],
        done: true,
        status: 'completed',
        ts: 1
      }]
    }
    const [turn] = mergeSessionTurns([{
      userText: 'inspect',
      items: [
        { id: 'shadow-1', ts: '2026-08-01T00:00:00.000Z', runId: 'sess', kind: 'harness', stage: 'result', text: 'transcript assistant usage', tokensIn: 3 },
        { id: 'shadow-2', ts: '2026-08-01T00:00:01.000Z', runId: 'sess', kind: 'harness', stage: 'result', text: 'transcript assistant usage', tokensIn: 7 }
      ]
    }], archive)
    expect(turn.items.filter((event) => event.kind === 'harness' && event.stage === 'result')).toEqual([
      expect.objectContaining({ id: 'canonical', tokensIn: 10 })
    ])
  })

  it('把 Claude command envelope 与 archive 纯文本命令识别为同一轮', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      turns: [
        {
          runId: 'run-command',
          userText: '/workflow-orchestrator 12345678',
          items: [{ id: 'archive-command', ts: '', runId: 'run-command', kind: 'hook', stage: 'hook_response' }],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns(
      [
        {
          userText:
            '<command-message>workflow-orchestrator</command-message>\n<command-name>/workflow-orchestrator</command-name>\n<command-args>12345678</command-args>',
          items: [{ id: 'transcript-command', ts: '', runId: 'sess', kind: 'model', stage: 'text' }]
        }
      ],
      archive
    )

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ runId: 'run-command', done: true })
    expect(turns[0].items.map((item) => item.id)).toEqual(['transcript-command', 'archive-command'])
  })

  it('相同 prompt 重复出现时，archive 与 transcript 仍保持一对一匹配', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      turns: [
        {
          runId: 'run-1',
          userText: '继续',
          items: [{ id: 'archive-1', ts: '', runId: 'run-1', kind: 'hook', stage: 'hook_response' }],
          done: true,
          ts: 1
        },
        {
          runId: 'run-2',
          userText: '继续',
          items: [{ id: 'archive-2', ts: '', runId: 'run-2', kind: 'hook', stage: 'hook_response' }],
          done: true,
          ts: 2
        }
      ]
    }

    const turns = mergeSessionTurns(
      [
        { userText: '继续', items: [{ id: 'transcript-1', ts: '', runId: 'sess', kind: 'model', stage: 'text' }] },
        { userText: '继续', items: [{ id: 'transcript-2', ts: '', runId: 'sess', kind: 'model', stage: 'text' }] }
      ],
      archive
    )

    expect(turns).toHaveLength(2)
    expect(turns[0].items.map((item) => item.id)).toEqual(['transcript-1', 'archive-1'])
    expect(turns[1].items.map((item) => item.id)).toEqual(['transcript-2', 'archive-2'])
  })

  it('Hook 合并按 hookId 区分处理器实例，但同一 lifecycle 事件只保留一份', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      turns: [
        {
          runId: 'run-hooks',
          userText: '检查 Hook',
          items: [
            { id: 'a-start-1', ts: '2026-07-14T00:00:00.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_started', hookId: 'hook-1', hookName: 'PostToolUse:Bash' },
            {
              id: 'a-response-1',
              ts: '2026-07-14T00:00:01.000Z',
              runId: 'run-hooks',
              kind: 'hook',
              stage: 'hook_response',
              hookId: 'hook-1',
              hookName: 'PostToolUse:Bash',
              text: '{"hookSpecificOutput":{"additionalContext":"additional context: keep going"}}',
              input: { stdout: '{"hookSpecificOutput":{"additionalContext":"additional context: keep going"}}' }
            },
            { id: 'a-start-2', ts: '2026-07-14T00:00:02.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_started', hookId: 'hook-2', hookName: 'PostToolUse:Bash' },
            { id: 'a-response-2', ts: '2026-07-14T00:00:03.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_response', hookId: 'hook-2', hookName: 'PostToolUse:Bash', hookOutcome: 'cancelled' },
            { id: 'a-start-3', ts: '2026-07-14T00:00:04.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_started', hookId: 'hook-3', hookName: 'PreToolUse:Edit' },
            { id: 'a-response-3', ts: '2026-07-14T00:00:05.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_response', hookId: 'hook-3', hookName: 'PreToolUse:Edit', hookOutcome: 'cancelled' },
            { id: 'a-start-4', ts: '2026-07-14T00:00:04.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_started', hookId: 'hook-4', hookName: 'PreToolUse:Edit' },
            { id: 'a-response-4', ts: '2026-07-14T00:00:05.000Z', runId: 'run-hooks', kind: 'hook', stage: 'hook_response', hookId: 'hook-4', hookName: 'PreToolUse:Edit', hookOutcome: 'cancelled' }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns(
      [
        {
          userText: '检查 Hook',
          items: [
            { id: 't-response-1', ts: '2026-07-14T00:00:01.000Z', runId: 'sess', kind: 'hook', stage: 'hook_response', hookId: 'hook-1', hookName: 'PostToolUse:Bash' },
            {
              id: 't-progress-1',
              ts: '2026-07-14T00:00:01.150Z',
              runId: 'sess',
              kind: 'hook',
              stage: 'hook_progress',
              hookId: 'toolu-progress',
              hookName: 'PostToolUse:Bash',
              text: 'keep going'
            },
            {
              id: 't-evidence-2',
              ts: '2026-07-14T00:00:02.999Z',
              runId: 'sess',
              kind: 'hook',
              stage: 'hook_response',
              hookId: 'toolu-bash-2',
              hookName: 'PostToolUse:Bash',
              hookOutcome: 'cancelled',
              hookCommand: 'audit-hook.sh',
              text: 'hook cancelled',
              input: { stderr: 'hook cancelled' }
            },
            {
              id: 't-evidence-3',
              ts: '2026-07-14T00:00:05.000Z',
              runId: 'sess',
              kind: 'hook',
              stage: 'hook_response',
              hookId: 'toolu-edit',
              hookName: 'PreToolUse:Edit',
              hookOutcome: 'cancelled',
              hookCommand: 'branch-check-hook.sh'
            },
            {
              id: 't-evidence-4',
              ts: '2026-07-14T00:00:05.000Z',
              runId: 'sess',
              kind: 'hook',
              stage: 'hook_response',
              hookId: 'toolu-edit',
              hookName: 'PreToolUse:Edit',
              hookOutcome: 'cancelled',
              hookCommand: 'code-heat-gate-hook.sh'
            }
          ]
        }
      ],
      archive
    )

    expect(turns[0].items.map((item) => `${item.stage}:${item.hookId}`)).toEqual([
      'hook_started:hook-1',
      'hook_response:hook-1',
      'hook_started:hook-2',
      'hook_response:hook-2',
      'hook_started:hook-3',
      'hook_started:hook-4',
      'hook_response:hook-3',
      'hook_response:hook-4'
    ])
    expect(turns[0].items.find((item) => item.hookId === 'hook-2' && item.stage === 'hook_response')).toMatchObject({
      hookCommand: 'audit-hook.sh',
      text: 'hook cancelled',
      input: { stderr: 'hook cancelled' }
    })
    expect(turns[0].items.filter((item) => item.stage === 'hook_progress')).toHaveLength(0)
    expect(turns[0].items.filter((item) => item.hookCommand).map((item) => item.hookCommand)).toEqual([
      'audit-hook.sh',
      'branch-check-hook.sh',
      'code-heat-gate-hook.sh'
    ])
  })

  it('保留 transcript 全量历史，并把 trace archive 作为补充明细合并进对应轮次', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-history-'))
    roots.push(root)
    const imageDir = join(root, 'Application Support', 'scry', 'attachments', 'run-1')
    mkdirSync(imageDir, { recursive: true })
    const imagePath = join(imageDir, '01-image.png')
    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('hello image')
    ])
    writeFileSync(imagePath, imageBytes)

    const archive: TraceArchive = {
      version: 1,
      cwd: '/repo',
      sessionId: 'sess',
      turns: [
        {
          runId: 'run-1',
          userText: `这是什么原因\n\nScry pasted image attachments:\n1. 01-image.png (image/png, 11 KB) local copy: ${imagePath}`,
          items: [{ id: 'archive-event', ts: '', runId: 'run-1', kind: 'hook', stage: 'hook_response' }],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns(
      [
        { userText: '前面的历史', items: [{ id: 'old', ts: '', runId: 'sess', kind: 'model', stage: 'text' }] },
        { userText: '这是什么原因', items: [{ id: 'transcript-event', ts: '', runId: 'sess', kind: 'model', stage: 'text' }] }
      ],
      archive,
      { userDataDir: join(root, 'Application Support', 'scry') }
    )

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ userText: '前面的历史', items: [{ id: 'old' }] })
    expect(turns[1].userText).toBe('这是什么原因')
    expect(turns[1].items.map((item) => item.id)).toEqual(['transcript-event', 'archive-event'])
    expect(turns[1].attachments?.[0]).toMatchObject({
      kind: 'image',
      name: '01-image.png',
      mimeType: 'image/png',
      path: imagePath
    })
    expect(turns[1].attachments?.[0].dataBase64).toBe(imageBytes.toString('base64'))
  })

  it('archive 只有 runtime 能力清单时，不覆盖 transcript 里的最终回答', () => {
    const archive: TraceArchive = {
      version: 1,
      cwd: '/repo',
      sessionId: 'sess',
      turns: [
        {
          runId: 'run-qoder',
          userText: '当前处于哪个目录',
          items: [
            {
              id: 'capabilities',
              ts: '2026-07-08T13:22:45.926Z',
              runId: 'run-qoder',
              kind: 'harness',
              stage: 'runtime:capabilities',
              runtimeProvider: 'qoder_cli'
            }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns(
      [
        {
          userText: '当前处于哪个目录',
          items: [
            {
              id: 'answer',
              ts: '2026-07-08T13:22:45.100Z',
              runId: 'sess',
              kind: 'model',
              stage: 'text',
              text: '当前目录是：/repo'
            },
            {
              id: 'result',
              ts: '2026-07-08T13:22:45.200Z',
              runId: 'sess',
              kind: 'harness',
              stage: 'result',
              tokensIn: 2,
              tokensOut: 4
            }
          ]
        }
      ],
      archive
    )

    expect(turns).toHaveLength(1)
    expect(turns[0].items.map((item) => item.id)).toEqual(['answer', 'result', 'capabilities'])
    expect(turns[0].items.find((item) => item.id === 'answer')).toMatchObject({
      kind: 'model',
      stage: 'text',
      text: '当前目录是：/repo'
    })
  })

  it('同一 run 出现迟到 turn_diff 时只保留最后一条', () => {
    const snapshot = (added: number) => ({
      version: 1 as const,
      status: 'captured' as const,
      files: [{ path: '/repo/a.ts', added, deleted: 0 }],
      beforeAt: '2026-07-14T00:00:00.000Z',
      afterAt: '2026-07-14T00:00:01.000Z',
      captureMs: 2,
      cleanup: 'ok' as const
    })
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'codex',
      turns: [
        {
          runId: 'run-1',
          userText: 'edit',
          items: [
            { id: 'diff-old', ts: '2026-07-14T00:00:01.000Z', runId: 'run-1', kind: 'harness', stage: 'turn_diff', turnDiff: snapshot(1) },
            { id: 'diff-new', ts: '2026-07-14T00:00:02.000Z', runId: 'run-1', kind: 'harness', stage: 'turn_diff', turnDiff: snapshot(3) }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns([], archive)
    expect(turns[0].items.filter((item) => item.stage === 'turn_diff')).toHaveLength(1)
    expect(turns[0].items.find((item) => item.stage === 'turn_diff')).toMatchObject({
      id: 'diff-new',
      turnDiff: { files: [{ added: 3 }] }
    })
  })

  it('四 Provider 历史归档回放时重新识别 MCP 业务失败并补齐工具身份', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'codex',
      turns: [
        {
          runId: 'run-mcp',
          userText: '读取文档',
          items: [
            {
              id: 'mcp-use',
              ts: '2026-07-14T00:00:00.000Z',
              runId: 'run-mcp',
              kind: 'tool',
              stage: 'tool:Bash',
              tool: 'Bash',
              toolUseId: 'call-1',
              input: { command: 'mcporter call ding-doc.fetch --args \'{"url":"bad"}\'' },
              isMcp: true,
              mcpServer: 'ding-doc',
              mcpAction: 'fetch',
              mcpTool: 'mcp__ding-doc__fetch'
            },
            {
              id: 'mcp-result',
              ts: '2026-07-14T00:00:01.000Z',
              runId: 'run-mcp',
              kind: 'tool',
              stage: 'tool_result',
              toolUseId: 'call-1',
              output: '{"success":false,"code":"INVALID_URL"}',
              isError: false
            }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    const items = mergeSessionTurns([], archive)[0].items
    expect(items[1]).toMatchObject({
      id: 'mcp-result',
      isMcp: true,
      mcpServer: 'ding-doc',
      mcpAction: 'fetch',
      mcpTool: 'mcp__ding-doc__fetch',
      mcpCalls: [{ server: 'ding-doc', action: 'fetch', tool: 'mcporter:ding-doc.fetch' }],
      isError: true
    })
  })

  it('四 Provider 历史归档回放时不把成功 MCP 结果误判成失败', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'opencode',
      turns: [
        {
          runId: 'run-mcp',
          userText: '读取文档',
          items: [
            {
              id: 'mcp-use',
              ts: '2026-07-14T00:00:00.000Z',
              runId: 'run-mcp',
              kind: 'tool',
              stage: 'tool:mcp__ding-doc__fetch',
              tool: 'mcp__ding-doc__fetch',
              toolUseId: 'call-1',
              isMcp: true,
              mcpServer: 'ding-doc',
              mcpAction: 'fetch',
              mcpTool: 'mcp__ding-doc__fetch'
            },
            {
              id: 'mcp-result',
              ts: '2026-07-14T00:00:01.000Z',
              runId: 'run-mcp',
              kind: 'tool',
              stage: 'tool_result',
              toolUseId: 'call-1',
              output: '{"success":true,"data":{"error":"正文中的普通字段"}}',
              isError: false
            }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    expect(mergeSessionTurns([], archive)[0].items[1]).toMatchObject({
      isMcp: true,
      mcpServer: 'ding-doc',
      isError: false
    })
  })

  it('恢复 archive 的运行身份与终止状态，供续跑时区分同文案的不同轮次', () => {
    const archive: TraceArchive = {
      version: 2,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'claude',
      turns: [
        {
          runId: 'interrupted-run',
          userText: '继续',
          items: [],
          done: true,
          error: 'Request interrupted by user',
          errorHint: '可以继续发送',
          ts: 1
        }
      ]
    }

    expect(mergeSessionTurns([], archive)[0]).toMatchObject({
      runId: 'interrupted-run',
      done: true,
      error: 'Request interrupted by user',
      errorHint: '可以继续发送'
    })
  })
})
