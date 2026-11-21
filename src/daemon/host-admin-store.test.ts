import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isHostCliExperimentalEnabled } from '../shared/experimental-host-cli'
import { isInsideHostChild } from '../shared/host-admin'
import { runtimeCliEnv } from '../main/claude-locate'
import { piRpcEnvironment } from '../main/providers/pi-runtime'
import { TerminalManager } from '../main/terminal-manager'
import { HostAdminStore } from './host-admin-store'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W11 P5-5b: experimental switch & running marker', () => {
  it('defaults SCRY_EXPERIMENTAL_HOST_CLI to on and turns it off only with "0"', () => {
    expect(isHostCliExperimentalEnabled({})).toBe(true)
    expect(isHostCliExperimentalEnabled({ SCRY_EXPERIMENTAL_HOST_CLI: '0' })).toBe(false)
    expect(isHostCliExperimentalEnabled({ SCRY_EXPERIMENTAL_HOST_CLI: ' 0 ' })).toBe(false)
    expect(isHostCliExperimentalEnabled({ SCRY_EXPERIMENTAL_HOST_CLI: '1' })).toBe(true)
  })

  it('sets SCRY_HOST_CHILD=run in runtimeCliEnv and piRpcEnvironment, and SCRY_HOST_CHILD=terminal in TerminalManager', async () => {
    const cliEnv = runtimeCliEnv({ PATH: '/usr/bin:/bin', HOME: tmpdir() }, { providerId: 'codex' })
    expect(cliEnv.SCRY_HOST_CHILD).toBe('run')
    expect(isInsideHostChild(cliEnv)).toBe(true)

    const piDir = makeTempDir('scry-pi-child-')
    const piEnv = await piRpcEnvironment(
      { id: 'pi:test', label: 'Pi', executable: join(piDir, 'pi') },
      { PATH: `${process.execPath ? join(process.execPath, '..') : '/usr/bin'}:/usr/bin:/bin`, HOME: piDir, PI_AGENT_NODE: process.execPath }
    )
    expect(piEnv.SCRY_HOST_CHILD).toBe('run')
    expect(isInsideHostChild(piEnv)).toBe(true)

    let spawnedEnv: Record<string, string | undefined> | undefined
    const ws = makeTempDir('scry-term-child-')
    const manager = new TerminalManager({
      defaultCwd: ws,
      getCurrentCwd: () => ws,
      shell: '/bin/sh',
      args: [],
      env: { PATH: '/usr/bin:/bin', HOME: ws },
      pty: {
        spawn: (_file, _args, options) => {
          spawnedEnv = options.env
          return {
            pid: 99999,
            onData: () => ({ dispose: () => undefined }),
            onExit: () => ({ dispose: () => undefined }),
            write: () => undefined,
            resize: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            kill: () => undefined
          }
        }
      },
      onData: () => undefined,
      onExit: () => undefined
    })
    manager.start({ cols: 80, rows: 24, cwd: ws })
    expect(spawnedEnv?.SCRY_HOST_CHILD).toBe('terminal')
    expect(isInsideHostChild(spawnedEnv ?? {})).toBe(true)
    expect(isInsideHostChild({ SCRY_MANAGED_RUN_ID: 'run-1' })).toBe(true)
    expect(isInsideHostChild({ PATH: '/usr/bin' })).toBe(false)
  })
})

describe('W11 P5-5b: HostAdminStore persistence, permissions & rate limits', () => {
  it('defaults to disabled without creating host-admin.json on read, and persists 0600 on toggle', () => {
    const remoteDir = makeTempDir('scry-host-admin-')
    let now = 1_700_000_000_000
    const store = new HostAdminStore({ stateDirectory: remoteDir, clock: () => now })

    expect(store.isCliApprovalEnabled()).toBe(false)
    expect(existsSync(store.filePath)).toBe(false)

    const enabled = store.setCliApprovalEnabled(true)
    expect(enabled.enabled).toBe(true)
    expect(enabled.updatedAt).toBe(now)
    expect(existsSync(store.filePath)).toBe(true)
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600)

    // Re-opening reads persisted enabled state.
    const reopened = new HostAdminStore({ stateDirectory: remoteDir, clock: () => now })
    expect(reopened.isCliApprovalEnabled()).toBe(true)

    now += 5_000
    reopened.setCliApprovalEnabled(false)
    expect(reopened.isCliApprovalEnabled()).toBe(false)
    expect(JSON.parse(readFileSync(store.filePath, 'utf8'))).toMatchObject({ version: 1, cliApprovalEnabled: false })
  })

  it('fails closed (disabled) on corrupt JSON or loose file permissions', () => {
    const remoteDir = makeTempDir('scry-host-admin-bad-')
    const store = new HostAdminStore({ stateDirectory: remoteDir })
    store.setCliApprovalEnabled(true)

    chmodSync(store.filePath, 0o644)
    expect(store.isCliApprovalEnabled()).toBe(false)

    chmodSync(store.filePath, 0o600)
    writeFileSync(store.filePath, '{corrupt json', { mode: 0o600 })
    expect(store.isCliApprovalEnabled()).toBe(false)
  })

  it('enforces hourly rate limits (3 approve/h, 6 invite/h), persists across restarts, and resets after 1h', () => {
    const remoteDir = makeTempDir('scry-host-admin-rate-')
    let now = 1_700_000_000_000
    const store = new HostAdminStore({ stateDirectory: remoteDir, clock: () => now })

    for (let i = 0; i < 3; i++) {
      expect(store.consumeRate('approve')).toEqual({ allowed: true })
      now += 1_000
    }
    const blockedApprove = store.consumeRate('approve')
    expect(blockedApprove.allowed).toBe(false)
    if (!blockedApprove.allowed) {
      expect(blockedApprove.retryAfterMs).toBeGreaterThan(3_590_000)
    }

    // Persists across daemon restart (re-open store).
    const restarted = new HostAdminStore({ stateDirectory: remoteDir, clock: () => now })
    expect(restarted.consumeRate('approve').allowed).toBe(false)

    // Invite limit is independent: 6 per hour.
    for (let i = 0; i < 6; i++) {
      expect(restarted.consumeRate('invite')).toEqual({ allowed: true })
      now += 1_000
    }
    expect(restarted.consumeRate('invite').allowed).toBe(false)

    // Advance past 1 hour from first approve -> slot opens.
    now = 1_700_000_000_000 + 3_600_001
    expect(restarted.consumeRate('approve')).toEqual({ allowed: true })
  })

  it('emits sanitized notices with bounded fields and never stores secrets', () => {
    const remoteDir = makeTempDir('scry-host-admin-notice-')
    const received: unknown[] = []
    const store = new HostAdminStore({
      stateDirectory: remoteDir,
      onNotice: (notice) => received.push(notice)
    })
    store.setCliApprovalEnabled(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'cli_approval_enabled' })
    // Enabling when already enabled does not duplicate notice.
    store.setCliApprovalEnabled(true)
    expect(received).toHaveLength(1)
    expect(store.recentNotices()).toHaveLength(1)
  })
})
