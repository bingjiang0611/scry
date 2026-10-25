import * as shared from './shared'
const { describe, it, expect, renderWelcome } = shared
type Turn = shared.Turn

describe('ChatView 改动摘要', () => {
  const sessionTurn: Turn = {
    runId: 'run-1',
    userText: '改两个文件',
    done: true,
    items: [
      {
        id: 'sd-1',
        ts: '2026-08-10T00:00:02.000Z',
        runId: 'run-1',
        kind: 'harness',
        stage: 'session_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files: [{ path: '/repo/src/a.ts', added: 4, deleted: 1 }],
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:02.000Z',
          captureMs: 9,
          cleanup: 'ok'
        }
      },
      {
        id: 'td-1',
        ts: '2026-08-10T00:00:03.000Z',
        runId: 'run-1',
        kind: 'harness',
        stage: 'turn_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files: [{ path: '/repo/src/b.ts', added: 7, deleted: 0 }],
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:03.000Z',
          captureMs: 9,
          cleanup: 'ok'
        }
      }
    ]
  }

  it('对话流不再展示重复的本会话改动卡', () => {
    const html = renderWelcome({ turns: [sessionTurn], busy: false, cwd: '/repo' })

    expect(html).not.toContain('本会话改动')
    expect(html).not.toContain('session-summary')
    expect(html).toContain('本轮改动')
  })
})