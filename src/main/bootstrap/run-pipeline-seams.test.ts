import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M2-3 locks the seams the run pipeline needs from Electron: notifications, the
// dock badge and shell actions. None of them may be reached directly from the
// pipeline; each is an injected function, so the daemon can supply its own or a
// no-op. This test is a boundary, not a behaviour check.
const BOOTSTRAP = resolve(__dirname)
const PIPELINE = [
  'run-execution.ts',
  'run-completion.ts',
  'run-admission.ts',
  'run-session.ts',
  'run-live-state.ts',
  'run-startup.ts',
  'run-failure.ts',
  'run-fork.ts',
  'run-remote-state.ts',
  'trace-runtime.ts'
]
const ASSEMBLY = '../../host-runtime/create-run-pipeline.ts'
const FORBIDDEN = [
  // M2-5: the pipeline may not hold the window itself. Reaching webContents or a
  // getWindow getter means the daemon (which has no window) silently drops error,
  // turnDone and session events; the BrowserWindow type is banned too so the
  // shortcut cannot creep back as a type-only import.
  /\bwebContents\b/,
  /\bgetWindow\b/,
  /\bBrowserWindow\b/,
  // Notifications, dock and shell are main's surface. A pipeline module that names
  // them has taken a decision the daemon cannot honour.
  /\bnew Notification\(/,
  /\bapp\.dock\b/,
  /\bshell\.(openPath|openExternal|showItemInFolder|trashItem)\b/,
  /\bNotification\.isSupported\b/
]

describe('run pipeline seams', () => {
  for (const entry of PIPELINE) {
    it(`${entry} reaches notifications, dock and shell only through injected functions`, () => {
      const source = readFileSync(resolve(BOOTSTRAP, entry), 'utf8')
      const hits = FORBIDDEN.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source)
      expect(hits).toEqual([])
    })
  }

  // The assembly entry must obey the same rule: it is what the daemon builds.
  it(`${ASSEMBLY} names no Electron effect either`, () => {
    const source = readFileSync(resolve(BOOTSTRAP, ASSEMBLY), 'utf8')
    expect(FORBIDDEN.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source)).toEqual([])
  })

  // The dock badge is the one shared piece: it must stay a callback-driven module so
  // it can run outside Electron.
  it('DockBadgeState takes its platform effect as a callback', () => {
    const source = readFileSync(resolve(BOOTSTRAP, '../dock-badge.ts'), 'utf8')
    expect(source).not.toMatch(/\bapp\.dock\b/)
    expect(source).toMatch(/private readonly apply|constructor\(/)
  })

  // Self-check: the pattern set must be able to detect the real thing.
  it('detects shell usage where it exists', () => {
    const workspace = readdirSync(BOOTSTRAP).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const offenders = workspace.filter((name) => FORBIDDEN.some((pattern) => pattern.test(readFileSync(resolve(BOOTSTRAP, name), 'utf8'))))
    expect(offenders.length).toBeGreaterThan(0)
  })
})
