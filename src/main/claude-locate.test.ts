import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from '../core/turn-recorder/store'
import {
  appBundleRootForExecutable,
  detectAgentsFast,
  isAcceptedQoderPath,
  mergeLoginShellEnv,
  normalizeAgentVersion,
  resolveCommandOnPath,
  resolveRecorderCliPath,
  packagedRecorderCliPath,
  runtimeCliEnv,
  sanitizeNestedAgentEnv,
  sanitizeProviderEnv,
  selectClaudeBinCandidate,
  selectCodexBinCandidate,
  selectQoderBinCandidate
} from './claude-locate'

describe('runtime CLI discovery constraints', () => {
  const npmBin = '/Users/example/.nvm/versions/node/v22.22.1/bin/qodercli'
  const appBundleBin = '/Applications/QoderWork.app/Contents/Resources/bin/qodercli'

  it('只从登录 shell 补齐运行和 Provider 变量，不导入无关 secret', () => {
    expect(mergeLoginShellEnv(
      { HOME: '/Users/example', DATABASE_URL: 'inherited-value' },
      {
        PATH: '/shell/bin:/usr/bin',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        HTTPS_PROXY: 'http://proxy.example.test',
        OPENAI_API_KEY: 'provider-key',
        AWS_PROFILE: 'bedrock-profile',
        DATABASE_URL: 'must-not-import',
        GITHUB_TOKEN: 'must-not-import',
        NPM_TOKEN: 'must-not-import',
        CLAUDE_CODE_ENTRYPOINT: 'nested-session'
      }
    )).toEqual({
      HOME: '/Users/example',
      DATABASE_URL: 'inherited-value',
      PATH: '/shell/bin:/usr/bin',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      HTTPS_PROXY: 'http://proxy.example.test',
      OPENAI_API_KEY: 'provider-key',
      AWS_PROFILE: 'bedrock-profile'
    })
  })

  it('保留 launcher 显式 CODEX_HOME，仅在 Finder 环境缺失时从登录 shell 补齐', () => {
    expect(mergeLoginShellEnv(
      { HOME: '/Users/example', CODEX_HOME: '/tmp/formal-codex-home' },
      { PATH: '/shell/bin:/usr/bin', CODEX_HOME: '/Users/example/.codex' }
    )).toMatchObject({
      PATH: '/shell/bin:/usr/bin',
      CODEX_HOME: '/tmp/formal-codex-home'
    })

    expect(mergeLoginShellEnv(
      { HOME: '/Users/example' },
      { CODEX_HOME: '/Users/example/.codex' }
    ).CODEX_HOME).toBe('/Users/example/.codex')
  })

  it('normalizes CLI version banners without exposing product-name noise', () => {
    expect(normalizeAgentVersion('2.1.150 (Claude Code)')).toBe('2.1.150')
    expect(normalizeAgentVersion('codex-cli 0.142.5')).toBe('0.142.5')
    expect(normalizeAgentVersion('1.17.18\n')).toBe('1.17.18')
    expect(normalizeAgentVersion('')).toBeUndefined()
  })

  it('identifies the app bundle that owns an embedded CLI executable', () => {
    expect(appBundleRootForExecutable('/Applications/ChatGPT.app/Contents/Resources/codex')).toBe('/Applications/ChatGPT.app')
    expect(appBundleRootForExecutable('/usr/local/bin/codex')).toBeUndefined()
  })

  it('accepts qodercli from either npm or an application bundle', () => {
    expect(isAcceptedQoderPath(npmBin)).toBe(true)
    expect(isAcceptedQoderPath(appBundleBin)).toBe(true)
  })

  it('prefers an explicit compatible qodercli and lets the SDK validate its wire protocol', () => {
    expect(
      selectQoderBinCandidate({
        configured: appBundleBin,
        onPath: appBundleBin
      })
    ).toBe(appBundleBin)
    expect(selectQoderBinCandidate({ configured: appBundleBin, onPath: appBundleBin })).toBe(appBundleBin)
    expect(selectQoderBinCandidate({})).toBeUndefined()
  })

  it('prefers an explicit Claude path, then the native installer, before a PATH copy', () => {
    expect(
      selectClaudeBinCandidate({
        configured: '/custom/claude',
        configuredExists: true,
        native: '/Users/example/.local/bin/claude',
        nativeExists: true,
        onPath: '/Users/example/.nvm/bin/claude'
      })
    ).toBe('/custom/claude')
    expect(
      selectClaudeBinCandidate({
        native: '/Users/example/.local/bin/claude',
        nativeExists: true,
        onPath: '/Users/example/.nvm/bin/claude'
      })
    ).toBe('/Users/example/.local/bin/claude')
  })

  it('falls back to the Codex executable embedded in ChatGPT when it is absent from PATH', () => {
    expect(
      selectCodexBinCandidate({
        configured: '/custom/codex',
        configuredExists: true,
        onPath: '/usr/local/bin/codex',
        appBin: '/Applications/ChatGPT.app/Contents/Resources/codex',
        appBinExists: true
      })
    ).toBe('/custom/codex')
    expect(
      selectCodexBinCandidate({
        onPath: '/usr/local/bin/codex',
        appBin: '/Applications/ChatGPT.app/Contents/Resources/codex',
        appBinExists: true
      })
    ).toBe('/usr/local/bin/codex')
    expect(
      selectCodexBinCandidate({
        appBin: '/Applications/ChatGPT.app/Contents/Resources/codex',
        appBinExists: true
      })
    ).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
  })

  it('marks configured CLIs as detected without waiting for version subprocesses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-fast-detect-'))
    const previous = {
      SCRY_CLAUDE_PATH: process.env.SCRY_CLAUDE_PATH,
      SCRY_CODEX_PATH: process.env.SCRY_CODEX_PATH,
      SCRY_QODERCLI_PATH: process.env.SCRY_QODERCLI_PATH,
      SCRY_OPENCODE_PATH: process.env.SCRY_OPENCODE_PATH
    }
    try {
      const configured = Object.fromEntries(
        ['claude', 'codex', 'qodercli', 'opencode'].map((name) => {
          const path = join(dir, name)
          writeFileSync(path, '')
          return [name, path]
        })
      )
      process.env.SCRY_CLAUDE_PATH = configured.claude
      process.env.SCRY_CODEX_PATH = configured.codex
      process.env.SCRY_QODERCLI_PATH = configured.qodercli
      process.env.SCRY_OPENCODE_PATH = configured.opencode

      expect(detectAgentsFast()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'claude', path: configured.claude }),
          expect.objectContaining({ id: 'codex', path: configured.codex }),
          expect.objectContaining({ id: 'qoder', name: 'Qoder', path: configured.qodercli }),
          expect.objectContaining({ id: 'opencode', path: configured.opencode })
        ])
      )
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pins scry from the original PATH without prepending a fixed Qoder Node directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-path-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, '#!/bin/sh\n')
      chmodSync(scry, 0o755)
      const env = runtimeCliEnv({ PATH: `${dir}:/usr/bin:/bin` })
      expect(env.SCRY_CLI_PATH).toBe(scry)
      expect(env.PATH).toBe(`${dir}:/usr/bin:/bin`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the App-private recorder CLI over PATH and fallback installations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-bundled-cli-'))
    try {
      const resources = join(dir, 'Scry.app', 'Contents', 'Resources')
      const bundled = join(resources, 'bin', 'scry')
      const external = join(dir, 'external', 'scry')
      mkdirSync(dirname(bundled), { recursive: true })
      mkdirSync(dirname(external), { recursive: true })
      writeFileSync(bundled, '#!/bin/sh\n')
      writeFileSync(external, '#!/bin/sh\n')
      chmodSync(bundled, 0o755)
      chmodSync(external, 0o755)

      expect(packagedRecorderCliPath(resources)).toBe(bundled)
      expect(resolveRecorderCliPath({ PATH: dirname(external) }, dirname(external), '', bundled)).toBe(bundled)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an explicit SCRY_CLI_PATH authoritative even when another scry is discoverable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-explicit-'))
    try {
      const discovered = join(dir, 'scry')
      writeFileSync(discovered, '#!/bin/sh\n')
      chmodSync(discovered, 0o755)
      expect(runtimeCliEnv({ PATH: dir, SCRY_CLI_PATH: '/missing/explicit/scry' }).SCRY_CLI_PATH)
        .toBe('/missing/explicit/scry')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an explicitly empty SCRY_CLI_PATH authoritative instead of falling back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-disabled-'))
    try {
      const discovered = join(dir, 'scry')
      writeFileSync(discovered, '#!/bin/sh\n')
      chmodSync(discovered, 0o755)
      expect(runtimeCliEnv({ PATH: dir, SCRY_CLI_PATH: '' }).SCRY_CLI_PATH).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks only explicitly managed Provider environments for canonical recording', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-managed-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, `#!/bin/sh\nprintf '%s\\n' '${RECORDER_VERSION}'\n`)
      chmodSync(scry, 0o755)
      const base = { PATH: `${dir}:/usr/bin:/bin` }
      expect(runtimeCliEnv(base).SCRY_RECORDER_MANAGED).toBeUndefined()
      expect(runtimeCliEnv(base, { managedRecorder: true })).toMatchObject({
        SCRY_RECORDER_MANAGED: '1',
        SCRY_RECORDER_REQUIRED_VERSION: RECORDER_VERSION,
        SCRY_CLI_PATH: scry
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not expose billing admin credentials to the managed-recorder version probe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-probe-env-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, `#!/bin/sh
for key in OPENAI_ADMIN_API_KEY ANTHROPIC_ADMIN_API_KEY QODER_ADMIN_API_KEY QODER_ORGANIZATION_ID QODER_MEMBER_ID; do
  env | grep -q "^$key=" && exit 9
done
printf '%s\\n' '${RECORDER_VERSION}'
`)
      chmodSync(scry, 0o755)
      expect(runtimeCliEnv({
        PATH: `${dir}:/usr/bin:/bin`,
        OPENAI_ADMIN_API_KEY: 'a',
        ANTHROPIC_ADMIN_API_KEY: 'b',
        QODER_ADMIN_API_KEY: 'c',
        QODER_ORGANIZATION_ID: 'd',
        QODER_MEMBER_ID: 'e'
      }, { managedRecorder: true })).toMatchObject({ SCRY_CLI_PATH: scry })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps provider-only PATH entries out of recorder CLI fallback resolution', () => {
    const providerDir = mkdtempSync(join(tmpdir(), 'scry-provider-path-'))
    const fallbackDir = mkdtempSync(join(tmpdir(), 'scry-recorder-fallback-'))
    try {
      const providerScry = join(providerDir, 'scry')
      const fallbackScry = join(fallbackDir, 'scry')
      for (const path of [providerScry, fallbackScry]) {
        writeFileSync(path, '#!/bin/sh\n')
        chmodSync(path, 0o755)
      }
      expect(resolveRecorderCliPath({ PATH: providerDir }, '/usr/bin:/bin', fallbackDir)).toBe(fallbackScry)
    } finally {
      rmSync(providerDir, { recursive: true, force: true })
      rmSync(fallbackDir, { recursive: true, force: true })
    }
  })

  it('fails closed before Codex starts when the pinned scry CLI version differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-stale-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, "#!/bin/sh\nprintf '%s\\n' '0.2.5'\n")
      chmodSync(scry, 0o755)
      expect(() => runtimeCliEnv(
        { PATH: `${dir}:/usr/bin:/bin` },
        { managedRecorder: true }
      )).toThrow(`requires CLI ${RECORDER_VERSION}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves Windows npm command shims through PATHEXT', () => {
    expect(resolveCommandOnPath('scry', 'C:\\Tools;C:\\Node', {
      platform: 'win32',
      pathExt: '.EXE;.CMD',
      isRunnable: (path) => path === 'C:\\Node\\scry.CMD'
    })).toBe('C:\\Node\\scry.CMD')
  })

  it('strips outer Codex/Claude harness env from runtime CLI children without deleting user config/auth env', () => {
    const env = runtimeCliEnv({
      PATH: '/usr/bin:/bin',
      CODEX_CI: '1',
      CODEX_THREAD_ID: 'thread-1',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDECODE: '1',
      AI_AGENT: '1',
      SCRY_CODEX_SOURCE_HOME: '/must-not-leak',
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'sk-test',
      QODER_TOKEN: 'qoder-token'
    })
    expect(env).not.toHaveProperty('CODEX_CI')
    expect(env).not.toHaveProperty('CODEX_THREAD_ID')
    expect(env).not.toHaveProperty('CODEX_INTERNAL_ORIGINATOR_OVERRIDE')
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('AI_AGENT')
    expect(env).not.toHaveProperty('SCRY_CODEX_SOURCE_HOME')
    expect(env).toMatchObject({
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'sk-test',
      QODER_TOKEN: 'qoder-token'
    })
  })

  it('sanitizes explicit env objects the same way shellEnv/runtimeCliEnv do', () => {
    expect(
      sanitizeNestedAgentEnv({
        CODEX_INTERNAL_TRACE: '1',
        CODEX_HOME: '/keep',
        SHELL: '/bin/zsh'
      })
    ).toEqual({
      CODEX_HOME: '/keep',
      SHELL: '/bin/zsh'
    })
  })

  it('keeps billing-only admin credentials out of provider children', () => {
    expect(sanitizeProviderEnv({
      PATH: '/usr/bin:/bin',
      OPENAI_ADMIN_API_KEY: 'openai-admin',
      ANTHROPIC_ADMIN_API_KEY: 'anthropic-admin',
      QODER_ADMIN_API_KEY: 'qoder-admin',
      QODER_ORGANIZATION_ID: 'org-1',
      QODER_MEMBER_ID: 'member-1',
      OPENAI_API_KEY: 'provider-key',
      ANTHROPIC_API_KEY: 'provider-key-2'
    })).toEqual({
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'provider-key',
      ANTHROPIC_API_KEY: 'provider-key-2'
    })
  })
})
