import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { antigravityContinuationKey } from './host-continuation-identity'
import { createAntigravityAdapter } from './antigravity'

const FIXTURE = join(process.cwd(), 'src', 'main', 'providers', 'fixtures', 'fake-agy-acp.mjs')
const temps: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function setupFake(scenario: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-agy-cat-'))
  temps.push(dir)
  const home = join(dir, 'home')
  const cwd = join(dir, 'ws')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const bin = join(dir, 'agy')
  const source = readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(bin, source, { mode: 0o755 })
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  vi.stubEnv('SCRY_AGY_PATH', bin)
  return { dir, home, cwd, bin, recordPath: join(dir, 'recorded.json') }
}

describe('A5: Antigravity 目录探测、动态 thought_level、Skills/Commands、缓存与 continuationKey (D4/D5)', () => {
  it('按模型动态读取 thought_level（不跨模型推断），非 Gemini 模型标注「经 Antigravity 提供」，并按 continuationKey 缓存', async () => {
    const { home, cwd, recordPath } = setupFake({
      models: [
        { value: 'gemini-3-pro', name: 'Gemini 3 Pro', thoughts: ['low', 'medium', 'high', 'xhigh'] },
        { value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', thoughts: ['low', 'medium'] }
      ],
      availableCommands: [
        { name: 'compact', description: 'Compact history' },
        { name: 'plan', description: 'Plan mode' }
      ]
    })
    const adapter = createAntigravityAdapter(home)
    const first = await adapter.runControls!.read({ providerId: 'antigravity', cwd })
    expect(first.state).toBe('ready')
    const models = first.data!.models
    expect(models).toHaveLength(2)
    expect(models[0].model.id).toBe('gemini-3-pro')
    expect(models[0].efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(models[1].model.id).toBe('claude-sonnet-4-5')
    expect(models[1].efforts.map((e) => e.id)).toEqual(['low', 'medium'])
    expect(models[1].description).toContain('经 Antigravity 提供')
    expect(first.data!.permissions.map((p) => p.id)).toEqual(['default', 'auto_accept_edits', 'full_access'])

    // Commands read reuses the cached probe without spawning a second agy process!
    const recAfterFirst = readFileSync(recordPath, 'utf8')
    const cmds = await adapter.commands!.list({ providerId: 'antigravity', cwd })
    expect(cmds.state).toBe('ready')
    expect(cmds.observedAt).toBeGreaterThan(0)
    expect(cmds.data!.map((c) => c.name)).toEqual(['compact', 'plan'])
    expect(readFileSync(recordPath, 'utf8')).toBe(recAfterFirst)

    // Second runControls read also hits cache (zero extra spawn).
    const second = await adapter.runControls!.read({ providerId: 'antigravity', cwd })
    expect(second.state).toBe('ready')
    expect(readFileSync(recordPath, 'utf8')).toBe(recAfterFirst)
  })

  it('未登录时目录探测返回 unavailable 且给出明确终端登录提示', async () => {
    const { home, cwd } = setupFake({ authMode: 'unauthenticated_32000' })
    const adapter = createAntigravityAdapter(home)
    const res = await adapter.runControls!.read({ providerId: 'antigravity', cwd })
    expect(res.state).toBe('unsupported')
    expect(res.reason).toContain('Antigravity 未登录')
  })

  it('只读列出 4 别名目录与用户级 ~/.gemini/config/skills 下的 Skills', async () => {
    const { home, cwd } = setupFake()
    mkdirSync(join(cwd, '_agents', 'skills', 'repo-skill'), { recursive: true })
    writeFileSync(
      join(cwd, '_agents', 'skills', 'repo-skill', 'SKILL.md'),
      '---\nname: repo-skill\ndescription: Repo skill desc\n---\n# Body\n'
    )
    mkdirSync(join(home, '.gemini', 'config', 'skills', 'user-skill'), { recursive: true })
    writeFileSync(
      join(home, '.gemini', 'config', 'skills', 'user-skill', 'SKILL.md'),
      '---\nname: user-skill\ndescription: User skill desc\n---\n'
    )
    const adapter = createAntigravityAdapter(home)
    const skills = await adapter.skills!.list({ providerId: 'antigravity', cwd })
    expect(skills.state).toBe('ready')
    expect(skills.mode).toBe('read')
    expect(skills.data!.map((s) => s.name).sort()).toEqual(['repo-skill', 'user-skill'])
  })

  it('continuationKey (D4) 覆盖 executable、canonical ~/.gemini、放行变量，并在文件存储 token 变化时改变', async () => {
    const { home, cwd, bin } = setupFake()
    const key1 = await antigravityContinuationKey({ providerId: 'antigravity', cwd }, home, bin, { PATH: '/usr/bin' })
    const key2 = await antigravityContinuationKey({ providerId: 'antigravity', cwd }, home, bin, { PATH: '/usr/bin' })
    expect(key1).toBe(key2)
    expect(key1.startsWith('antigravity:')).toBe(true)

    const tokenFile = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    writeFileSync(tokenFile, 'token-A', { mode: 0o600 })
    const keyWithTokenA = await antigravityContinuationKey({ providerId: 'antigravity', cwd }, home, bin, { PATH: '/usr/bin' })
    expect(keyWithTokenA).not.toBe(key1)

    writeFileSync(tokenFile, 'token-B', { mode: 0o600 })
    const keyWithTokenB = await antigravityContinuationKey({ providerId: 'antigravity', cwd }, home, bin, { PATH: '/usr/bin' })
    expect(keyWithTokenB).not.toBe(keyWithTokenA)
  })
})
