import { describe, expect, it } from 'vitest'
import {
  LOGIN_START_POLICY_ENV_KEYS,
  collectLoginStartPolicyEnv,
  computeEffectiveRemoteConfig,
  diffRemoteConfigs,
  isEphemeralMacAppPath,
  loginStartTargetFromBundle,
  loginStartTemplateInput,
  parseLaunchdPlist,
  parseSystemdShowProperties,
  parseSystemdUnit,
  resolveLoginStartOverrides,
  serviceFilePath
} from './index'
import { renderLaunchdPlist, renderSystemdUnit } from '../supervisor-templates'

describe('login-start policy env validation and effective remote config (B1)', () => {
  it('collects valid non-secret policy env vars verbatim without rewriting case, and ignores diagnostic/removed vars', () => {
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
        ['SCRY_DISABLED_PROVIDERS', 'Codex, pi'],
        ['SCRY_RUN_CONTROLS', '0'],
        ['SCRY_PROVIDER_MANIFEST_URL', 'https://example.com/manifest.json']
      ]
    })
    expect(LOGIN_START_POLICY_ENV_KEYS).toEqual([
      'SCRY_REMOTE_HOST',
      'SCRY_REMOTE_PERMISSION_MODE',
      'SCRY_REMOTE_RELAY_ENABLED',
      'SCRY_DISABLED_PROVIDERS',
      'SCRY_EXPERIMENTAL_PROVIDERS',
      'SCRY_EXPERIMENTAL_HOST_CLI',
      'SCRY_RUN_CONTROLS',
      'SCRY_PROVIDER_MANIFEST_URL'
    ])

    // W11 review #6: experimental host CLI flag is captured verbatim when set in App env, and validated strictly.
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_HOST_CLI: '1' })).toEqual({
      ok: true,
      entries: [['SCRY_EXPERIMENTAL_HOST_CLI', '1']]
    })
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_HOST_CLI: ' 1' })).toEqual({
      ok: false,
      reason: 'login_start_invalid_env:SCRY_EXPERIMENTAL_HOST_CLI'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_HOST_CLI: 'yes' })).toEqual({
      ok: false,
      reason: 'login_start_invalid_env:SCRY_EXPERIMENTAL_HOST_CLI'
    })
  })

  it('refuses enabling when SCRY_REMOTE_RELAY_WS is present (contains token)', () => {
    const result = collectLoginStartPolicyEnv({
      SCRY_REMOTE_RELAY_WS: JSON.stringify({ url: 'wss://relay.example', token: 'secret-token' })
    })
    expect(result).toEqual({ ok: false, reason: 'login_start_secret_env' })
  })

  it('rejects leading/trailing whitespace so service snapshot cannot widen App policy (B1)', () => {
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_HOST: ' 1' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_HOST'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_HOST: '0 ' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_HOST'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_PERMISSION_MODE: ' full_access' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_PERMISSION_MODE'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_REMOTE_RELAY_ENABLED: ' 0' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_REMOTE_RELAY_ENABLED'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_DISABLED_PROVIDERS: ' codex' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_DISABLED_PROVIDERS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_DISABLED_PROVIDERS: 'codex,' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_DISABLED_PROVIDERS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_RUN_CONTROLS: ' 0 ' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_RUN_CONTROLS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_PROVIDER_MANIFEST_URL: ' https://example.com/m.json' })).toEqual({
      ok: false, reason: 'login_start_invalid_env:SCRY_PROVIDER_MANIFEST_URL'
    })
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

  it('computes and diffs effective non-secret remote config without false mismatch on unforwarded SCRY_REMOTE_RELAY', () => {
    const a = computeEffectiveRemoteConfig({
      SCRY_REMOTE_HOST: '1',
      SCRY_REMOTE_PERMISSION_MODE: 'auto_review',
      SCRY_DISABLED_PROVIDERS: 'pi, codex',
      SCRY_RUN_CONTROLS: '0',
      SCRY_PROVIDER_MANIFEST_URL: 'https://example.com/a.json',
      SCRY_REMOTE_RELAY: '{"host":"127.0.0.1","port":9999,"token":"t"}'
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

describe('login-start bundle layout parity, strict re-render parsing (S5), XDG & macOS path checks (S7)', () => {
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

  it('strictly parses rendered plist and systemd unit via exact re-render and rejects tampered files (S5)', () => {
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
        ['SCRY_REMOTE_PERMISSION_MODE', 'auto_accept_edits'],
        ['SCRY_EXPERIMENTAL_HOST_CLI', '1']
      ]
    })

    const plist = renderLaunchdPlist(input)
    expect(parseLaunchdPlist(plist, 'com.scry.daemon')).toEqual({
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
        { key: 'SCRY_REMOTE_PERMISSION_MODE', value: 'auto_accept_edits' },
        { key: 'SCRY_EXPERIMENTAL_HOST_CLI', value: '1' }
      ]
    })
    expect(parseLaunchdPlist(plist, 'com.scry.daemon.other')).toEqual({ kind: 'foreign' })
    // S5 tampered plist cases: non-empty cleared var, extra env key, XML comment, altered directive
    expect(parseLaunchdPlist(plist.replace('<key>NODE_OPTIONS</key><string></string>', '<key>NODE_OPTIONS</key><string>--require x</string>'), 'com.scry.daemon')).toEqual({ kind: 'foreign' })
    expect(parseLaunchdPlist(plist.replace('  </dict>', '    <key>EXTRA_VAR</key><string>1</string>\n  </dict>'), 'com.scry.daemon')).toEqual({ kind: 'foreign' })
    expect(parseLaunchdPlist(`<!-- edited -->\n${plist}`, 'com.scry.daemon')).toEqual({ kind: 'foreign' })
    expect(parseLaunchdPlist(plist.replace('<integer>30</integer>', '<integer>5</integer>'), 'com.scry.daemon')).toEqual({ kind: 'foreign' })

    const unit = renderSystemdUnit(input)
    expect(parseSystemdUnit(unit)).toEqual({
      kind: 'ours',
      executable: input.executable,
      supervisorEntry: input.supervisorEntry,
      daemonEntry: input.daemonEntry,
      appPath: input.appPath,
      resourcesPath: input.resourcesPath,
      userDataDir: input.userDataDir,
      policyEnv: [
        { key: 'SCRY_REMOTE_HOST', value: '1' },
        { key: 'SCRY_REMOTE_PERMISSION_MODE', value: 'auto_accept_edits' },
        { key: 'SCRY_EXPERIMENTAL_HOST_CLI', value: '1' }
      ]
    })
    // S5 tampered systemd unit cases: ExecStartPre, extra Environment, comment, altered Restart
    expect(parseSystemdUnit(unit.replace('ExecStart=', 'ExecStartPre=/bin/evil\nExecStart='))).toEqual({ kind: 'foreign' })
    expect(parseSystemdUnit(unit.replace('Restart=on-abnormal', 'Environment="EXTRA=1"\nRestart=on-abnormal'))).toEqual({ kind: 'foreign' })
    expect(parseSystemdUnit(`# edited\n${unit}`)).toEqual({ kind: 'foreign' })
    expect(parseSystemdUnit(unit.replace('Restart=on-abnormal', 'Restart=always'))).toEqual({ kind: 'foreign' })
  })

  it('ignores relative XDG_CONFIG_HOME, parses systemctl show by key regardless of order (S7), and flags ephemeral macOS paths', () => {
    expect(serviceFilePath({
      platform: 'linux', homeDir: '/home/me', xdgConfigHome: 'relative/cfg', label: 'com.scry.daemon', unitName: 'scry-daemon.service'
    })).toBe('/home/me/.config/systemd/user/scry-daemon.service')
    expect(serviceFilePath({
      platform: 'linux', homeDir: '/home/me', xdgConfigHome: '/custom/cfg', label: 'com.scry.daemon', unitName: 'scry-daemon.service'
    })).toBe('/custom/cfg/systemd/user/scry-daemon.service')

    expect(parseSystemdShowProperties('MainPID=9876\nActiveState=active\n')).toEqual({ active: true, mainPid: 9876 })
    expect(parseSystemdShowProperties('ActiveState=inactive\nMainPID=9876\n')).toEqual({ active: false, mainPid: null })

    expect(isEphemeralMacAppPath('/Volumes/Scry/Scry.app/Contents/MacOS/Scry')).toBe(true)
    expect(isEphemeralMacAppPath('/private/var/folders/xx/T/AppTranslocation/UUID/d/Scry.app/Contents/MacOS/Scry')).toBe(true)
    expect(isEphemeralMacAppPath('/Applications/Scry.app/Contents/MacOS/Scry')).toBe(false)
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
