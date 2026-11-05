import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { completeTurn, payload, workspace } from './recorder-tests/fixture.test'
import { recorderHasOpenTurn } from './runtime-state'
import { safeKey } from './store'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await workspace()
  roots.push(root)
  vi.stubEnv('HOME', join(root, 'isolated-home'))
  vi.stubEnv('XDG_STATE_HOME', join(root, 'isolated-state'))
  return root
}

const dataRoot = (root: string): string => join(root, '.scry')
const attentionDir = (root: string): string => join(dataRoot(root), 'runtime', 'attention')
const sessionDir = (root: string, sessionId: string): string => join(dataRoot(root), 'runtime', 'claude', safeKey(sessionId))

async function markers(root: string): Promise<string[]> {
  return readdir(attentionDir(root)).catch(() => [])
}

describe('recorder attention index', () => {
  it('indexes an open turn and drops the entry once the turn commits', async () => {
    const root = await fixture()
    const sessionId = 'indexed-turn'
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt: 'implement feature' }) })

    expect(await markers(root)).toEqual([`claude__${safeKey(sessionId)}`])
    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(true)

    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }) })

    expect(await markers(root)).toEqual([])
    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(false)
  })

  it('drops a marker whose turn is gone instead of reporting it as an open turn', async () => {
    const root = await fixture()
    const sessionId = 'crashed-before-open'
    await mkdir(attentionDir(root), { recursive: true })
    await mkdir(sessionDir(root, sessionId), { recursive: true })
    // What a crash between the index write and the open.json write leaves behind.
    await writeFile(join(attentionDir(root), `claude__${safeKey(sessionId)}`), '')

    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(false)
    await recoverRecorder(root)
    expect(await markers(root)).toEqual([])
  })

  it('rebuilds an absent index from the session directories', async () => {
    const root = await fixture()
    const sessionId = 'pre-index-turn'
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt: 'legacy workspace' }) })
    // Simulates a workspace written by a recorder without the index.
    await rm(attentionDir(root), { recursive: true, force: true })

    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(true)
    expect(await markers(root)).toEqual([`claude__${safeKey(sessionId)}`])
  })

  it('indexes a queued hook and releases it after replay', async () => {
    const root = await fixture()
    const sessionId = 'queued-hook'
    const inbox = join(sessionDir(root, sessionId), 'inbox')
    await mkdir(inbox, { recursive: true })
    await writeFile(join(inbox, `${String(Date.now() - 1_000).padStart(15, '0')}-queued.json`), JSON.stringify({
      schemaVersion: 1,
      provider: 'claude',
      sessionId,
      event: 'UserPromptSubmit',
      payload: payload(sessionId, { prompt: 'delivered while the daemon was uncertain' }),
      arrivedAt: new Date().toISOString()
    }))

    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(true)
    await recoverRecorder(root)

    // Replaying the queued start opens the turn, so the session stays indexed for its terminal hook.
    expect(await readdir(inbox)).toEqual([])
    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(true)
    expect(await markers(root)).toEqual([`claude__${safeKey(sessionId)}`])

    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }) })

    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(false)
    expect(await markers(root)).toEqual([])
  })

  it('keeps counting an unreachable sidecar as pending without keeping a pass running', async () => {
    const root = await fixture()
    const sessionId = 'unreadable-sidecar'
    const failed = join(sessionDir(root, sessionId), 'inbox-failed')
    await mkdir(failed, { recursive: true })
    const name = `${String(Date.now() - 1_000).padStart(15, '0')}-broken.json`
    await writeFile(join(failed, name), JSON.stringify({
      schemaVersion: 1, provider: 'claude', sessionId, event: 'Stop',
      payload: payload(sessionId), arrivedAt: new Date().toISOString()
    }))
    await mkdir(attentionDir(root), { recursive: true })
    await writeFile(join(attentionDir(root), `claude__${safeKey(sessionId)}`), '')
    // Metadata that cannot be read is evidence, not retryable work.
    await writeFile(join(failed, `${name}.failure.json`), '{ not json')

    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(false)
    await recoverRecorder(root)
    // The pass runs because the entry is indexed, and the entry is not silently dropped.
    expect(await readdir(failed)).toContain(name)
    expect(await markers(root)).toEqual([`claude__${safeKey(sessionId)}`])
  })

  it('commits a turn that starts from the rebuilt index', async () => {
    const root = await fixture()
    await rm(attentionDir(root), { recursive: true, force: true })
    await completeTurn(root, 'complete-after-rebuild')
    await rm(attentionDir(root), { recursive: true, force: true })

    await recoverRecorder(root)
    expect(await markers(root)).toEqual([])
    await expect(recorderHasOpenTurn(dataRoot(root))).resolves.toBe(false)
  })
})
