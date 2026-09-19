import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'scry-shell-env-'))
  roots.push(root)
  const shell = join(root, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\n${body}\n`)
  chmodSync(shell, 0o700)
  vi.stubEnv('SHELL', shell)
  vi.stubEnv('HOME', root)
  vi.stubEnv('PATH', '/usr/bin:/bin')
  vi.stubEnv('HTTPS_PROXY', 'http://inherited.invalid')
  vi.resetModules()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { env: await import('./claude-locate'), warn }
}

const complete = `printf '__AS_ENV_S__\\nPATH=/captured/bin\\nHTTPS_PROXY=http://captured.invalid\\nGITHUB_TOKEN=secret-must-not-leak\\n__AS_ENV_E__\\n'`

describe('login shell environment acquisition', () => {
  it('shares one successful probe, applies the allowlist and caches only the resulting environment', async () => {
    const { env, warn } = await fixture(complete)
    const first = env.warmShellEnv()
    expect(env.warmShellEnv()).toBe(first)
    const captured = await first
    expect(captured.PATH).toBe('/captured/bin')
    expect(captured.HTTPS_PROXY).toBe('http://captured.invalid')
    expect(captured.GITHUB_TOKEN).not.toBe('secret-must-not-leak')
    expect(env.shellEnv()).toBe(captured)
    expect(env.shellEnvError()).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['exit 7', '退出码 7'],
    ['kill -TERM $$', '信号 SIGTERM'],
    ["printf '__AS_ENV_S__\\nHTTPS_PROXY=http://partial.invalid\\n'", '未返回完整环境标记'],
    [`${complete}\nexit 9`, '退出码 9']
  ])('reports failed acquisition without importing incomplete or unsuccessful output: %s', async (body, reason) => {
    const { env, warn } = await fixture(body)
    const fallback = await env.warmShellEnv()
    expect(fallback.HTTPS_PROXY).toBe('http://inherited.invalid')
    expect(fallback.PATH).not.toBe('/captured/bin')
    expect(env.shellEnvError()).toContain(reason)
    expect(env.shellEnvError()).toContain('重启 Scry')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-must-not-leak')
    // A broken startup must not spawn another shell for each provider operation.
    expect(await env.warmShellEnv()).toBe(fallback)
    expect(env.shellEnv()).toBe(fallback)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports startup failure without exposing the executable path', async () => {
    const { env, warn } = await fixture(complete)
    vi.stubEnv('SHELL', '/does-not-exist/secret-path')
    await env.warmShellEnv()
    expect(env.shellEnvError()).toContain('无法启动')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-path')
  })

  it('reports the bounded timeout instead of disguising fallback as a successful shell capture', async () => {
    const { env, warn } = await fixture(`${complete}\nexec sleep 60`)
    await env.warmShellEnv()
    expect(env.shellEnvError()).toContain('超时（5s）')
    expect(env.shellEnv().HTTPS_PROXY).toBe('http://inherited.invalid')
    expect(warn).toHaveBeenCalledTimes(1)
  }, 10_000)
})
