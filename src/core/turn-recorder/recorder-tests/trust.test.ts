import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { safeKey, listRecords } from '../store'
import { readCommitHookGrant, writeCommitHookGrant, inspectCommitHookBundle } from '../commit-hook-grant'
import { resolveRecorderLocation } from '../config'
import { workspace, commitHook, roots, payload, commitAckPath } from './fixture.test'

export function registerSuite18(): void {


describe('CLI-side commit hook activation gate', () => {
  async function gateWorkspace(): Promise<{ root: string; grantDir: string; env: NodeJS.ProcessEnv; hook: { path: string; capture: string } }> {
    const root = await workspace()
    const hook = await commitHook(root)
    const grantDir = join(root, '..', `grants-${safeKey(root)}`)
    roots.push(grantDir)
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, unknown>
    config.commitHook = { entry: 'commit-hook.sh', files: ['commit-hook.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    const env: NodeJS.ProcessEnv = { ...process.env, SCRY_GRANT_DIR: grantDir }
    delete env.SCRY_RECORDER_COMMIT_HOOK
    return { root, grantDir, env, hook }
  }

  async function completeTurnWithEnv(root: string, sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt: 'gate' }), env })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }), env })
  }

  it('配置了有效 commitHook 时自动授权、执行并推进 ACK', async () => {
    const { root, env, hook } = await gateWorkspace()

    await completeTurnWithEnv(root, 'gate-auto', env)

    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
    const notification = JSON.parse((await readFile(hook.capture, 'utf8')).trim()) as Record<string, unknown>
    expect(notification).toMatchObject({ event: 'record-committed', sessionId: 'gate-auto', sequence: 1 })
    expect((await readCommitHookGrant(root, env))?.source).toBe('auto')
    await expect(readFile(commitAckPath(root, (await readCommitHookGrant(root, env))?.fingerprint), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it('已有显式授权仍激活投递，并推进 durable ACK', async () => {
    const { root, env, hook } = await gateWorkspace()
    const location = await resolveRecorderLocation(root)
    if (!location.valid || !location.config.commitHook) throw new Error('fixture config invalid')
    await writeCommitHookGrant(root, await inspectCommitHookBundle(root, location.config.commitHook), env)

    await completeTurnWithEnv(root, 'gate-trusted', env)

    const notification = JSON.parse((await readFile(hook.capture, 'utf8')).trim()) as Record<string, unknown>
    expect(notification).toMatchObject({ event: 'record-committed', sessionId: 'gate-trusted', sequence: 1 })
    await expect(readFile(commitAckPath(root, (await readCommitHookGrant(root, env))?.fingerprint), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it('entry 变化后重验并自动更新授权，再执行新脚本', async () => {
    const { root, env, hook } = await gateWorkspace()
    const location = await resolveRecorderLocation(root)
    if (!location.valid || !location.config.commitHook) throw new Error('fixture config invalid')
    await writeCommitHookGrant(root, await inspectCommitHookBundle(root, location.config.commitHook), env)
    await writeFile(hook.path, `#!/bin/sh\ncat >> ${JSON.stringify(hook.capture)}\necho tampered\nexit 0\n`)
    await chmod(hook.path, 0o700)

    await completeTurnWithEnv(root, 'gate-tampered', env)

    const captured = await readFile(hook.capture, 'utf8')
    expect(captured).toContain('"sessionId":"gate-tampered"')
    expect(captured).toContain('tampered')
    expect((await readCommitHookGrant(root, env))?.source).toBe('auto')
  })
})
}
