import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeWorkloads } from './performance-native.mjs'
import { assertDaemonSocketFits, benchAppEnv, benchEvidenceSources, benchModes, benchTempBase, parseBenchArguments } from './session-open-bench-mode.mjs'

describe('session-open bench mode', () => {
  it('measures the App with its daemon only; --daemon is accepted and changes nothing (S3)', () => {
    expect(benchModes).toEqual(['daemon'])
    expect(parseBenchArguments([], nativeWorkloads)).toEqual({ scenario: 'markdown', mode: 'daemon' })
    expect(parseBenchArguments(['paged'], nativeWorkloads)).toEqual({ scenario: 'paged', mode: 'daemon' })
    expect(parseBenchArguments(['short', '--daemon'], nativeWorkloads)).toEqual({ scenario: 'short', mode: 'daemon' })
    expect(parseBenchArguments(['--daemon', 'short-heavy'], nativeWorkloads)).toEqual({ scenario: 'short-heavy', mode: 'daemon' })
  })

  it('refuses what it does not understand instead of measuring the default', () => {
    expect(() => parseBenchArguments(['--mode=daemon'], nativeWorkloads)).toThrow('Unknown option')
    expect(() => parseBenchArguments(['--in-process'], nativeWorkloads)).toThrow('Unknown option')
    expect(() => parseBenchArguments(['huge'], nativeWorkloads)).toThrow('Unknown scenario')
    expect(() => parseBenchArguments(['short', 'paged'], nativeWorkloads)).toThrow('one scenario')
  })

  it('gives the daemon its smoke fixture and credential codec, and refuses the retired in-process mode', () => {
    const daemon = benchAppEnv('daemon', '/tmp/x/home')
    expect(daemon).toMatchObject({
      HOME: '/tmp/x/home', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1',
      SCRY_REMOTE_HOST: '0', SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_ELECTRON_SMOKE_PROVIDER: '1'
    })
    expect(daemon).not.toHaveProperty('SCRY_HOST_DAEMON')
    // Codex only, no side-chat/conversation sets.
    expect(daemon).not.toHaveProperty('SCRY_ELECTRON_SMOKE_SIDE_CHAT')
    expect(daemon).not.toHaveProperty('SCRY_ELECTRON_SMOKE_CONVERSATIONS')
    expect(() => benchAppEnv('in-process', '/tmp/x/home')).toThrow('Unknown bench mode')
    expect(() => benchAppEnv('remote', '/tmp/x/home')).toThrow('Unknown bench mode')
  })

  it('moves the daemon under a short temp root its sockets fit', () => {
    const macTmp = '/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T'
    expect(benchTempBase('daemon', macTmp)).toBe('/tmp')
    expect(() => assertDaemonSocketFits(join(macTmp, 'scry-session-open-AbC123', 'userData'))).toThrow('daemon_socket_path_too_long')
    expect(assertDaemonSocketFits(join('/private/tmp', 'scry-session-open-AbC123', 'userData'))).toMatch(/daemon\/enroll\.sock$/)
  })

  it('names where each proof comes from and reports missing counters as unavailable', () => {
    const daemon = benchEvidenceSources('daemon')
    expect(daemon.historyLoadTrace).toBe('ipc.agent:loadSession')
    expect(daemon.rejectedHistoryTrace).toBe('ipc.agent:loadSession')
    expect(daemon.historyLoadCounters.status).toBe('unavailable')
    expect(daemon.historyLoadCounters.reason).toMatch(/daemon/)
  })
})
