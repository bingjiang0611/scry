import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as io from './io'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { startSessionCapture } from './session-capture'
import type { SessionCaptureContext } from './session-capture-contract'

const failure = vi.hoisted(() => ({ mode: 'sync' as 'sync' | 'callback' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (async (path: unknown, ...rest: unknown[]) => {
      if (String(path) === '/proc') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      return (actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readdir
  }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_command: string, _args: string[], _options: unknown, callback?: (error: unknown) => void): never => {
      const error = Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1, syscall: 'spawn ps' })
      if (failure.mode === 'sync') throw error
      callback?.(error)
      return {} as never
    }
  }
})

const { hostProcessChain, hostProcessState, processTable } = await import('./host-process')

const roots: string[] = []
afterEach(async () => {
  failure.mode = 'sync'
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('sandboxed process table', () => {
  it.each(['sync', 'callback'] as const)('ps 启动失败（%s）返回 undefined，宿主状态是 unknown', async mode => {
    failure.mode = mode
    expect(await processTable()).toBeUndefined()
    expect(await hostProcessChain(process.pid)).toEqual([])
    expect(await hostProcessState([{ pid: process.pid }])).toBe('unknown')
  })

  it('capture start 不因 ps 被禁止而失败', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-capture-sandbox-')))
    roots.push(root)
    const transcriptPath = join(root, 'rollout.jsonl')
    const timestamp = '2026-11-17T12:00:00.000Z'
    await writeFile(transcriptPath, `${JSON.stringify({
      timestamp, type: 'session_meta', payload: { id: 'session', cwd: root }
    })}\n`)
    const context: SessionCaptureContext = {
      protocol: 'codelens.session-capture.v1', captureId: 'capture', sessionId: 'session',
      cwd: root, host: 'codex', transcriptPath, openedAt: timestamp, source: 'fixture', task: null
    }
    const result = await startSessionCapture({
      workspace: root, provider: 'codex', sessionId: 'session', dataDir: join(root, '.scry'),
      context, payload: { session_id: 'session', transcript_path: transcriptPath, timestamp },
      cli: {}, ancestryFromPid: process.ppid
    })
    expect(result.status).toBe('started')
    const open = await io.readJson<RecorderOpenTurnState>(recorderOpenPath(recorderSessionRoot(join(root, '.scry'), 'codex', 'session')))
    expect(open).toMatchObject({ generation: 1 })
    expect(open?.host).toBeUndefined()
  })
})
