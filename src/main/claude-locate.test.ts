import { describe, expect, it } from 'vitest'
import {
  QODER_NODE_BIN,
  appBundleRootForExecutable,
  isAcceptedQoderPath,
  normalizeAgentVersion,
  runtimeCliEnv,
  sanitizeNestedAgentEnv,
  selectClaudeBinCandidate,
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

  it('prepends Node 22 bin to runtime PATH so npm qodercli can resolve env node', () => {
    expect(runtimeCliEnv({ PATH: '/usr/bin:/bin' }).PATH?.split(':').slice(0, 3)).toEqual([
      QODER_NODE_BIN,
      '/usr/bin',
      '/bin'
    ])
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
