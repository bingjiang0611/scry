import { access, readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeProbeFixture } from './provider-probe-fixture'

afterEach(() => vi.unstubAllEnvs())

it('isolates probe data and only forwards explicitly allowed environment keys', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'unrelated-secret-canary')
  vi.stubEnv('NODE_OPTIONS', '--require=/untrusted/script')
  vi.stubEnv('CLAUDECODE', 'parent-agent')
  vi.stubEnv('ANTHROPIC_API_KEY', 'explicit-probe-credential')
  const fixture = await createClaudeProbeFixture()
  try {
    for (const path of [fixture.cwd, fixture.env.HOME, fixture.env.TMPDIR, fixture.env.CLAUDE_CONFIG_DIR, fixture.env.XDG_CONFIG_HOME, fixture.env.XDG_DATA_HOME, fixture.env.XDG_STATE_HOME]) {
      expect(isAbsolute(path)).toBe(true)
      expect(relative(fixture.root, path)).not.toMatch(/^\.\./)
      await access(path)
    }
    expect(fixture.cwd).not.toBe(process.cwd())
    expect(fixture.env.HOME).not.toBe(process.env.HOME)
    expect(fixture.env.ANTHROPIC_API_KEY).toBe('explicit-probe-credential')
    expect(fixture.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(fixture.env).not.toHaveProperty('NODE_OPTIONS')
    expect(fixture.env).not.toHaveProperty('CLAUDECODE')
    expect(JSON.parse(await readFile(`${fixture.cwd}/package.json`, 'utf8')).name).toBe('scry-provider-probe')
  } finally {
    await fixture.cleanup()
  }
  await expect(access(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
})
