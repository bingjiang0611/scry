import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  archivedTranscriptPath,
  cleanupTraceArchiveTemps,
  deleteTranscriptCopies,
  inferTraceArchiveProvider,
  legacyArchivedTranscriptPath,
  legacyScopedTraceArchivePath,
  legacyTraceArchivePath,
  mirrorTranscript,
  readTraceArchive,
  resolveTranscriptPath,
  traceArchiveRunIds,
  traceArchivePath,
  traceArchiveTurnPath,
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

function transcriptContent(cwd: string, sessionId: string): string {
  return `${JSON.stringify({ type: 'user', cwd, sessionId })}\n`
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('transcript archive mirror', () => {
  it('keeps opaque or traversal-like session ids inside every owned directory for read/write/delete', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/repo'
    const sessionId = '../../victim'
    const primary = transcriptPath(cwd, sessionId, home)
    const archived = archivedTranscriptPath(userDataDir, cwd, sessionId)
    const trace = traceArchivePath(userDataDir, cwd, sessionId, 'codex')
    expect(dirname(primary)).toBe(dirname(transcriptPath(cwd, 'safe', home)))
    expect(dirname(archived)).toBe(dirname(archivedTranscriptPath(userDataDir, cwd, 'safe')))
    expect(dirname(trace)).toBe(dirname(traceArchivePath(userDataDir, cwd, 'safe', 'codex')))

    const sentinel = join(root, 'victim.json')
    writeFileSync(sentinel, 'keep')
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'run-safe', userText: 'x', items: [], done: true }
    })).toBe(true)
    expect(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })?.sessionId).toBe(sessionId)
    expect(deleteTranscriptCopies({ cwd, sessionId, userDataDir, home, providerId: 'codex' }).failed).toEqual([])
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
  })

  it('每轮结束可把 Claude 原始 transcript mirror 到 app userData', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project.sample_workspace'
    const sessionId = 'sess-1'
    const content = transcriptContent(cwd, sessionId)
    writeTranscript(home, cwd, sessionId, content)

    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)
    const archived = archivedTranscriptPath(userDataDir, cwd, sessionId)
    expect(readFileSync(archived, 'utf8')).toBe(content)
  })

  it('加载历史时优先原始 transcript，原始丢失后 fallback 到 mirror', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-2'
    const content = transcriptContent(cwd, sessionId)
    const primary = writeTranscript(home, cwd, sessionId, content)
    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)

    expect(resolveTranscriptPath({ cwd, sessionId, userDataDir, home })).toBe(primary)
    unlinkSync(primary)

    const resolved = resolveTranscriptPath({ cwd, sessionId, userDataDir, home })
    expect(resolved).toBe(archivedTranscriptPath(userDataDir, cwd, sessionId))
    expect(readFileSync(resolved!, 'utf8')).toBe(content)
  })

  it('显式删除 Scry 会话副本时保留 Claude 原始 transcript，只删除 app mirror', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const cwd = '/Users/me/project'
    const sessionId = 'sess-3'
    const primary = writeTranscript(home, cwd, sessionId, transcriptContent(cwd, sessionId))
    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(true)
    const archived = archivedTranscriptPath(userDataDir, cwd, sessionId)

    deleteTranscriptCopies({ cwd, sessionId, userDataDir, home })
    expect(existsSync(primary)).toBe(true)
    expect(existsSync(archived)).toBe(false)
  })

  it('does not resolve or mirror a native Claude transcript whose encoded cwd belongs to another workspace', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'userData')
    const firstCwd = '/repo/a/b'
    const collidingCwd = '/repo/a_b'
    const sessionId = 'sess-collision'
    const primary = writeTranscript(home, collidingCwd, sessionId, transcriptContent(collidingCwd, sessionId))

    expect(transcriptPath(firstCwd, sessionId, home)).toBe(primary)
    expect(resolveTranscriptPath({ cwd: firstCwd, sessionId, userDataDir, home })).toBeNull()
    expect(mirrorTranscript({ cwd: firstCwd, sessionId, userDataDir, home })).toBe(false)
    expect(resolveTranscriptPath({ cwd: collidingCwd, sessionId, userDataDir, home })).toBe(primary)
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
    const segment = traceArchiveTurnPath(userDataDir, cwd, sessionId, 'codex', { runId: 'run-1' })
    expect(existsSync(segment)).toBe(true)

    deleteTranscriptCopies({ cwd, sessionId, userDataDir, home: join(root, 'home'), providerId: 'codex' })
    expect(existsSync(segment)).toBe(false)
  })

  it('Scry-owned cwd key 不会把 slash 与 underscore 路径合并或跨目录删除', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const sessionId = 'same-session'
    const cwdA = '/a/b'
    const cwdB = '/a_b'
    expect(traceArchivePath(userDataDir, cwdA, sessionId, 'codex')).not.toBe(
      traceArchivePath(userDataDir, cwdB, sessionId, 'codex')
    )
    expect(archivedTranscriptPath(userDataDir, cwdA, sessionId)).not.toBe(
      archivedTranscriptPath(userDataDir, cwdB, sessionId)
    )
    expect(traceArchivePath(userDataDir, '/repo/a/../b', sessionId, 'codex')).not.toBe(
      traceArchivePath(userDataDir, '/repo/b', sessionId, 'codex')
    )
    const unsafeSessionId = '../../victim'
    const encodedLiteral = `opaque-${createHash('sha256').update(unsafeSessionId).digest('hex')}`
    expect(traceArchivePath(userDataDir, cwdA, unsafeSessionId, 'codex')).not.toBe(
      traceArchivePath(userDataDir, cwdA, encodedLiteral, 'codex')
    )
    expect(archivedTranscriptPath(userDataDir, cwdA, unsafeSessionId)).not.toBe(
      archivedTranscriptPath(userDataDir, cwdA, encodedLiteral)
    )
    for (const [cwd, runId] of [[cwdA, 'run-a'], [cwdB, 'run-b']] as const) {
      expect(upsertTraceArchiveTurn({
        cwd,
        sessionId,
        providerId: 'codex',
        userDataDir,
        turn: { runId, userText: runId, items: [], done: true }
      })).toBe(true)
    }

    expect(deleteTranscriptCopies({ cwd: cwdA, sessionId, userDataDir, providerId: 'codex' }).failed).toEqual([])
    expect(readTraceArchive({ cwd: cwdA, sessionId, userDataDir, providerId: 'codex' })).toBeNull()
    expect(readTraceArchive({ cwd: cwdB, sessionId, userDataDir, providerId: 'codex' })?.turns[0].runId).toBe('run-b')
  })

  it('明确属于其他 cwd 的 legacy copy 跳过，损坏 copy 保留并报告 partial failure', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const sessionId = 'legacy-collision'
    const cwdA = '/a/b'
    const cwdB = '/a_b'
    const legacy = legacyScopedTraceArchivePath(userDataDir, cwdB, sessionId, 'codex')
    expect(legacy).toBe(legacyScopedTraceArchivePath(userDataDir, cwdA, sessionId, 'codex'))
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      version: 3,
      cwd: cwdB,
      sessionId,
      providerId: 'codex',
      turns: [{ runId: 'run-b', userText: 'b', items: [], done: true, ts: 1 }]
    }))

    const collision = deleteTranscriptCopies({ cwd: cwdA, sessionId, userDataDir, providerId: 'codex' })
    expect(collision.failed).toEqual([])
    expect(existsSync(legacy)).toBe(true)

    writeFileSync(legacy, '{broken')
    const corrupt = deleteTranscriptCopies({ cwd: cwdB, sessionId, userDataDir, providerId: 'codex' })
    expect(corrupt.failed).toEqual([{ path: legacy, error: expect.stringContaining('corrupt') }])
    expect(existsSync(legacy)).toBe(true)
  })

  it('legacy transcript mirror 只有携带精确 cwd/session 身份时才参与 fallback 和删除', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/legacy'
    const sessionId = 'legacy-transcript'
    const legacy = legacyArchivedTranscriptPath(userDataDir, cwd, sessionId)
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, `${JSON.stringify({ type: 'user', cwd, sessionId })}\n`)
    expect(resolveTranscriptPath({ cwd, sessionId, userDataDir, home: join(root, 'empty-home') })).toBe(legacy)
    expect(deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'claude' }).failed).toEqual([])
    expect(existsSync(legacy)).toBe(false)
  })

  it('损坏或身份冲突的旧 monolith 不覆盖原字节，也不阻塞新的独立 segment', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/current'
    const sessionId = 'current-corrupt'
    const fp = traceArchivePath(userDataDir, cwd, sessionId, 'codex')
    mkdirSync(dirname(fp), { recursive: true })
    for (const raw of [
      '{broken',
      JSON.stringify({ version: 3, cwd: '/other', sessionId, providerId: 'codex', turns: [] })
    ]) {
      writeFileSync(fp, raw)
      expect(upsertTraceArchiveTurn({
        cwd,
        sessionId,
        providerId: 'codex',
        userDataDir,
        turn: { runId: 'new', userText: 'new', items: [], done: true }
      })).toBe(true)
      expect(readFileSync(fp, 'utf8')).toBe(raw)
      expect(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })?.turns)
        .toEqual([expect.objectContaining({ runId: 'new' })])
    }
  })

  it('逐段隔离 corrupt/schema-invalid sibling，保留合法历史并允许继续写入与删除', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/segmented-corruption'
    const sessionId = 'segmented-corruption'
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'good', userText: 'good', items: [], done: true }
    })).toBe(true)
    const corrupt = traceArchiveTurnPath(userDataDir, cwd, sessionId, 'codex', { runId: 'corrupt' })
    mkdirSync(dirname(corrupt), { recursive: true })
    writeFileSync(corrupt, JSON.stringify({ version: 3, cwd, sessionId, providerId: 'codex', turns: [null] }))

    expect(() => readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })).not.toThrow()
    expect(traceArchiveRunIds({ cwd, sessionId, userDataDir, providerId: 'codex' })).toEqual(['good'])
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'new', userText: 'new', items: [], done: true }
    })).toBe(true)
    expect(new Set(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })?.turns.map((turn) => turn.runId)))
      .toEqual(new Set(['good', 'new']))

    const deletion = deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'codex' })
    expect(deletion.failed).toEqual([{ path: corrupt, error: expect.stringContaining('schema') }])
    expect(existsSync(corrupt)).toBe(false)
  })

  it('deletion and single-instance startup cleanup remove orphan per-turn crash temps without a final segment', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/temp-only'
    const sessionId = 'temp-only'
    const temp = `${traceArchiveTurnPath(userDataDir, cwd, sessionId, 'codex', { runId: 'orphan' })}.tmp`
    mkdirSync(dirname(temp), { recursive: true })
    writeFileSync(temp, 'sensitive partial turn')

    expect(deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'codex' }).failed).toEqual([])
    expect(existsSync(temp)).toBe(false)

    writeFileSync(temp, 'another partial turn')
    cleanupTraceArchiveTemps(userDataDir)
    expect(existsSync(temp)).toBe(false)
  })

  it('首次写 hashed archive 会合并 Claude 两代 legacy 与 current 的全部 runId', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/migrate'
    const sessionId = 'merge-history'
    const writeArchive = (path: string, label: string, providerId?: 'claude'): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({
        version: 3,
        cwd,
        sessionId,
        ...(providerId ? { providerId } : {}),
        turns: [
          { runId: label, userText: label, items: [], done: true, ts: label === 'old' ? 1 : 2 },
          { runId: 'shared', userText: label, items: [], done: true, ts: 3 }
        ]
      }))
    }
    writeArchive(legacyTraceArchivePath(userDataDir, cwd, sessionId), 'old')
    writeArchive(legacyScopedTraceArchivePath(userDataDir, cwd, sessionId, 'claude'), 'scoped', 'claude')
    writeArchive(traceArchivePath(userDataDir, cwd, sessionId, 'claude'), 'current', 'claude')

    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'claude',
      userDataDir,
      turn: { runId: 'new', userText: 'new', items: [], done: true }
    })).toBe(true)
    const archive = readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'claude' })!
    expect(new Set(archive.turns.map((turn) => turn.runId))).toEqual(new Set(['old', 'scoped', 'current', 'shared', 'new']))
    expect(archive.turns.find((turn) => turn.runId === 'shared')?.userText).toBe('current')
  })

  it('混合 Provider 身份的 legacy archive 不参与推断且删除返回 partial', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/mixed-provider'
    const sessionId = 'mixed-provider'
    const fp = legacyScopedTraceArchivePath(userDataDir, cwd, sessionId, 'codex')
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(fp, JSON.stringify({
      version: 3,
      cwd,
      sessionId,
      providerId: 'codex',
      runtimeProvider: 'claude_sdk',
      turns: []
    }))
    expect(inferTraceArchiveProvider(JSON.parse(readFileSync(fp, 'utf8')))).toBeUndefined()
    const result = deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'codex' })
    expect(result.failed).toEqual([{ path: fp, error: expect.stringContaining('conflicting Provider') }])
    expect(existsSync(fp)).toBe(true)
  })

  it('legacy monolith 到达 500 轮后用 per-turn segment 继续写入且不会重写旧文件', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo/bounded-archive'
    const sessionId = 'bounded-archive'
    const fp = traceArchivePath(userDataDir, cwd, sessionId, 'codex')
    mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(fp, JSON.stringify({
      version: 3,
      cwd,
      sessionId,
      providerId: 'codex',
      turns: Array.from({ length: 500 }, (_, index) => ({
        runId: `run-${index}`,
        userText: `turn ${index}`,
        items: [],
        done: true,
        ts: index
      }))
    }))
    const before = readFileSync(fp, 'utf8')
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'run-overflow', userText: 'overflow', items: [], done: true }
    })).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe(before)
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'run-overflow-2', userText: 'overflow 2', items: [], done: true }
    })).toBe(true)
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'run-499', userText: 'updated', items: [], done: true }
    })).toBe(true)
    const archive = readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })
    expect(archive?.turns).toHaveLength(502)
    expect(archive?.turns.find((turn) => turn.runId === 'run-499')?.userText).toBe('updated')
  })

  it('treats provider-less legacy archives as Claude-only during read and deletion', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo'
    const sessionId = 'shared-session-id'
    const legacy = legacyTraceArchivePath(userDataDir, cwd, sessionId)
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      cwd,
      sessionId,
      turns: [{ runId: 'run-legacy', userText: 'old', items: [], done: true, ts: 1 }]
    }))

    expect(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'claude' })?.turns).toHaveLength(1)
    expect(readTraceArchive({ cwd, sessionId, userDataDir, providerId: 'codex' })).toBeNull()
    expect(traceArchiveRunIds({ cwd, sessionId, userDataDir, providerId: 'codex' })).toEqual([])
    deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'codex' })
    expect(existsSync(legacy)).toBe(true)
    deleteTranscriptCopies({ cwd, sessionId, userDataDir, providerId: 'claude' })
    expect(existsSync(legacy)).toBe(false)
  })

  it('rejects symlinked Scry-owned archive and transcript parents for writes and deletion', () => {
    const root = tempRoot()
    const external = tempRoot()
    const userDataDir = join(root, 'userData')
    const home = join(root, 'home')
    const cwd = '/repo'
    const sessionId = 'sess-link'
    mkdirSync(userDataDir, { recursive: true })
    mkdirSync(join(external, 'trace-target'), { recursive: true })
    mkdirSync(join(external, 'transcript-target'), { recursive: true })
    writeFileSync(join(external, 'trace-target', 'marker.txt'), 'keep')
    writeFileSync(join(external, 'transcript-target', 'marker.txt'), 'keep')
    symlinkSync(join(external, 'trace-target'), join(userDataDir, 'trace-archive-turns-v1'))
    symlinkSync(join(external, 'transcript-target'), join(userDataDir, 'transcripts'))
    writeTranscript(home, cwd, sessionId, transcriptContent(cwd, sessionId))

    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: { runId: 'run-link', userText: 'x', items: [], done: true }
    })).toBe(false)
    expect(mirrorTranscript({ cwd, sessionId, userDataDir, home })).toBe(false)
    const deletion = deleteTranscriptCopies({ cwd, sessionId, userDataDir, home, providerId: 'codex' })
    expect(deletion.failed.some((failure) => failure.error.includes('not trusted'))).toBe(true)
    expect(readFileSync(join(external, 'trace-target', 'marker.txt'), 'utf8')).toBe('keep')
    expect(readFileSync(join(external, 'transcript-target', 'marker.txt'), 'utf8')).toBe('keep')
  })

  it('v3 archive persists a controlled blob id without base64 or absolute attachment paths', () => {
    const root = tempRoot()
    const userDataDir = join(root, 'userData')
    const cwd = '/repo'
    const runId = 'run-blob'
    const sessionId = 'sess-blob'
    const dir = join(userDataDir, 'attachments', runId)
    const path = join(dir, '01-screen.png')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, Buffer.from('blob bytes'))
    expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId: 'codex',
      userDataDir,
      turn: {
        runId,
        userText: 'inspect',
        attachments: [{
          kind: 'image',
          name: '01-screen.png',
          mimeType: 'image/png',
          dataBase64: 'dW5pcXVlLWJhc2U2NC1tYXJrZXI=',
          path
        }],
        items: [],
        done: true
      }
    })).toBe(true)
    const raw = readFileSync(traceArchiveTurnPath(userDataDir, cwd, sessionId, 'codex', { runId }), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      version: 3,
      turns: [{ attachments: [{ storage: 'blob', blobId: '01-screen.png' }] }]
    })
    expect(raw).not.toContain('dW5pcXVlLWJhc2U2NC1tYXJrZXI=')
    expect(raw).not.toContain(userDataDir)
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
    expect(readFileSync(traceArchiveTurnPath(userDataDir, cwd, sessionId, 'codex', { runId: 'run-diff' }), 'utf8')).toContain('-old')
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
