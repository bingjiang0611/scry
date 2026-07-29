import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDER_VERSION } from '../core/turn-recorder/store'
import {
  QODER_NODE_BIN,
  appBundleRootForExecutable,
  detectAgentsFast,
  isAcceptedQoderPath,
  normalizeAgentVersion,
  resolveCommandOnPath,
  runtimeCliEnv,
  sanitizeNestedAgentEnv,
  selectClaudeBinCandidate,
  selectCodexBinCandidate,
  selectQoderBinCandidate
} from './claude-locate'

describe('runtime CLI discovery constraints', () => {
  const npmBin = '/Users/example/.nvm/versions/node/v22.22.1/bin/qodercli'
  const appBundleBin = '/Applications/QoderWork.app/Contents/Resources/bin/qodercli'

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
    expect(isAcceptedQoderPath(npmBin, npmBin)).toBe(true)
    expect(isAcceptedQoderPath(appBundleBin, npmBin)).toBe(true)
  })

  it('prefers an explicit compatible qodercli and lets the SDK validate its wire protocol', () => {
    expect(
      selectQoderBinCandidate({
        configured: appBundleBin,
        onPath: appBundleBin,
        npmBin,
        npmExists: true
      })
    ).toBe(appBundleBin)
    expect(selectQoderBinCandidate({ configured: appBundleBin, onPath: appBundleBin, npmBin, npmExists: false })).toBe(appBundleBin)
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
          expect.objectContaining({ id: 'qoder', path: configured.qodercli }),
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

  it('pins scry from the original PATH before prepending the Qoder Node directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-path-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, '#!/bin/sh\n')
      chmodSync(scry, 0o755)
      const env = runtimeCliEnv({ PATH: `${dir}:/usr/bin:/bin` })
      expect(env.SCRY_CLI_PATH).toBe(scry)
      expect(env.PATH?.split(':').slice(0, 4)).toEqual([QODER_NODE_BIN, dir, '/usr/bin', '/bin'])
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
})
