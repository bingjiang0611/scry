import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeWorkloads } from './performance-native.mjs'
import { assertDaemonSocketFits, benchAppEnv, benchEvidenceSources, benchTempBase, parseBenchArguments } from './session-open-bench-mode.mjs'

describe('session-open bench mode', () => {
  it('defaults to the in-process gate and selects daemon mode only by an explicit flag', () => {
    expect(parseBenchArguments([], nativeWorkloads)).toEqual({ scenario: 'markdown', mode: 'in-process' })
    expect(parseBenchArguments(['paged'], nativeWorkloads)).toEqual({ scenario: 'paged', mode: 'in-process' })
    expect(parseBenchArguments(['short', '--daemon'], nativeWorkloads)).toEqual({ scenario: 'short', mode: 'daemon' })
    expect(parseBenchArguments(['--daemon', 'short-heavy'], nativeWorkloads)).toEqual({ scenario: 'short-heavy', mode: 'daemon' })
  })

  it('refuses what it does not understand instead of measuring the default', () => {
    expect(() => parseBenchArguments(['--mode=daemon'], nativeWorkloads)).toThrow('Unknown option')
    expect(() => parseBenchArguments(['huge'], nativeWorkloads)).toThrow('Unknown scenario')
    expect(() => parseBenchArguments(['short', 'paged'], nativeWorkloads)).toThrow('one scenario')
  })

  it('spells the daemon switch out in both modes, so an exported shell value cannot flip the gate', () => {
    const inProcess = benchAppEnv('in-process', '/tmp/x/home')
    expect(inProcess).toMatchObject({ HOME: '/tmp/x/home', SCRY_HOST_DAEMON: '0', SCRY_REMOTE_HOST: '0', SCRY_ELECTRON_SMOKE_PROVIDER: '1' })
    expect(inProcess).not.toHaveProperty('SCRY_DAEMON_SMOKE_PROVIDER')
    expect(inProcess).not.toHaveProperty('SCRY_DAEMON_CREDENTIAL_PLAINTEXT')
    const daemon = benchAppEnv('daemon', '/tmp/x/home')
    expect(daemon).toMatchObject({
      HOME: '/tmp/x/home', SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1',
      SCRY_REMOTE_HOST: '0', SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi'
    })
    // Same offline fixture set in both modes: Codex only, no side-chat/conversation sets.
    for (const env of [inProcess, daemon]) {
      expect(env).not.toHaveProperty('SCRY_ELECTRON_SMOKE_SIDE_CHAT')
      expect(env).not.toHaveProperty('SCRY_ELECTRON_SMOKE_CONVERSATIONS')
    }
    expect({ ...inProcess, SCRY_HOST_DAEMON: undefined }).toEqual({ ...daemon, SCRY_HOST_DAEMON: undefined, SCRY_DAEMON_SMOKE_PROVIDER: undefined, SCRY_DAEMON_CREDENTIAL_PLAINTEXT: undefined })
    expect(() => benchAppEnv('remote', '/tmp/x/home')).toThrow('Unknown bench mode')
  })

  it('keeps the gate temp root and moves the daemon under a short one its sockets fit', () => {
    const macTmp = '/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T'
    expect(benchTempBase('in-process', macTmp)).toBe(macTmp)
    expect(benchTempBase('daemon', macTmp)).toBe('/tmp')
    expect(() => assertDaemonSocketFits(join(macTmp, 'scry-session-open-AbC123', 'userData'))).toThrow('daemon_socket_path_too_long')
    expect(assertDaemonSocketFits(join('/private/tmp', 'scry-session-open-AbC123', 'userData'))).toMatch(/daemon\/enroll\.sock$/)
  })

  it('names where each daemon-mode proof comes from and reports missing counters as unavailable', () => {
    expect(benchEvidenceSources('in-process')).toEqual({
      historyLoadTrace: 'session_history.load', historyLoadCounters: { status: 'available' }, rejectedHistoryTrace: 'session_history.load'
    })
    const daemon = benchEvidenceSources('daemon')
    expect(daemon.historyLoadTrace).toBe('ipc.agent:loadSession')
    expect(daemon.rejectedHistoryTrace).toBe('ipc.agent:loadSession')
    expect(daemon.historyLoadCounters.status).toBe('unavailable')
    expect(daemon.historyLoadCounters.reason).toMatch(/daemon/)
  })
})
