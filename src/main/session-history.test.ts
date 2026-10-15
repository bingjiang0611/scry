import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTraceArchiveAsync, readTraceArchivePageAsync, upsertTraceArchiveTurn, type TraceArchive } from './transcript-archive'
import {
  DEFAULT_SESSION_HISTORY_PAGE_SIZE,
  MAX_SESSION_HISTORY_PAGE_SIZE,
  hydrateSessionHistoryPage,
  mergeSessionTurns,
  readSessionHistoryAfterCompletedRuns,
  restoreTraceArchiveTurn,
  sessionHistoryPage,
  sessionArchiveIsPageable,
  type LoadedSessionTurn
} from './session-history'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('archive source paging', () => {
  it('Pi 的 turn-local enrichment 允许源级分页；Qoder 和 Claude transcript 保留原有路径', () => {
    expect(sessionArchiveIsPageable('pi', null)).toBe(true)
    expect(sessionArchiveIsPageable('codex', null)).toBe(true)
    expect(sessionArchiveIsPageable('claude', null)).toBe(true)
    expect(sessionArchiveIsPageable('qoder', null)).toBe(false)
    expect(sessionArchiveIsPageable('claude', '/transcript.jsonl')).toBe(false)
  })

  it('Pi 热索引只读请求页，逐页恢复所有旧轮次而不保留全会话 cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-pi-pages-'))
    roots.push(root)
    const args = { userDataDir: root, cwd: '/repo', sessionId: 'pi-session', providerId: 'pi' as const }
    for (let index = 0; index < 52; index++) {
      expect(upsertTraceArchiveTurn({ ...args, turn: {
        runId: `run-${index}`, userText: `task ${index}`, items: [], done: true, ts: index + 1
      } })).toBe(true)
    }
    const cold = await readTraceArchivePageAsync(args, { limit: 12 })
    expect(cold.totalTurns).toBe(52)
    expect(cold.archive?.turns).toHaveLength(12)
    const latest = await readTraceArchivePageAsync(args, { limit: 12 })
    expect(latest).toMatchObject({ offset: 40, totalTurns: 52, turnFilesRead: 12, readMode: 'indexed' })
    const older = await readTraceArchivePageAsync(args, { before: latest.offset, limit: 40, snapshotTotalTurns: 52 })
    expect(older).toMatchObject({ offset: 0, totalTurns: 52, hasOlder: false, turnFilesRead: 40, readMode: 'indexed' })
    expect([...older.archive!.turns, ...latest.archive!.turns].map(turn => turn.runId))
      .toEqual(Array.from({ length: 52 }, (_, index) => `run-${index}`))
  })
})

describe('session history terminal convergence', () => {
  it('restores an explicitly interrupted archive without losing its existing error or hint', () => {
    const turn = restoreTraceArchiveTurn({
      runId: 'stopped-before-native-entry', userText: '继续', items: [], done: true,
      status: 'interrupted', error: 'existing error', errorHint: 'existing hint', ts: 1
    })
    expect(turn.errorHint).toContain('本轮已中断，不代表任务完成。')
    expect(turn.errorHint).toContain('existing hint')
    expect(turn.error).toBe('existing error')
    expect(turn.items).toEqual([])
    expect(turn.providerTurnId).toBeUndefined()
  })

  it.each(['completed', 'failed', undefined] as const)('does not infer interruption from an empty archive with status %s', (status) => {
    const turn = restoreTraceArchiveTurn({ runId: 'empty', userText: '继续', items: [], done: true, status, ts: 1 })
    expect(turn.errorHint).toBeUndefined()
  })

  it.each([true, false])('reads the latest archived turn after terminal persistence (prior archive: %s)', async (hasPriorArchive) => {
    const root = mkdtempSync(join(tmpdir(), 'scry-history-settlement-'))
    roots.push(root)
    const args = { userDataDir: root, cwd: '/repo', sessionId: 'pi-session', providerId: 'pi' as const }
    const first = { runId: 'first-run', userText: 'first task', items: [], done: true, ts: 1 }
    if (hasPriorArchive) expect(upsertTraceArchiveTurn({ ...args, turn: first })).toBe(true)
    else expect(await readTraceArchiveAsync(args)).toBeNull()
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    const read = vi.fn(async () => {
      const archive = await readTraceArchiveAsync(args)
      return archive ? sessionHistoryPage(mergeSessionTurns([], archive)) : null
    })
    const loading = readSessionHistoryAfterCompletedRuns([{ done: true, settled }], new AbortController().signal, read)
    await Promise.resolve()
    let page
    try {
      expect(read).not.toHaveBeenCalled()
    } finally {
      expect(upsertTraceArchiveTurn({ ...args, turn: { ...first, runId: 'latest-run', userText: 'install it', ts: 2 } })).toBe(true)
      release()
      page = await loading
    }
    expect(read).toHaveBeenCalledOnce()
    expect(page?.turns.map((turn) => turn.runId)).toEqual(hasPriorArchive ? ['first-run', 'latest-run'] : ['latest-run'])
    expect(page?.turns.at(-1)?.userText).toBe('install it')
  })

  it('does not wait for an active run to finish before reading its prior history', async () => {
    const settled = new Promise<void>(() => {})
    const read = vi.fn(async () => 'prior history')
    await expect(readSessionHistoryAfterCompletedRuns([{ done: false, settled }], new AbortController().signal, read))
      .resolves.toBe('prior history')
    expect(read).toHaveBeenCalledOnce()
  })

  it('does not read or replace history after switching away during terminal convergence', async () => {
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    const controller = new AbortController()
    const read = vi.fn(async () => 'stale history')
    const loading = readSessionHistoryAfterCompletedRuns([{ done: true, settled }], controller.signal, read)
    controller.abort(new Error('session selection superseded'))
    release()
    await expect(loading).rejects.toThrow('session selection superseded')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('session history merge', () => {
  it('bounds legacy oversized tool history without mutating the source archive', () => {
    const output = `${'0123456789abcdef'.repeat(700_000)}LEGACY_TAIL`
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'legacy-large',
      providerId: 'pi',
      turns: [{
        runId: 'legacy-large-run',
        userText: 'inspect',
        items: [{
          id: 'legacy-large-result',
          ts: '2026-08-23T00:00:00.000Z',
          runId: 'legacy-large-run',
          kind: 'tool',
          stage: 'tool_result',
          toolUseId: 'large-call',
          output
        }],
        done: true,
        ts: 1
      }]
    }
    const original = archive.turns[0].items[0].output

    const [turn] = mergeSessionTurns([], archive)
    const item = turn.items[0]
    expect(Buffer.byteLength(item.output ?? '')).toBeLessThanOrEqual(8 * 1024)
    expect(item.outputContent).toMatchObject({ storage: 'truncated', reasons: ['field_budget'] })
    expect(item.output).not.toContain('LEGACY_TAIL')
    expect(archive.turns[0].items[0].output).toBe(original)
  })

  it('回放旧 Pi 归档时补齐小写文件工具语义', () => {
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'pi-session',
      providerId: 'pi',
      turns: [{
        runId: 'pi-run',
        providerTurnId: 'pi-user-entry',
        userText: 'inspect',
        items: [{
          id: 'pi-read',
          ts: '2026-08-23T00:00:00.000Z',
          runId: 'pi-run',
          kind: 'tool',
          stage: 'tool:read',
          tool: 'read',
          input: { path: '.claude/skills/rate-workflow/SKILL.md' }
        }],
        done: true,
        ts: 1
      }]
    }

    const [turn] = mergeSessionTurns([], archive)
    expect(turn).toMatchObject({ providerTurnId: 'pi-user-entry', forkTurnId: 'pi-user-entry' })
    expect(turn.items[0]).toMatchObject({
      fileOp: 'read',
      filePath: '.claude/skills/rate-workflow/SKILL.md'
    })
  })

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

  it('同一 run 的不同 result id 均保留，相同 id 才跨来源去重', () => {
    const shared = { id: 'shared', ts: '2026-08-01T00:00:01.000Z', runId: 'run-1', kind: 'harness' as const, stage: 'result', durationMs: 1_000 }
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'qoder',
      turns: [{
        runId: 'run-1',
        userText: 'inspect',
        items: [
          shared,
          { ...shared, id: 'continuation', ts: '2026-08-01T00:00:03.000Z', durationMs: 500 }
        ],
        done: true,
        ts: 1
      }]
    }

    const [turn] = mergeSessionTurns([{ userText: 'inspect', items: [shared] }], archive)
    expect(turn.items.filter((event) => event.kind === 'harness' && event.stage === 'result').map((event) => event.id))
      .toEqual(['shared', 'continuation'])
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

  it('先选历史页再 hydrate 附件，未显示轮次不进入 main 内存', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-history-page-'))
    roots.push(root)
    const userDataDir = join(root, 'userData')
    const attachment = (runId: string, value: string) => {
      const imageDir = join(userDataDir, 'attachments', runId)
      mkdirSync(imageDir, { recursive: true })
      const path = join(imageDir, '01-image.png')
      const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(value)])
      writeFileSync(path, bytes)
      return { path, bytes }
    }
    const old = attachment('run-old', 'old')
    const recent = attachment('run-recent', 'recent')
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'sess',
      providerId: 'claude',
      turns: [
        { runId: 'run-old', userText: `old\n\nScry pasted image attachments:\n1. 01-image.png (image/png, 3 B) local copy: ${old.path}`, items: [], done: true, ts: 1 },
        { runId: 'run-recent', userText: `recent\n\nScry pasted image attachments:\n1. 01-image.png (image/png, 6 B) local copy: ${recent.path}`, items: [], done: true, ts: 2 }
      ]
    }
    const transcript = [
      { userText: 'old', items: [] },
      { userText: 'recent', items: [] }
    ]
    const merged = mergeSessionTurns(transcript, archive, { userDataDir }, { hydrateAttachments: false })
    expect(merged.every((turn) => turn.attachments == null)).toBe(true)

    const page = hydrateSessionHistoryPage(sessionHistoryPage(merged, { limit: 1 }), transcript, archive, { userDataDir })
    expect(page.turns).toHaveLength(1)
    expect(page.turns[0].runId).toBe('run-recent')
    expect(page.turns[0].attachments?.[0].dataBase64).toBe(recent.bytes.toString('base64'))
    expect(merged.every((turn) => turn.attachments == null)).toBe(true)
  })

  it('重复 prompt 的 transcript 分页按全局序号恢复对应附件', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-history-duplicate-'))
    roots.push(root)
    const userDataDir = join(root, 'userData')
    const makePrompt = (runId: string, value: string): { prompt: string; bytes: Buffer } => {
      const directory = join(userDataDir, 'attachments', runId)
      mkdirSync(directory, { recursive: true })
      const path = join(directory, 'image.png')
      const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(value)])
      writeFileSync(path, bytes)
      return { prompt: `same\n\nScry pasted image attachments:\n1. image.png (image/png, 1 KB) local copy: ${path}`, bytes }
    }
    const old = makePrompt('old', 'old')
    const recent = makePrompt('recent', 'recent')
    const transcript = [
      { userText: old.prompt, items: [] },
      { userText: recent.prompt, items: [] }
    ]
    const merged = mergeSessionTurns(transcript, null, { userDataDir }, { hydrateAttachments: false })
    const oldPage = hydrateSessionHistoryPage(
      sessionHistoryPage(merged, { before: 1, limit: 1 }),
      transcript,
      null,
      { userDataDir }
    )
    expect(oldPage.offset).toBe(0)
    expect(oldPage.turns[0].attachments?.[0].dataBase64).toBe(old.bytes.toString('base64'))
    expect(oldPage.turns[0].attachments?.[0].dataBase64).not.toBe(recent.bytes.toString('base64'))
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

  it('同一 run 的迟到 session_diff 只保留最后一条，且与 turn_diff 共存', () => {
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
            { id: 'td', ts: '2026-07-14T00:00:01.000Z', runId: 'run-1', kind: 'harness', stage: 'turn_diff', turnDiff: snapshot(1) },
            { id: 'sd-old', ts: '2026-07-14T00:00:02.000Z', runId: 'run-1', kind: 'harness', stage: 'session_diff', turnDiff: snapshot(2) },
            { id: 'sd-new', ts: '2026-07-14T00:00:03.000Z', runId: 'run-1', kind: 'harness', stage: 'session_diff', turnDiff: snapshot(5) }
          ],
          done: true,
          ts: 1
        }
      ]
    }

    const turns = mergeSessionTurns([], archive)
    const sessionDiffs = turns[0].items.filter((item) => item.stage === 'session_diff')
    expect(sessionDiffs).toHaveLength(1)
    expect(sessionDiffs[0]).toMatchObject({ id: 'sd-new', turnDiff: { files: [{ added: 5 }] } })
    expect(turns[0].items.filter((item) => item.stage === 'turn_diff')).toHaveLength(1)
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


// 契约范围：sessionHistoryPage 只对「已经在内存里的权威轮次序列」做确定性切片。
// 它收窄的是 IPC 载荷与 renderer 挂载量，不减少 main 侧的解析开销或常驻内存。
describe('session history pagination contract (delivery slice only, not source-level paging)', () => {
  const history = (count: number): LoadedSessionTurn[] =>
    Array.from({ length: count }, (_unused, index) => ({
      runId: `run-${index}`,
      userText: `turn ${index}`,
      items: [{ id: `ev-${index}`, runId: `run-${index}`, ts: '', kind: 'model', stage: 'text', text: `t${index}` }],
      done: true
    }))

  it('默认只交付最近一页给 renderer，并显式标注仍有更早轮次', () => {
    const turns = history(500)
    const page = sessionHistoryPage(turns)
    expect(page.turns).toHaveLength(DEFAULT_SESSION_HISTORY_PAGE_SIZE)
    expect(page.offset).toBe(500 - DEFAULT_SESSION_HISTORY_PAGE_SIZE)
    expect(page.totalTurns).toBe(500)
    expect(page.hasOlder).toBe(true)
    expect(page.completeness).toBe('partial')
    // 最近优先且页内保持时间升序。
    expect(page.turns[0].runId).toBe('run-460')
    expect(page.turns.at(-1)?.runId).toBe('run-499')
  })

  it('相邻页严格相邻且能一直回溯到第一轮，不丢任何轮次', () => {
    const turns = history(95)
    const collected: LoadedSessionTurn[] = []
    let before: number | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = sessionHistoryPage(turns, { before, limit: 40 })
      expect(page.offset + page.turns.length).toBe(before ?? turns.length)
      collected.unshift(...page.turns)
      if (!page.hasOlder) {
        expect(page.offset).toBe(0)
        break
      }
      before = page.offset
    }
    expect(collected.map((turn) => turn.runId)).toEqual(turns.map((turn) => turn.runId))
  })

  it('小于一页的会话是 complete，没有更早轮次', () => {
    const page = sessionHistoryPage(history(3))
    expect(page).toMatchObject({ offset: 0, totalTurns: 3, hasOlder: false, completeness: 'complete' })
    expect(sessionHistoryPage([])).toMatchObject({ totalTurns: 0, hasOlder: false, completeness: 'complete' })
  })

  it('限制页大小并夹取越界 before，避免 renderer 传入任意值放大负载', () => {
    const turns = history(1000)
    expect(sessionHistoryPage(turns, { limit: 10_000 }).turns).toHaveLength(MAX_SESSION_HISTORY_PAGE_SIZE)
    expect(sessionHistoryPage(turns, { limit: 0 }).turns).toHaveLength(1)
    expect(sessionHistoryPage(turns, { limit: Number.NaN }).turns).toHaveLength(DEFAULT_SESSION_HISTORY_PAGE_SIZE)
    expect(sessionHistoryPage(turns, { before: 5_000, limit: 5 }).offset).toBe(995)
    expect(sessionHistoryPage(turns, { before: -3, limit: 5 })).toMatchObject({ offset: 0, turns: [] })
  })
})
