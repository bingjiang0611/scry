import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createOpenCodePluginGrantStore,
  openCodeProjectPluginFingerprint
} from './opencode-plugin-trust'

describe('OpenCode project plugin grant store', () => {
  it('persists only the exact canonical cwd and plugin fingerprint with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-plugin-grant-'))
    try {
      const store = createOpenCodePluginGrantStore(root)
      const first = openCodeProjectPluginFingerprint([
        { path: join(root, 'plugin.js'), digest: 'sha256:first', size: 10, contents: Buffer.from('first') }
      ])
      const changed = openCodeProjectPluginFingerprint([
        { path: join(root, 'plugin.js'), digest: 'sha256:changed', size: 10, contents: Buffer.from('changed') }
      ])

      expect(store.isGranted(root, first)).toBe(false)
      store.grant(root, first, 1)
      expect(store.isGranted(root, first)).toBe(true)
      expect(store.isGranted(root, changed)).toBe(false)

      const file = join(root, 'opencode-plugin-grants.json')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await chmod(file, 0o644)
      expect(store.isGranted(root, first)).toBe(false)
      store.grant(root, changed, 1)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(file, 'utf8')).grants).toHaveLength(1)
      expect(store.isGranted(root, first)).toBe(false)
      expect(store.isGranted(root, changed)).toBe(true)

      const outside = join(root, 'outside.json')
      await writeFile(outside, '{"version":1,"grants":[]}\n', { mode: 0o600 })
      await rm(file)
      await symlink(outside, file)
      expect(store.isGranted(root, changed)).toBe(false)
      store.grant(root, first, 1)
      expect((await stat(file)).isFile()).toBe(true)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats plugin declaration order as part of the authorization fingerprint', () => {
    const first = { path: '/repo/first.js', digest: 'first', size: 1, contents: Buffer.from('a') }
    const second = { path: '/repo/second.js', digest: 'second', size: 1, contents: Buffer.from('b') }
    expect(openCodeProjectPluginFingerprint([first, second])).not.toBe(
      openCodeProjectPluginFingerprint([second, first])
    )
  })
})
