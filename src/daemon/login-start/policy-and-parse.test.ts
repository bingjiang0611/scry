import { describe, expect, it } from 'vitest'
import {
  LOGIN_START_POLICY_ENV_KEYS,
  collectLoginStartPolicyEnv,
  computeEffectiveRemoteConfig,
  diffRemoteConfigs,
  loginStartTargetFromBundle,
  loginStartTemplateInput,
  parseLaunchdPlist,
  parseSystemdUnit,
  resolveLoginStartOverrides
} from './index'
import { renderLaunchdPlist, renderSystemdUnit } from '../supervisor-templates'

describe('login-start policy env validation and effective remote config', () => {
  it('collects valid non-secret policy env vars and ignores diagnostic/removed vars', () => {
    const result = collectLoginStartPolicyEnv({
      SCRY_REMOTE_HOST: '1',
      SCRY_REMOTE_PERMISSION_MODE: 'auto_accept_edits',
      SCRY_REMOTE_RELAY_ENABLED: '0',
      SCRY_DISABLED_PROVIDERS: 'Codex, pi',
      SCRY_RUN_CONTROLS: '0',
      SCRY_PROVIDER_MANIFEST_URL: 'https://example.com/manifest.json',
      SCRY_REMOTE_RELAY_SSH: 'ignored',
      SCRY_DAEMON_SMOKE_PROVIDER: '1',
      SCRY_RUN_TIMING: '1',
      PATH: '/usr/bin'
    })
    expect(result).toEqual({
      ok: true,
      entries: [
        ['SCRY_REMOTE_HOST', '1'],
        ['SCRY_REMOTE_PERMISSION_MODE', 'auto_accept_edits'],
        ['SCRY_REMOTE_RELAY_ENABLED', '0'],
        ['SCRY_DISABLED_PROVIDERS', 'codex,pi'],
        ['SCRY_RUN_CONTROLS', '0'],
        ['SCRY_PROVIDER_MANIFEST_URL', 'https://example.com/manifest.json']
      ]
    })
    expect(LOGIN_START_POLICY_ENV_KEYS).toEqual([
      'SCRY_REMOTE_HOST',
      'SCRY_REMOTE_PERMISSION_MODE',
      'SCRY_REMOTE_RELAY_ENABLED',
      'SCRY_DISABLED_PROVIDERS',
      'SCRY_RUN_CONTROLS',
      'SCRY_PROVIDER_MANIFEST_URL'
    ])
  })

  it('refuses enabling when SCRY_REMOTE_RELAY_WS is present (contains token)', () => {
    const result = collectLoginStartPolicyEnv({
      SCRY_REMOTE_RELAY_WS: JSON.stringify({ url: 'wss://relay.example', token: 'secret-token' })
    })
    expect(result).toEqual({ ok: false, reason: 'login_start_secret_env' })
  })

  it('rejects invalid policy env values and credentials in manifest URL', () => {
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_HOST: 'yes' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_HOST'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_PERMISSION_MODE: 'root' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_PERMISSION_MODE'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_RELAY_ENABLED: 'true' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_RELAY_ENABLED'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_DISABLED_PROVIDERS: 'codex,unknown' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_DISABLED_PROVIDERS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_DISABLED_PROVIDERS: '   ' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_DISABLED_PROVIDERS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_RUN_CONTROLS: 'false' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_RUN_CONTROLS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_PROVIDER_MANIFEST_URL: 'http://example.com/m.json' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_PROVIDER_MANIFEST_URL'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_PROVIDER_MANIFEST_URL: 'https://user:pass@example.com/m.json' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_PROVIDER_MANIFEST_URL'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_PROVIDER_MANIFEST_URL: 'https://example.com/a\nb' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_PROVIDER_MANIFEST_URL'
    })
  })

  it('computes and diffs effective non-secret remote config', () => {
    const a = computeEffectiveRemoteConfig({
      SCRY_REMOTE_HOST: '1',
      SCRY_REMOTE_PERMISSION_MODE: 'auto_review',
      SCRY_DISABLED_PROVIDERS: 'pi, codex',
      SCRY_RUN_CONTROLS: '0',
      SCRY_PROVIDER_MANIFEST_URL: 'https://example.com/a.json'
    }, true)
    expect(a).toEqual({
      remoteHostEnabled: true,
      relayMode: 'public',
      permissionModeOverride: 'auto_review',
      disabledProviders: ['codex', 'pi'],
      runControlsEnabled: false,
      providerManifestUrl: 'https://example.com/a.json'
    })
    const b = computeEffectiveRemoteConfig({
      SCRY_REMOTE_RELAY_WS: '{"url":"wss://r.example","token":"t"}',
      SCRY_DISABLED_PROVIDERS: 'codex,pi'
    }, true)
    expect(b.relayMode).toBe('custom_ws')
    expect(diffRemoteConfigs(a, b)).toEqual([
      'relayMode', 'permissionModeOverride', 'runControlsEnabled', 'providerManifestUrl'
    ])
  })
})

describe('login-start bundle layout parity, parsing, and test-only overrides', () => {
  it('renders byte-for-byte identical plist and systemd unit from main inputs and CLI bundle layout', () => {
    const macMain = loginStartTemplateInput({
      executable: '/Applications/Scry.app/Contents/MacOS/Scry',
      appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Scry.app/Contents/Resources',
      userDataDir: '/Users/me/Library/Application Support/Scry',
      isPackaged: true
    }, { policyEnv: [['SCRY_REMOTE_HOST', '1']] })
    const macCli = loginStartTemplateInput(
      loginStartTargetFromBundle('/Applications/Scry.app/Contents/MacOS/Scry', '/Users/me/Library/Application Support/Scry', 'darwin'),
      { policyEnv: [['SCRY_REMOTE_HOST', '1']] }
    )
    expect(renderLaunchdPlist(macCli)).toBe(renderLaunchdPlist(macMain))

    const linuxMain = loginStartTemplateInput({
      executable: '/opt/Scry/scry',
      appPath: '/opt/Scry/resources/app.asar',
      resourcesPath: '/opt/Scry/resources',
      userDataDir: '/home/me/.config/Scry',
      isPackaged: true
    }, { policyEnv: [['SCRY_DISABLED_PROVIDERS', 'pi']] })
    const linuxCli = loginStartTemplateInput(
      loginStartTargetFromBundle('/opt/Scry/scry', '/home/me/.config/Scry', 'linux'),
      { policyEnv: [['SCRY_DISABLED_PROVIDERS', 'pi']] }
    )
    expect(renderSystemdUnit(linuxCli)).toBe(renderSystemdUnit(linuxMain))
  })

  it('strictly parses rendered plist and systemd unit with spaces, Chinese, % and $, and rejects foreign files', () => {
    const awkward = '/Users/测试/项目 a&b<c>"q"\\x 100%$HOME'
    const input = loginStartTemplateInput({
      executable: `${awkward}/Scry.app/Contents/MacOS/Scry`,
      appPath: `${awkward}/Scry.app/Contents/Resources/app.asar`,
      resourcesPath: `${awkward}/Scry.app/Contents/Resources`,
      userDataDir: `${awkward}/userData`,
      isPackaged: true
    }, {
      policyEnv: [
        ['SCRY_REMOTE_HOST', '1'],
        ['SCRY_REMOTE_PERMISSION_MODE', 'auto_accept_edits']
      ]
    })

    const plist = renderLaunchdPlist(input)
    const parsedPlist = parseLaunchdPlist(plist, 'com.scry.daemon')
    expect(parsedPlist).toEqual({
      kind: 'ours',
      label: 'com.scry.daemon',
      executable: input.executable,
      supervisorEntry: input.supervisorEntry,
      daemonEntry: input.daemonEntry,
      appPath: input.appPath,
      resourcesPath: input.resourcesPath,
      userDataDir: input.userDataDir,
      policyEnv: [
        { key: 'SCRY_REMOTE_HOST', value: '1' },
        { key: 'SCRY_REMOTE_PERMISSION_MODE', value: 'auto_accept_edits' }
      ]
    })
    expect(parseLaunchdPlist(plist, 'com.scry.daemon.other')).toEqual({ kind: 'foreign' })
    expect(parseLaunchdPlist('<plist><dict><key>Label</key><string>com.scry.daemon</string></dict></plist>', 'com.scry.daemon')).toEqual({ kind: 'foreign' })

    const unit = renderSystemdUnit(input)
    const parsedUnit = parseSystemdUnit(unit)
    expect(parsedUnit).toEqual({
      kind: 'ours',
      executable: input.executable,
      supervisorEntry: input.supervisorEntry,
      daemonEntry: input.daemonEntry,
      appPath: input.appPath,
      resourcesPath: input.resourcesPath,
      userDataDir: input.userDataDir,
      policyEnv: [
        { key: 'SCRY_REMOTE_HOST', value: '1' },
        { key: 'SCRY_REMOTE_PERMISSION_MODE', value: 'auto_accept_edits' }
      ]
    })
    expect(parseSystemdUnit('[Unit]\n# com.scry.daemon\n[Service]\nExecStart=/bin/true\n')).toEqual({ kind: 'foreign' })
  })

  it('ignores test-only overrides outside SCRY_TEST_APP=1 and refuses overriding production label', () => {
    expect(resolveLoginStartOverrides({
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon.test.1',
      SCRY_TEST_LOGIN_START_DIR: '/tmp/fake'
    }, 'darwin')).toEqual({
      isTestInstance: false,
      testOverrideActive: false,
      label: 'com.scry.daemon',
      unitName: 'scry-daemon.service'
    })

    expect(resolveLoginStartOverrides({
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon'
    }, 'darwin')).toEqual({
      isTestInstance: true,
      testOverrideActive: false,
      label: 'com.scry.daemon',
      unitName: 'scry-daemon.service'
    })

    expect(resolveLoginStartOverrides({
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon.test.42',
      SCRY_TEST_LOGIN_START_DIR: '/tmp/launch-agents'
    }, 'darwin')).toEqual({
      isTestInstance: true,
      testOverrideActive: true,
      label: 'com.scry.daemon.test.42',
      unitName: 'scry-daemon.service',
      serviceDirOverride: '/tmp/launch-agents'
    })
  })
})
