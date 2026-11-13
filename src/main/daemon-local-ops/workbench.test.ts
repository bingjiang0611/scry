import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gateDaemonChannel, installDaemonRequestForwarder } from '../daemon-channel-gate'
import { DaemonRunTransport } from '../daemon-run-transport'
import { laneForRequest, laneOutcomeUnknown, replayableRequest } from '../remote/desktop-lane'
import { DESKTOP_WORKBENCH_READ_METHODS } from '../../shared/desktop-workbench'
import { WORKBENCH_FORWARDS, installWorkbenchWindowCwd } from './workbench'

// The App's workbench channels in daemon mode: each builds the `desktopWorkbench` request
// paired devices already send, bound to what main's in-process handler was bound to, and
// maps the reply back to what that handler returned.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const rows = (JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'daemon-ipc-routing-workbench.json'), 'utf8')) as {
  channels: Array<{ channel: string; route: string; op: string; surface: string; method: string }>
}).channels.filter((row) => row.route === 'forward')
const WINDOW = '/projects/app'
const REPO = 'a'.repeat(64)
const OPERATION = { id: 'op-1', repositoryId: REPO, action: 'stage', status: 'succeeded', startedAt: 1, message: 'ok' }
const REPOSITORY = { status: 'available', data: { id: REPO, root: WINDOW, revision: 'r', files: [], remotes: [], actionBlockers: {}, writeBlocker: null } }

// Channels this lane leaves refused: the terminal needs a push design (see the B4-L4
// workbench status note). openExternal and trash are routed `main` (the daemon has no
// shell) and run in process; bootstrap/workspace-daemon.test.ts covers them.
const REFUSED = new Set(rows.filter((row) => row.surface === 'terminal').map((row) => row.channel))

type Query = { surface: string; cwd: string; method: string; args: unknown[] }
function built(channel: string, args: unknown[]): { op: string; query: Query } {
  return WORKBENCH_FORWARDS[channel]!.request(args) as { op: string; query: Query }
}

describe('workbench forwards', () => {
  const undo: Array<() => void> = []
  afterEach(() => { for (const step of undo.splice(0)) step() })

  it('forwards every workspace and source-control row of the matrix, and only those', () => {
    const forwarded = rows.filter((row) => !REFUSED.has(row.channel)).map((row) => row.channel).sort()
    expect(Object.keys(WORKBENCH_FORWARDS).sort()).toEqual(forwarded)
    expect(forwarded).toHaveLength(19)
  })

  it('builds the matrix surface and method, bound to the window workspace', () => {
    undo.push(installWorkbenchWindowCwd(() => WINDOW))
    for (const row of rows.filter((item) => item.surface === 'workspace' && !REFUSED.has(item.channel))) {
      const request = { cwd: WINDOW, path: 'a.txt' }
      expect(built(row.channel, [request, 'ignored'])).toEqual({
        op: 'desktopWorkbench', query: { surface: 'workspace', cwd: WINDOW, method: row.method, args: [request] }
      })
    }
  })

  it('refuses a workspace call before sending when the window has no workspace', () => {
    undo.push(installWorkbenchWindowCwd(() => undefined))
    expect(() => built('workspace:write', [{ cwd: WINDOW, path: 'a.txt', content: '', expectedRevision: 'r' }])).toThrow('未授权工作区文件访问')
  })

  it('routes source control to the workspace the repository was read from', async () => {
    undo.push(installWorkbenchWindowCwd(() => WINDOW))
    // Before a read, a repository id names nothing this window has seen: the in-process
    // service answers the same way, so the renderer re-reads instead of guessing a cwd.
    expect(() => built('sourceControl:operations', [{ repositoryId: REPO }])).toThrow('仓库引用已过期，请重新读取工作区')
    const read = built('sourceControl:read', ['/projects/other'])
    expect(read).toEqual({ op: 'desktopWorkbench', query: { surface: 'sourceControl', cwd: '/projects/other', method: 'read', args: ['/projects/other'] } })
    expect(WORKBENCH_FORWARDS['sourceControl:read']!.result!({ workbench: REPOSITORY }, ['/projects/other'])).toEqual(REPOSITORY)
    for (const row of rows.filter((item) => item.surface === 'sourceControl' && item.method !== 'read')) {
      const query = built(row.channel, [{ repositoryId: REPO, extra: 1 }]).query
      expect(query, row.channel).toEqual({ surface: 'sourceControl', cwd: '/projects/other', method: row.method, args: [{ repositoryId: REPO, extra: 1 }] })
    }
    expect(() => built('sourceControl:read', [42])).toThrow()
  })

  it('marks only calls that change nothing as replayable, and sends writes on the workbench write lane', () => {
    undo.push(installWorkbenchWindowCwd(() => WINDOW))
    WORKBENCH_FORWARDS['sourceControl:read']!.result!({ workbench: REPOSITORY }, [WINDOW])
    for (const [channel, entry] of Object.entries(WORKBENCH_FORWARDS)) {
      const request = built(channel, [channel === 'sourceControl:read' ? WINDOW : { cwd: WINDOW, repositoryId: REPO }])
      const read = DESKTOP_WORKBENCH_READ_METHODS.has(request.query.method)
      expect(entry.read, channel).toBe(read)
      expect(replayableRequest(request), channel).toBe(read)
      expect(laneForRequest(request), channel).toBe(read ? 'bulk' : 'workbench')
    }
    expect(WORKBENCH_FORWARDS['workspace:write']!.read).toBe(false)
    expect(WORKBENCH_FORWARDS['sourceControl:mutate']!.read).toBe(false)
  })

  it('returns what the in-process handler returned, and refuses a reply of the wrong shape', () => {
    undo.push(installWorkbenchWindowCwd(() => WINDOW))
    const entry = WORKBENCH_FORWARDS['sourceControl:mutate']!
    expect(entry.result!({ workbench: OPERATION }, [{ repositoryId: REPO }])).toEqual(OPERATION)
    expect(() => entry.result!({ workbench: { id: 'op-1' } }, [{ repositoryId: REPO }])).toThrow('invalid_desktop_workbench_response')
    expect(() => entry.result!({}, [{ repositoryId: REPO }])).toThrow('invalid_desktop_workbench_response')
    // main's save handlers resolve with nothing; the wire carries that as null.
    expect(WORKBENCH_FORWARDS['sourceControl:saveDraft']!.result!({ workbench: null }, [{ repositoryId: REPO }])).toBeUndefined()
    expect(WORKBENCH_FORWARDS['sourceControl:loadDraft']!.result!({ workbench: null }, [{ repositoryId: REPO }])).toBeNull()
    const entries = { entries: [{ name: 'a.txt', path: 'a.txt', kind: 'file', mtimeMs: 1 }], truncated: false }
    expect(WORKBENCH_FORWARDS['workspace:list']!.result!({ workbench: entries }, [{ cwd: WINDOW, path: '' }])).toEqual(entries)
  })

  it('sends a write once through the gate and reports a lost reply as unknown, never replayed', async () => {
    undo.push(installWorkbenchWindowCwd(() => WINDOW))
    const sent: Array<{ request: Record<string, unknown>; replayable?: boolean }> = []
    const transport = new DaemonRunTransport(async (request, options) => {
      sent.push({ request, ...(options?.replayable !== undefined ? { replayable: options.replayable } : {}) })
      throw laneOutcomeUnknown(new Error('reply lost'))
    })
    undo.push(installDaemonRequestForwarder((request, read) => transport.forward(request, read)))
    const listener = vi.fn()
    const gated = gateDaemonChannel('workspace:write', listener, ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
    await expect(gated({}, { cwd: WINDOW, path: 'a.txt', content: 'x', expectedRevision: 'r' })).rejects.toMatchObject({ reason: 'daemon_outcome_unknown' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.replayable).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the terminal a named absence and the shell operations in process', async () => {
    undo.push(installDaemonRequestForwarder(vi.fn(async () => ({ workbench: true }))))
    for (const channel of REFUSED) {
      const listener = vi.fn()
      const gated = gateDaemonChannel(channel, listener, ON) as unknown as (event: unknown, ...args: unknown[]) => unknown
      expect(() => gated({}, { cwd: WINDOW, path: 'a.txt' })).toThrow(`daemon_capability_unavailable:${channel}`)
      expect(listener).not.toHaveBeenCalled()
    }
    for (const channel of ['workspace:openExternal', 'workspace:trash']) {
      expect(WORKBENCH_FORWARDS[channel], channel).toBeUndefined()
      const listener = vi.fn()
      expect(gateDaemonChannel(channel, listener, ON)).toBe(listener)
    }
  })
})
