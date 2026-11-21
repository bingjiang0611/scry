import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAntigravityConfigTrustStore,
  inspectAntigravityWorkspaceConfig
} from './antigravity-config-trust'

const temps: string[] = []
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'scry-agy-trust-'))
  temps.push(root)
  const repo = join(root, 'repo')
  const sub = join(repo, 'packages', 'sub')
  const userData = join(root, 'userData')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(sub, { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { root, repo, sub, userData }
}

describe('A6: Antigravity 工作区配置指纹门禁 (antigravity-config-trust)', () => {
  it('扫描 cwd..gitRoot 全部 4 个别名目录的 hooks/mcp/plugins，首次与指纹变化自动记录 source: auto', () => {
    const { repo, sub, userData } = makeRepo()
    mkdirSync(join(repo, '.agents'), { recursive: true })
    mkdirSync(join(repo, '_agent', 'plugins', 'p1'), { recursive: true })
    mkdirSync(join(sub, '.agent'), { recursive: true })
    mkdirSync(join(sub, '_agents'), { recursive: true })
    writeFileSync(join(repo, '.agents', 'hooks.json'), JSON.stringify({ SessionStart: [{ type: 'command', command: 'echo 1' }] }))
    writeFileSync(join(repo, '_agent', 'plugins', 'p1', 'hooks.json'), JSON.stringify({ PreToolUse: [] }))
    writeFileSync(join(sub, '.agent', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }))
    writeFileSync(join(sub, '_agents', 'hooks.json'), JSON.stringify({ Stop: [] }))

    const store = createAntigravityConfigTrustStore(userData)
    const first = store.verifyAndAuthorize(sub)
    expect(first.source).toBe('auto')
    expect(first.changed).toBe(true)
    expect(first.files).toHaveLength(4)

    const second = store.verifyAndAuthorize(sub)
    expect(second.source).toBe('auto')
    expect(second.changed).toBe(false)
    expect(second.fingerprint).toBe(first.fingerprint)

    writeFileSync(join(sub, '_agents', 'hooks.json'), JSON.stringify({ Stop: [{ type: 'command', command: 'echo 2' }] }))
    const third = store.verifyAndAuthorize(sub)
    expect(third.changed).toBe(true)
    expect(third.fingerprint).not.toBe(first.fingerprint)

    const grantFile = JSON.parse(readFileSync(join(userData, 'antigravity-config-grants.json'), 'utf8'))
    expect(grantFile.grants[0].source).toBe('auto')
  })

  it('拒绝工作区 settings.json 含权限类键 (toolPermission / permissions)', () => {
    const { repo, sub } = makeRepo()
    mkdirSync(join(repo, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(
      join(repo, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify({ toolPermission: 'auto' })
    )
    expect(() => inspectAntigravityWorkspaceConfig(sub)).toThrow(/settings\.json/)

    rmSync(join(repo, '.gemini'), { recursive: true, force: true })
    mkdirSync(join(sub, '.agents'), { recursive: true })
    writeFileSync(join(sub, '.agents', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }))
    expect(() => inspectAntigravityWorkspaceConfig(sub)).toThrow(/settings\.json/)
  })

  it('plugins.json 越界目标、符号链接与损坏 JSON 一律 fail closed 拒绝', () => {
    const { root, repo, sub } = makeRepo()
    const outside = join(root, 'outside-plugin')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'hooks.json'), JSON.stringify({}))
    mkdirSync(join(repo, '.agents'), { recursive: true })
    writeFileSync(join(repo, '.agents', 'plugins.json'), JSON.stringify({ entries: [outside] }))
    expect(() => inspectAntigravityWorkspaceConfig(sub)).toThrow(/越出|escape|plugins\.json/i)

    rmSync(join(repo, '.agents', 'plugins.json'))
    symlinkSync(join(outside, 'hooks.json'), join(repo, '.agents', 'hooks.json'))
    expect(() => inspectAntigravityWorkspaceConfig(sub)).toThrow(/符号链接|symlink/i)

    rmSync(join(repo, '.agents', 'hooks.json'))
    writeFileSync(join(repo, '.agents', 'hooks.json'), '{not-json')
    expect(() => inspectAntigravityWorkspaceConfig(sub)).toThrow(/JSON/i)
  })
})
