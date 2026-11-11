import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import type { TerminalPtyFactory, TerminalPtyProcess } from '../main/terminal-manager'

afterEach(cleanupTempDirs)

// P3-terminal: the daemon runs the App's terminals with main's handlers. Output reaches
// the App as one feed notice plus a cursor read; the window's workspace comes with each
// call and is re-resolved here; shells do not outlive an App that stopped reading.

function echoPty() {
  const killed: number[] = []
  const factory: TerminalPtyFactory = {
    spawn: () => {
      let onData: ((data: string) => void) | undefined
      let onExit: ((event: { exitCode: number }) => void) | undefined
      const pid = 2_000 + killed.length
      const process: TerminalPtyProcess = {
        pid,
        onData: (listener: (data: string) => void) => { onData = listener; return { dispose: () => { onData = undefined } } },
        onExit: (listener: (event: { exitCode: number }) => void) => { onExit = listener; return { dispose: () => { onExit = undefined } } },
        write: (data: string) => { queueMicrotask(() => onData?.(data)) },
        resize: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        // The manager ends a PTY with destroy() when it has one, kill() otherwise.
        kill: () => { killed.push(pid); queueMicrotask(() => onExit?.({ exitCode: 0 })) },
        destroy: () => { killed.push(pid); queueMicrotask(() => onExit?.({ exitCode: 0 })) }
      } as unknown as TerminalPtyProcess
      return process
    }
  }
  return { factory, killed }
}

describe('daemon App terminal', () => {
  it('starts in the window workspace, streams output through the feed, and refuses an unknown one', async () => {
    const pty = echoPty()
    const daemon = await startTestDaemon({ terminal: { pty: pty.factory, inlineRecording: true, environment: async () => ({ SHELL: '/bin/sh' }) } })
    try {
      const handshake = await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
      // A real directory the daemon does not know: refused for that reason, not for being absent.
      const elsewhere = join(daemon.root, 'elsewhere')
      mkdirSync(elsewhere)
      const outside = await daemon.localOp('terminal', 'start', [{ cwd: elsewhere, cols: 80, rows: 24 }, elsewhere])
      expect(outside.error).toBeTruthy()
      expect(outside.error).not.toBe('unsupported_op')

      const started = await daemon.localOp('terminal', 'start', [{ cwd: daemon.workspace, cols: 80, rows: 24 }, daemon.workspace])
      expect(started.error).toBeUndefined()
      const { id, ownershipEpoch } = started.result as { id: string; ownershipEpoch: number }
      expect((await daemon.localOp('terminal', 'ready', [{ id, ownershipEpoch }, daemon.workspace])).result).toBe(true)
      expect((await daemon.localOp('terminal', 'write', [{ id, ownershipEpoch, data: 'echo hi' }, daemon.workspace])).result).toBe(true)
      // Stale ownership is refused exactly as main refuses it.
      expect((await daemon.localOp('terminal', 'write', [{ id, ownershipEpoch: ownershipEpoch + 7, data: 'x' }, daemon.workspace])).result).toBe(false)

      const notice = await daemon.request({ op: 'appEvents', epoch: handshake.events.epoch, cursor: handshake.events.cursor, waitMs: 1_000 })
      expect(notice.events.items).toContainEqual({ kind: 'terminal' })
      let text = ''
      let cursor: string | undefined
      for (let attempt = 0; attempt < 20 && !text.includes('echo hi'); attempt += 1) {
        const page = await daemon.request({ op: 'terminalFeed', method: 'read', ...(cursor ? { cursor } : {}) })
        expect(page.error).toBeUndefined()
        cursor = page.terminal.cursor
        for (const event of page.terminal.events) if (event.kind === 'data') text += event.events.map((item: { data: string }) => item.data).join('')
        if (!text.includes('echo hi')) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(text).toContain('echo hi')
      // Read past: the queue does not hand the same output twice.
      const again = await daemon.request({ op: 'terminalFeed', method: 'read', cursor })
      expect(again.terminal.events).toEqual([])

      // `active` takes no renderer argument; the window workspace still follows it.
      const active = await daemon.localOp('terminal', 'active', [daemon.workspace])
      expect((active.result as Array<{ id: string }>).map((session) => session.id)).toEqual([id])
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('ends the shells of an App that quit, and of one that stopped reading the feed', async () => {
    const pty = echoPty()
    const daemon = await startTestDaemon({ terminal: { pty: pty.factory, inlineRecording: true, environment: async () => ({ SHELL: '/bin/sh' }), reclaimAfterMs: 150, checkEveryMs: 25 } })
    try {
      await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
      const first = await daemon.localOp('terminal', 'start', [{ cwd: daemon.workspace, cols: 80, rows: 24 }, daemon.workspace])
      expect((await daemon.request({ op: 'terminalFeed', method: 'shutdown' })).terminal).toBe(true)
      expect(pty.killed).toHaveLength(1)
      expect((await daemon.localOp('terminal', 'active', [daemon.workspace])).result).toEqual([])
      expect(first.result).toBeTruthy()

      // A crashed App: nobody reads the feed any more.
      await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
      await daemon.localOp('terminal', 'start', [{ cwd: daemon.workspace, cols: 80, rows: 24 }, daemon.workspace])
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(pty.killed).toHaveLength(2)
      expect((await daemon.localOp('terminal', 'active', [daemon.workspace])).result).toEqual([])
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
