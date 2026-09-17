import {
  chmodSync, existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync, writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRecordingStore } from './terminal-recording'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), writeSync: vi.fn(fs.writeSync) }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const roots: string[] = []
afterEach(() => {
  vi.mocked(writeSync).mockReset().mockImplementation(fs.writeSync)
  vi.mocked(fsyncSync).mockReset().mockImplementation(fs.fsyncSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-terminal-recording-'))
  roots.push(cwd)
  const directory = join(cwd, 'recordings')
  const failure = vi.fn()
  const store = new TerminalRecordingStore(directory, failure)
  const id = `terminal-${randomUUID()}`
  store.start({ id, cwd, cols: 80, rows: 24, pid: 1 })
  return { cwd, directory, id, store, failure }
}
function finish(store: TerminalRecordingStore, id: string) { store.finish({ id, code: 0, signal: null }) }

describe('terminal raw recording', () => {
  it('replays more than 16 MiB in bounded pages from a cold store, including raw credentials and ANSI', () => {
    const { cwd, directory, id, store } = fixture()
    const text = `${'x'.repeat(1024 * 1024)}\u001b[31m中😀 token=SYNTHETIC_RAW_SECRET\u001b[0m\n`
    for (let i = 0; i < 17; i++) store.append(id, text)
    finish(store, id)
    const cold = new TerminalRecordingStore(directory, () => {})
    const pages: string[] = []
    let offset = 0
    do {
      const page = cold.read({ id, offset }, cwd)
      expect(page.state).toBe('complete')
      expect(page.nextOffset - offset).toBeLessThanOrEqual(64 * 1024)
      expect(page.encoding).toBe('utf16le')
      pages.push(page.data)
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (true)
    expect(pages.join('')).toBe(text.repeat(17))
    expect(offset).toBe(Buffer.byteLength(text.repeat(17), 'utf16le'))
  })

  it('retains split surrogate callbacks and does not split a pair at a page boundary', () => {
    const { cwd, id, store } = fixture()
    store.append(id, 'a\ud83d')
    store.append(id, '\ude00中')
    finish(store, id)
    const first = store.read({ id, offset: 0, limit: 4 }, cwd)
    expect(first.data).toBe('a')
    const second = store.read({ id, offset: first.nextOffset, limit: 4 }, cwd)
    expect(second.data).toBe('😀')
    expect(store.read({ id, offset: second.nextOffset, limit: 4 }, cwd).data).toBe('中')
  })

  it('treats an open checkpoint as interrupted on cold read, not a successful exit', () => {
    const { cwd, directory, id, store } = fixture()
    store.append(id, 'checkpoint')
    expect(store.read({ id, offset: 0 }, cwd).state).toBe('recording')
    const cold = new TerminalRecordingStore(directory, () => {})
    expect(cold.read({ id, offset: 0 }, cwd)).toMatchObject({ state: 'interrupted', data: 'checkpoint' })
    store.finish({ id, code: null, signal: null })
    expect(cold.read({ id, offset: 0 }, cwd).state).toBe('interrupted')
  })

  it('does not retry uncertain body writes, and exposes capture failure without throwing to the producer', () => {
    const { cwd, directory, id, store, failure } = fixture()
    vi.mocked(writeSync).mockImplementationOnce((fd) => {
      fs.writeSync(fd, Buffer.from([1, 2, 3]))
      throw new Error('disk_full')
    })
    expect(() => store.append(id, 'unknown body')).not.toThrow()
    store.append(id, 'never retried')
    expect(writeSync).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledTimes(1)
    finish(store, id)
    const cold = new TerminalRecordingStore(directory, () => {})
    expect(cold.read({ id, offset: 0 }, cwd)).toMatchObject({ state: 'failed', data: '', totalBytes: 0 })
  })

  it('reports fsync failure and never advertises unsynced bytes as complete', () => {
    const { cwd, id, store, failure } = fixture()
    store.append(id, 'body')
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('sync failed') })
    expect(store.read({ id, offset: 0 }, cwd)).toMatchObject({ state: 'failed', data: '' })
    expect(failure).toHaveBeenCalledOnce()
    finish(store, id)
  })

  it('can cold-read a synced exit checkpoint when directory sync and the failure marker both fail', () => {
    const { cwd, directory, id, store, failure } = fixture()
    store.append(id, 'all received output')
    let renamed = false
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) renamed = true
      if (renamed) throw new Error('directory sync and subsequent metadata sync failed')
      fs.fsyncSync(fd)
    })
    finish(store, id)
    expect(failure).toHaveBeenCalledOnce()
    // The visible checkpoint includes a confirmed native exit and already-fsynced body.
    // If its rename survives, cold reads can prove complete content despite the sync warning.
    const cold = new TerminalRecordingStore(directory, () => {})
    expect(cold.read({ id, offset: 0 }, cwd)).toMatchObject({ state: 'complete', data: 'all received output' })
  })

  it('authorizes by current workspace and rejects active deletion and invalid cursors', () => {
    const { cwd, directory, id, store } = fixture()
    expect(() => store.read({ id, offset: 0 }, '/different')).toThrow('workspace_mismatch')
    expect(() => store.delete(id, cwd)).toThrow('still_active')
    for (const request of [{ id: '../escape', offset: 0 }, { id, offset: -2 }, { id, offset: 1 }, { id, offset: 0, limit: 3 }, { id, offset: 0, limit: 262146 }]) {
      expect(() => store.read(request, cwd)).toThrow()
    }
    finish(store, id)
    expect(() => store.delete(id, '/different')).toThrow('workspace_mismatch')
    expect(existsSync(join(directory, `${id}.bin`))).toBe(true)
    store.delete(id, cwd)
    expect(existsSync(join(directory, `${id}.bin`))).toBe(false)
    expect(existsSync(join(directory, `${id}.json`))).toBe(false)
  })

  it.each(['symlink', 'short', 'metadata', 'permissions'] as const)('fails closed for %s corruption', (kind) => {
    const { cwd, directory, id, store } = fixture()
    store.append(id, 'original')
    finish(store, id)
    const body = join(directory, `${id}.bin`)
    if (kind === 'symlink') {
      rmSync(body)
      symlinkSync(join(directory, `${id}.json`), body)
    }
    if (kind === 'short') writeFileSync(body, '')
    if (kind === 'metadata') writeFileSync(join(directory, `${id}.json`), '{}')
    if (kind === 'permissions') chmodSync(body, 0o644)
    expect(() => store.read({ id, offset: 0 }, cwd)).toThrow()
  })

  it('stores a private committed prefix and leaves no growing in-memory body queue', () => {
    const { cwd, directory, id, store } = fixture()
    store.append(id, 'captured')
    expect(store.read({ id, offset: 0 }, cwd).data).toBe('captured')
    expect(JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8')).bytes).toBe(16)
    expect(fs.statSync(join(directory, `${id}.bin`)).mode & 0o777).toBe(0o600)
    finish(store, id)
  })
})
