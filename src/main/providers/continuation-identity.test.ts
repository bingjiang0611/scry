import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeContinuationKey, codexContinuationKey } from './continuation-identity'
import { createCodexIsolatedHome } from './codex-isolated-home'

const roots: string[] = []
const context = { providerId: 'claude' as const, cwd: '/workspace/project' }

async function executable(root: string): Promise<string> {
  const path = join(root, 'provider')
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o755)
  return path
}

async function cleanup(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

afterEach(cleanup)

describe('provider continuation identity', () => {
  it('fails closed for missing, unreadable, and non-executable Provider binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    expect(() => claudeContinuationKey(context, home, join(root, 'missing'), {
      ANTHROPIC_API_KEY: 'key'
    })).toThrow(/不可/)
    const directory = join(root, 'directory')
    await mkdir(directory)
    expect(() => claudeContinuationKey(context, home, directory, {
      ANTHROPIC_API_KEY: 'key'
    })).toThrow(/不可|不是普通文件/)
    const binary = await executable(root)
    await chmod(binary, 0o644)
    expect(() => claudeContinuationKey(context, home, binary, {
      ANTHROPIC_API_KEY: 'key'
    })).toThrow(/不可执行/)
  })

  it('ignores mutable Claude telemetry while retaining stable OAuth account authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    const binary = await executable(root)
    const configRoot = join(home, '.claude')
    await mkdir(configRoot)
    const config = join(configRoot, '.config.json')
    await writeFile(config, JSON.stringify({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-a' }, stats: { count: 1 } }))
    const first = claudeContinuationKey(context, home, binary, {})
    await writeFile(config, JSON.stringify({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-a' }, stats: { count: 999 }, lastUpdated: Date.now() }))
    expect(claudeContinuationKey(context, home, binary, {})).toBe(first)
    await writeFile(config, JSON.stringify({ oauthAccount: { accountUuid: 'account-b', organizationUuid: 'org-a' }, stats: { count: 999 } }))
    expect(claudeContinuationKey(context, home, binary, {})).not.toBe(first)
  })

  it('uses the actual runtime OAuth env rather than process.env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    const binary = await executable(root)
    const first = claudeContinuationKey(context, home, binary, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-a' })
    const same = claudeContinuationKey(context, home, binary, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-a' })
    const changed = claudeContinuationKey(context, home, binary, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-b' })
    expect(same).toBe(first)
    expect(changed).not.toBe(first)
  })

  it('does not fabricate authority when native auth/config state is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    const source = join(root, 'codex')
    const isolated = join(root, 'isolated')
    await Promise.all([mkdir(home), mkdir(source), mkdir(isolated)])
    const binary = await executable(root)
    expect(() => claudeContinuationKey(context, home, binary, {})).toThrow(/身份/)
    expect(() => codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'planned')).toThrow(/身份/)
    await mkdir(join(source, 'auth.json'))
    expect(() => codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {
      OPENAI_API_KEY: 'api-key'
    }, 'planned')).toThrow(/普通文件/)
  })

  it('reads Claude legacy config from the native default and fallback locations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    const binary = await executable(root)
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'legacy-account' } }))
    const fallback = claudeContinuationKey(context, home, binary, {})
    await rm(join(home, '.claude.json'))
    const configRoot = join(home, '.claude')
    await mkdir(configRoot)
    await writeFile(join(configRoot, '.config.json'), JSON.stringify({ oauthAccount: { accountUuid: 'native-account' } }))
    expect(claudeContinuationKey(context, home, binary, {})).not.toBe(fallback)
  })

  it('resolves relative and linked Claude config roots using the actual child cwd without trimming paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-config-root-'))
    roots.push(root)
    const home = join(root, 'home')
    const project = join(root, 'project')
    const config = join(project, ' config ')
    await mkdir(home)
    await mkdir(config, { recursive: true })
    await writeFile(join(config, '.config.json'), JSON.stringify({ oauthAccount: { accountUuid: 'configured-account' } }))
    const binary = await executable(root)
    const key = claudeContinuationKey({ ...context, cwd: project }, home, binary, { CLAUDE_CONFIG_DIR: ' config ' })
    expect(claudeContinuationKey({ ...context, cwd: project }, home, binary, { CLAUDE_CONFIG_DIR: config })).toBe(key)
    const alias = join(root, 'linked-config')
    await symlink(config, alias)
    expect(claudeContinuationKey({ ...context, cwd: project }, home, binary, { CLAUDE_CONFIG_DIR: alias })).toBe(key)
  })

  it('rejects dynamic Claude auth and tracks endpoint/auth settings but not telemetry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const home = join(root, 'home')
    const project = join(root, 'project')
    await Promise.all([mkdir(join(project, '.claude'), { recursive: true }), mkdir(join(home, '.claude'), { recursive: true })])
    const binary = await executable(root)
    const settings = join(project, '.claude', 'settings.json')
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a.example', TELEMETRY: 'one' } }))
    const first = claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'api' })
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a.example', TELEMETRY: 'changed' } }))
    expect(claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'api' })).toBe(first)
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://b.example', TELEMETRY: 'changed' } }))
    expect(claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'api' })).not.toBe(first)
    await writeFile(settings, JSON.stringify({ apiKeyHelper: 'credential-helper' }))
    expect(() => claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'api' })).toThrow(/动态认证 helper/)
  })

  it('preserves auth setting provenance when user and project values exchange precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-setting-order-'))
    roots.push(root)
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(project, '.claude'), { recursive: true })
    const binary = await executable(root)
    const user = join(home, '.claude', 'settings.json')
    const local = join(project, '.claude', 'settings.json')
    await writeFile(user, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-key' } }))
    await writeFile(local, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'project-key' } }))
    const first = claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'shell-key' })
    await writeFile(user, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'project-key' } }))
    await writeFile(local, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-key' } }))
    expect(claudeContinuationKey({ ...context, cwd: project }, home, binary, { ANTHROPIC_API_KEY: 'shell-key' })).not.toBe(first)
  })

  it('uses the effective Codex private auth authority rather than the source label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const source = join(root, 'codex')
    const isolated = join(root, 'isolated')
    await Promise.all([mkdir(source), mkdir(isolated)])
    await writeFile(join(source, 'auth.json'), JSON.stringify({ account_id: 'source' }))
    await writeFile(join(isolated, 'auth.json'), JSON.stringify({ account_id: 'private' }))
    const binary = await executable(root)
    const privateKey = codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'materialized')
    await rm(join(isolated, 'auth.json'))
    await symlink(join(source, 'auth.json'), join(isolated, 'auth.json'))
    expect(codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'materialized')).not.toBe(privateKey)
  })

  it('keeps the Codex namespace stable across first isolated-home materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-identity-'))
    roots.push(root)
    const source = join(root, 'codex')
    const isolated = join(root, 'isolated')
    await Promise.all([mkdir(source), mkdir(isolated)])
    await writeFile(join(source, 'auth.json'), JSON.stringify({ account_id: 'account-a' }))
    const binary = await executable(root)
    const before = codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'planned')
    expect(() => codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'materialized')).toThrow(/身份/)
    createCodexIsolatedHome(source, isolated)
    const after = codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'materialized')
    expect(after).toBe(before)
    await writeFile(join(source, 'auth.json'), JSON.stringify({ account_id: 'account-b' }))
    expect(codexContinuationKey({ providerId: 'codex', cwd: context.cwd }, source, isolated, binary, {}, 'materialized')).not.toBe(before)
  })
})
