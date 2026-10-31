import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface SpawnCall {
  command: string
  argv: readonly string[]
  options: { env?: NodeJS.ProcessEnv, stdio?: readonly string[] }
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

const ELECTRON = '/Applications/Scry.app/Contents/MacOS/Electron'
const SCRIPT = '/var/folders/14/scry capability ui/main-core.cjs'
const control = vi.hoisted(() => ({ calls: [] as SpawnCall[], child: undefined as unknown as FakeChild }))

vi.mock('node:child_process', () => ({
  spawn: (command: string, argv: readonly string[], options: SpawnCall['options']) => {
    control.calls.push({ command, argv, options })
    return control.child
  }
}))

import { runUiCampaign } from './ui-campaign.mjs'

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
}

// Space in the script path stays one argv element; the security flags are added by the campaign.
const campaign = () => runUiCampaign({
  electron: ELECTRON, script: SCRIPT, argv: ['--force-prefers-reduced-motion', '--scry-lists-campaign=refs'], env: { PATH: '/usr/bin', HOME: '/tmp/home' }
})

beforeEach(() => {
  vi.useFakeTimers()
  control.calls.length = 0
  control.child = undefined as unknown as FakeChild
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('bounded UI campaign', () => {
  it('passes the hidden-window Electron flags and resolves the reported result', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    expect(control.calls).toEqual([{
      command: ELECTRON,
      argv: [SCRIPT, '--disable-gpu', '--disable-backgrounding-occluded-windows', '--force-prefers-reduced-motion', '--scry-lists-campaign=refs'],
      options: { env: { PATH: '/usr/bin', HOME: '/tmp/home' }, stdio: ['ignore', 'pipe', 'pipe'] }
    }])
    child.stdout.emit('data', 'SCRY_UI_FIXTURE=file:///tmp/main-core.html\n')
    child.stdout.emit('data', 'SCRY_UI_SMOKE_RESULT={"selection":[1],"sessionTerminals":[2]}\n')
    child.emit('close', 0, null)
    await expect(pending).resolves.toEqual({ selection: [1], sessionTerminals: [2] })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects a clean exit that never reported a result', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    child.stdout.emit('data', 'SCRY_UI_FIXTURE=file:///tmp/session-terminal.html?scenario=pending\n')
    child.emit('close', 0, null)
    await expect(pending).rejects.toThrow(/timedOut=false; .*lastFixture=file:\/\/\/tmp\/session-terminal\.html\?scenario=pending/)
  })

  it('rejects a non-zero exit even when a result was printed', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    child.stdout.emit('data', 'SCRY_UI_SMOKE_RESULT={"selection":[1]}\n')
    child.emit('close', 1, null)
    await expect(pending).rejects.toThrow(/Hidden UI fixture failed \(1\)/)
  })

  it('keeps a campaign that hit the deadline failed when it afterwards exits cleanly', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    vi.advanceTimersByTime(30_000)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    child.stdout.emit('data', 'SCRY_UI_SMOKE_RESULT={"sessionTerminals":[2]}\n')
    child.emit('close', 0, null)
    await expect(pending).rejects.toThrow(/timedOut=true/)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('rejects an unparseable result instead of reporting success', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    child.stdout.emit('data', 'SCRY_UI_SMOKE_RESULT={"sessionTerminals":}\n')
    child.emit('close', 0, null)
    await expect(pending).rejects.toThrow(SyntaxError)
  })

  it('propagates the spawn error unchanged', async () => {
    const child = fakeChild()
    control.child = child
    const pending = campaign()
    const failure = new Error('spawn Electron ENOENT')
    child.emit('error', failure)
    await expect(pending).rejects.toBe(failure)
  })
})
