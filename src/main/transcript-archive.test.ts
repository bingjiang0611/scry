import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  archivedTranscriptPath,
  deleteTranscriptCopies,
  mirrorTranscript,
  readTraceArchive,
  resolveTranscriptPath,
  traceArchivePath,
  transcriptPath,
  upsertTraceArchiveTurn
} from './transcript-archive'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-transcript-'))
  roots.push(root)
  return root
}

function writeTranscript(home: string, cwd: string, sessionId: string, content: string): string {
  const fp = transcriptPath(cwd, sessionId, home)
  mkdirSync(dirname(fp), { recursive: true })
  writeFileSync(fp, content)
  return fp
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('transcript archive mirror', () => {
  it('每轮结束可把 Claude 原始 transcript mirror 到 app userData', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project.sample_workspace'
    const sessionId = 'sess-1'
    writeTranscript(home, cwd, sessionId, '{"type":"user"}\n')

    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)
    const archived = archivedTranscriptPath(userDataDir, cwd, sessionId)
    expect(readFileSync(archived, 'utf8')).toBe('{"type":"user"}\n')
  })

  it('加载历史时优先原始 transcript，原始丢失后 fallback 到 mirror', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-2'
    const primary = writeTranscript(home, cwd, sessionId, 'primary\n')
    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)

    expect(resolveTranscriptPath({ cwd, sessionId, userDataDir, home })).toBe(primary)
    unlinkSync(primary)

    const resolved = resolveTranscriptPath({ cwd, sessionId, userDataDir, home })
    expect(resolved).toBe(archivedTranscriptPath(userDataDir, cwd, sessionId))
    expect(readFileSync(resolved!, 'utf8')).toBe('primary\n')
  })

  it('显式删除会话时同时删除原始 transcript 和 app mirror', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-3'
    const primary = writeTranscript(home, cwd, sessionId, 'x\n')
    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)
    const archived = archivedTranscriptPath(userDataDir, cwd, sessionId)

    deleteTranscriptCopies({ cwd, sessionId, userDataDir, home })
    expect(existsSync(primary)).toBe(false)
    expect(existsSync(archived)).toBe(false)
  })

  it('完整 TraceEvent archive 按 session 持久化并按 runId 覆盖同一轮', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-trace'
    const ok = upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      userDataDir,
      turn: {
        runId: 'run-1',
        userText: 'hello',
        done: true,
        items: [{ id: 'e1', ts: '', runId: 'run-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash' }]
      }
    })
    expect(ok).toBe(true)
    expect(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })?.turns).toHaveLength(1)

    upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      userDataDir,
      turn: {
        runId: 'run-1',
        userText: 'hello again',
        done: true,
        items: [{ id: 'e2', ts: '', runId: 'run-1', kind: 'hook', stage: 'hook_response', hookOutcome: 'success' }]
      }
    })

    const archive = readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })
    expect(archive?.turns).toHaveLength(1)
    expect(archive?.turns[0].userText).toBe('hello again')
    expect(archive?.turns[0].items[0]).toMatchObject({ id: 'e2', kind: 'hook' })
    expect(existsSync(traceArchivePath(userDataDir, cwd, sessionId, 'codex'))).toBe(true)

    deleteTranscriptCopies({ cwd, sessionId, userDataDir, home: join(root, 'home'), providerId: 'codex' })
    expect(existsSync(traceArchivePath(userDataDir, cwd, sessionId, 'codex'))).toBe(false)
  })

  it('archive 保留已限长的 patch，使历史 Review 与实时会话一致', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-transient-diff'
    expect(
      upsertTraceArchiveTurn({
        cwd,
        sessionId,
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        userDataDir,
        turn: {
          runId: 'run-diff',
          userText: 'edit',
          done: true,
          items: [
            {
              id: 'diff',
              ts: '2026-07-16T00:00:00.000Z',
              runId: 'run-diff',
              kind: 'harness',
              stage: 'turn_diff',
              turnDiff: {
                version: 1,
                status: 'captured',
                files: [
                  {
                    path: '/repo/a.ts',
                    added: 1,
                    deleted: 1,
                    patch: '-old\n+new\n',
                    patchStatus: 'captured'
                  }
                ],
                beforeAt: 'a',
                afterAt: 'b',
                captureMs: 5,
                cleanup: 'ok'
              }
            }
          ]
        }
      })
    ).toBe(true)

    const file = readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })!.turns[0].items[0].turnDiff!.files[0]
    expect(file).toEqual({
      path: '/repo/a.ts',
      added: 1,
      deleted: 1,
      patch: '-old\n+new\n',
      patchStatus: 'captured'
    })
    expect(readFileSync(traceArchivePath(userDataDir, cwd, sessionId, 'codex'), 'utf8')).toContain('-old')
  })

  it('损坏的 turn_diff archive 降级为 failed，合法文件行做非负整数清洗', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-diff-corrupt'
    const fp = traceArchivePath(userDataDir, cwd, sessionId, 'codex')
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(
      fp,
      JSON.stringify({
        version: 2,
        cwd,
        sessionId,
        providerId: 'codex',
        turns: [
          {
            runId: 'run-1',
            userText: 'x',
            done: true,
            ts: 1,
            items: [
              {
                id: 'diff-1',
                ts: '2026-07-14T00:00:00.000Z',
                runId: 'run-1',
                kind: 'harness',
                stage: 'turn_diff',
                turnDiff: {
                  version: 1,
                  status: 'captured',
                  files: [
                    {
                      path: '/repo/a.ts',
                      added: 2.8,
                      deleted: 1,
                      patch: '-old\n+new\n',
                      patchStatus: 'captured'
                    },
                    {
                      path: '/repo/b.ts',
                      added: 1,
                      deleted: 0,
                      patchStatus: 'truncated'
                    },
                    { path: '/repo/c.png', added: 0, deleted: 0, binary: true, patchStatus: 'binary' }
                  ],
                  beforeAt: 'a',
                  afterAt: 'b',
                  captureMs: 5,
                  cleanup: 'ok'
                }
              },
              {
                id: 'diff-2',
                ts: '2026-07-14T00:00:01.000Z',
                runId: 'run-2',
                kind: 'harness',
                stage: 'turn_diff',
                turnDiff: { status: 'captured', files: 'bad' }
              }
            ]
          }
        ]
      })
    )

    const items = readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })!.turns[0].items
    expect(items[0].turnDiff).toMatchObject({
      status: 'captured',
      files: [
        { path: '/repo/a.ts', added: 2, deleted: 1, patch: '-old\n+new\n', patchStatus: 'captured' },
        { path: '/repo/b.ts', added: 1, deleted: 0 },
        { path: '/repo/c.png', added: 0, deleted: 0, binary: true, patchStatus: 'binary' }
      ]
    })
    expect(items[1].turnDiff).toMatchObject({ status: 'failed', reason: 'git_error', files: [], cleanup: 'failed' })
  })
})
