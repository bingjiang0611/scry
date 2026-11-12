import { describe, expect, it } from 'vitest'
import { parseTimingArgs } from '../b4s-startup-timing.mjs'
import { SCENARIOS, parseArgs } from '../b4v-scenarios.mjs'
import { modeEnv } from './app.mjs'
import { CASES, caseMode, startupTraceFromLog } from './startup.mjs'

describe('b4v command lines', () => {
  it('scenario runner: known scenarios only, explicit values', () => {
    expect(Object.keys(SCENARIOS)).toEqual(['close-app', 'reopen', 'sigkill', 'upgrade', 'quit-all', 'mutual-exclusion', 'trust-gate', 'renderer-isolation'])
    expect(parseArgs(['--only', 'reopen,sigkill', '--no-controls', '--quit-api', 'daemon.quit'])).toMatchObject({ only: ['reopen', 'sigkill'], noControls: true, quitApi: 'daemon.quit' })
    expect(() => parseArgs(['--only', 'nope'])).toThrow(/unknown scenario/)
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--fast'])).toThrow(/unknown argument/)
  })

  it('startup timing: bounded samples and known cases', () => {
    expect(parseTimingArgs([])).toMatchObject({ samples: 10, cases: CASES, maxLoad: 0.5 })
    expect(parseTimingArgs(['--samples', '3', '--cases', 'daemon-cold'])).toMatchObject({ samples: 3, cases: ['daemon-cold'] })
    expect(() => parseTimingArgs(['--samples', '0'])).toThrow(/samples/)
    expect(() => parseTimingArgs(['--cases', 'warm'])).toThrow(/cases/)
    expect(() => parseTimingArgs(['--max-load', '-1'])).toThrow(/max-load/)
  })

  it('the switch is explicit in both directions', () => {
    expect(modeEnv('daemon')).toMatchObject({ SCRY_HOST_DAEMON: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1', SCRY_REMOTE_HOST: '0' })
    expect(modeEnv('switch-off')).toMatchObject({ SCRY_HOST_DAEMON: '0', SCRY_REMOTE_HOST: '0' })
    expect(modeEnv('switch-off').SCRY_DAEMON_SMOKE_PROVIDER).toBeUndefined()
    expect(() => modeEnv('on')).toThrow(/unknown mode/)
    expect(caseMode('switch-off')).toBe('switch-off')
    expect(caseMode('daemon-running')).toBe('daemon')
  })

  it('reads the App startup trace from its log', () => {
    const log = [
      'noise',
      '[scry:perf] {"name":"app.startup","durationMs":812.5,"checkpoints":[{"stage":"ready","elapsedMs":300}]}',
      '[scry:perf] {"name":"other","durationMs":1}',
      '[scry:perf] {"torn'
    ].join('\n')
    expect(startupTraceFromLog(log)).toEqual({ totalMs: 812.5, checkpoints: { ready: 300 } })
    expect(startupTraceFromLog('nothing')).toBeNull()
  })
})
