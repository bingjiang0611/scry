import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypeSafeApiKeyResolver } from './typesafe-api-key'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'scry-typesafe-auth-'))
  roots.push(root)
  const path = join(root, 'auth.json')
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  return { root, path }
}

describe('TypeSafe API key resolution', () => {
  it('prefers the explicit App environment', async () => {
    const readKeychainService = vi.fn()
    await expect(createTypeSafeApiKeyResolver({ authPath: '/missing', env: { TYPESAFE_API_KEY: 'environment-key' }, readKeychainService })()).resolves.toBe('environment-key')
    expect(readKeychainService).not.toHaveBeenCalled()
  })

  it('resolves Pi environment templates without shell execution', async () => {
    const { path } = await fixture({ typesafe: { type: 'api_key', key: 'prefix-$TOKEN-$$TOKEN-$!', env: { TOKEN: 'stored-key' } } })
    await expect(createTypeSafeApiKeyResolver({ authPath: path, env: {} })()).resolves.toBe('prefix-stored-key-$TOKEN-!')
  })

  it('resolves the exact Pi macOS Keychain reference form', async () => {
    const { path } = await fixture({ typesafe: { type: 'api_key', key: '!security find-generic-password -ws rotom-typesafe-api-key' } })
    const readKeychainService = vi.fn(async service => service === 'rotom-typesafe-api-key' ? 'keychain-key' : undefined)
    await expect(createTypeSafeApiKeyResolver({ authPath: path, env: {}, readKeychainService })()).resolves.toBe('keychain-key')
    expect(readKeychainService).toHaveBeenCalledWith('rotom-typesafe-api-key')
  })

  it('rejects arbitrary command helpers and auth symlinks', async () => {
    const command = await fixture({ typesafe: { type: 'api_key', key: '!echo must-not-run' } })
    const readKeychainService = vi.fn()
    await expect(createTypeSafeApiKeyResolver({ authPath: command.path, env: {}, readKeychainService })()).resolves.toBeUndefined()
    expect(readKeychainService).not.toHaveBeenCalled()

    const target = await fixture({ typesafe: { type: 'api_key', key: 'literal' } })
    const link = join(command.root, 'linked-auth.json')
    await symlink(target.path, link)
    await expect(createTypeSafeApiKeyResolver({ authPath: link, env: {} })()).rejects.toThrow('regular file')
  })
})
