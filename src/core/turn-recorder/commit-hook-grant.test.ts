import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRecorderLocation, type RecorderConfig } from './config.js'
import {
  commitHookEnv,
  commitHookGrantPath,
  inspectCommitHookBundle,
  readCommitHookGrant,
  resolveCommitHookActivation,
  revokeCommitHookGrant,
  writeCommitHookGrant
} from './commit-hook-grant.js'

interface Fixture {
  workspace: string
  grantDir: string
  env: NodeJS.ProcessEnv
}

async function fixture(options: { commitHook?: { entry: string; files: string[] } } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-grant-'))
  const workspace = join(root, 'workspace')
  const grantDir = join(root, 'grants')
  await mkdir(join(workspace, 'tools'), { recursive: true })
  await writeFile(join(workspace, 'tools', 'uploader.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(workspace, 'tools', 'uploader.sh'), 0o755)
  await writeFile(join(workspace, 'tools', 'lib.sh'), 'echo lib\n')
  await writeFile(
    join(workspace, 'scry.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: 'fixture',
      ...(options.commitHook ? { commitHook: options.commitHook } : {})
    })
  )
  return { workspace, grantDir, env: { SCRY_GRANT_DIR: grantDir } }
}

async function config(workspace: string): Promise<RecorderConfig> {
  const location = await resolveRecorderLocation(workspace)
  if (!location.valid) throw new Error(`fixture config invalid: ${location.reason}`)
  return location.config
}

const bundleConfig = { entry: 'tools/uploader.sh', files: ['tools/uploader.sh', 'tools/lib.sh'] }

describe('commit hook grant', () => {
  it('keeps the grant outside the workspace and readable only by the owner', async () => {
    const { workspace, grantDir, env } = await fixture({ commitHook: bundleConfig })
    const bundle = await inspectCommitHookBundle(workspace, bundleConfig)
    const written = await writeCommitHookGrant(workspace, bundle, env)

    expect(written.grantPath.startsWith(resolve(grantDir))).toBe(true)
    expect(written.grantPath.startsWith(resolve(workspace))).toBe(false)
    expect((await stat(written.grantPath)).mode & 0o777).toBe(0o600)
    expect(commitHookGrantPath(workspace, env)).toBe(written.grantPath)
    expect((await readCommitHookGrant(workspace, env))?.fingerprint).toBe(bundle.fingerprint)
  })

  it('reports not-configured when the workspace declares no commit hook', async () => {
    const { workspace, env } = await fixture()
    const activation = await resolveCommitHookActivation(workspace, await config(workspace), env)
    expect(activation.status).toBe('not-configured')
    expect(commitHookEnv(activation, env).SCRY_RECORDER_COMMIT_HOOK).toBeUndefined()
  })

  it('auto-authorizes a valid configured hook and records source=auto', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const activation = await resolveCommitHookActivation(workspace, await config(workspace), env)
    expect(activation.status).toBe('trusted')
    expect(commitHookEnv(activation, env).SCRY_RECORDER_COMMIT_HOOK).toBe(join(resolve(workspace), 'tools/uploader.sh'))
    expect((await readCommitHookGrant(workspace, env))?.source).toBe('auto')
  })

  it('keeps explicit grants compatible', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const parsed = await config(workspace)
    await writeCommitHookGrant(workspace, await inspectCommitHookBundle(workspace, bundleConfig), env)

    const activation = await resolveCommitHookActivation(workspace, parsed, env)
    expect(activation.status).toBe('trusted')
    const injected = commitHookEnv(activation, env)
    expect(injected.SCRY_RECORDER_COMMIT_HOOK).toBe(join(resolve(workspace), 'tools/uploader.sh'))
    expect(injected.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT).toBe(
      activation.status === 'trusted' ? activation.fingerprint : ''
    )
  })

  it('revalidates changed files and replaces the grant automatically', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const parsed = await config(workspace)
    const original = await writeCommitHookGrant(workspace, await inspectCommitHookBundle(workspace, bundleConfig), env)

    await writeFile(join(workspace, 'tools', 'lib.sh'), 'echo tampered\n')

    const activation = await resolveCommitHookActivation(workspace, parsed, env)
    expect(activation.status).toBe('trusted')
    const refreshed = await readCommitHookGrant(workspace, env)
    expect(refreshed?.fingerprint).not.toBe(original.grant.fingerprint)
    expect(refreshed?.source).toBe('auto')
  })

  it('does not reuse a grant issued for another workspace path', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const bundle = await inspectCommitHookBundle(workspace, bundleConfig)
    const grantPath = commitHookGrantPath(workspace, env)
    await writeCommitHookGrant(workspace, bundle, env)

    const other = await fixture({ commitHook: bundleConfig })
    // Same grant file contents, different workspace identity.
    const forged = { ...env, SCRY_GRANT_DIR: env.SCRY_GRANT_DIR }
    expect(commitHookGrantPath(other.workspace, forged)).not.toBe(grantPath)
    expect(await readCommitHookGrant(other.workspace, forged)).toBeNull()
  })

  it('never overrides a managed host that injects its own entry', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const hosted = { ...env, SCRY_RECORDER_COMMIT_HOOK: '/opt/host/uploader' }
    const activation = await resolveCommitHookActivation(workspace, await config(workspace), hosted)
    expect(activation.status).toBe('host-provided')
    expect(commitHookEnv(activation, hosted).SCRY_RECORDER_COMMIT_HOOK).toBe('/opt/host/uploader')
  })

  it('rejects a non-executable entry', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    await chmod(join(workspace, 'tools', 'uploader.sh'), 0o644)
    const activation = await resolveCommitHookActivation(workspace, await config(workspace), env)
    expect(activation.status).toBe('bundle-invalid')
    if (activation.status === 'bundle-invalid') expect(activation.detail).toContain('executable')
  })

  it('rejects a missing file and a symlink escaping the workspace', async () => {
    const { workspace } = await fixture({ commitHook: bundleConfig })
    await expect(
      inspectCommitHookBundle(workspace, { entry: 'tools/uploader.sh', files: ['tools/uploader.sh', 'tools/absent.sh'] })
    ).rejects.toThrow(/missing/)

    await symlink('/bin/sh', join(workspace, 'tools', 'escape.sh'))
    await expect(
      inspectCommitHookBundle(workspace, { entry: 'tools/uploader.sh', files: ['tools/uploader.sh', 'tools/escape.sh'] })
    ).rejects.toThrow(/escapes the workspace/)
  })

  it('revoking a grant removes it until the next automatic activation', async () => {
    const { workspace, env } = await fixture({ commitHook: bundleConfig })
    const parsed = await config(workspace)
    await writeCommitHookGrant(workspace, await inspectCommitHookBundle(workspace, bundleConfig), env)

    const revoked = await revokeCommitHookGrant(workspace, env)
    expect(revoked.removed).toBe(true)
    expect((await resolveCommitHookActivation(workspace, parsed, env)).status).toBe('trusted')
    expect((await readCommitHookGrant(workspace, env))?.source).toBe('auto')
    expect((await revokeCommitHookGrant(workspace, env)).removed).toBe(true)
  })
})
