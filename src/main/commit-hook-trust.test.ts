import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitHookTrustPolicy,
  createCommitHookTrustStore,
  inspectCommitHookBundle,
  resolveCommitHookCapability,
  resolveGrantedCommitHookCapability
} from './commit-hook-trust'
import { redeliverGrantedCommitHooksAtStartup } from './commit-hook-startup'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { drainCommitNotifications } from '../core/turn-recorder/store'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-commit-hook-trust-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const userData = join(root, 'user-data')
  await mkdir(join(workspace, 'hooks'), { recursive: true })
  await writeFile(join(workspace, 'hooks', 'commit.sh'), '#!/bin/sh\necho v1\n')
  await writeFile(join(workspace, 'hooks', 'helper.txt'), 'dependency-v1\n')
  return { workspace, userData, descriptor: { entry: 'hooks/commit.sh', files: ['hooks/commit.sh', 'hooks/helper.txt'] } }
}

const enableRecorder = async (workspace: string, descriptor: { entry: string; files: string[] }): Promise<void> => {
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'commit-hook-startup-test',
    dataDir: '.scry',
    commitHook: descriptor,
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
}

const completeTurn = async (workspace: string, sessionId: string): Promise<void> => {
  await handleRecorderHook({
    provider: 'claude', event: 'UserPromptSubmit', workspace,
    payload: { session_id: sessionId, prompt: sessionId, timestamp: '2026-08-12T00:00:00.000Z' }
  })
  await handleRecorderHook({
    provider: 'claude', event: 'Stop', workspace,
    payload: { session_id: sessionId, timestamp: '2026-08-12T00:00:01.000Z' }
  })
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('commit hook bundle trust', () => {
  it('指纹或依赖内容变化后原授权失效', async () => {
    const value = await fixture()
    const first = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, first.fingerprint)
    expect(await store.isGranted(value.workspace, first.fingerprint)).toBe(true)

    await writeFile(join(value.workspace, 'hooks', 'helper.txt'), 'dependency-v2\n')
    const changed = await inspectCommitHookBundle(value.workspace, value.descriptor)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(await store.isGranted(value.workspace, changed.fingerprint)).toBe(false)
    await expect(store.materialize(changed)).rejects.toThrow('not granted')

    const changedEntry = await inspectCommitHookBundle(value.workspace, { ...value.descriptor, entry: 'hooks/helper.txt' })
    expect(changedEntry.fingerprint).not.toBe(changed.fingerprint)
  })

  it('拒绝越界、symlink 和未显式列出的 entry', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace, '..', 'outside.sh'), 'outside')
    await symlink(join(value.workspace, 'hooks', 'helper.txt'), join(value.workspace, 'hooks', 'linked.txt'))
    await expect(inspectCommitHookBundle(value.workspace, { entry: '../outside.sh', files: ['../outside.sh'] })).rejects.toThrow('Invalid bundle path')
    await expect(inspectCommitHookBundle(value.workspace, { entry: 'hooks/commit.sh', files: ['hooks/commit.sh', 'hooks/linked.txt'] })).rejects.toThrow('symlink')
    await expect(inspectCommitHookBundle(value.workspace, { entry: 'hooks/commit.sh', files: ['hooks/helper.txt'] })).rejects.toThrow('entry must be listed')
  })

  it('批准后冻结已检查 bytes，workspace 后续修改不影响副本', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, inspection.fingerprint)
    const capability = await store.materialize(inspection)
    await writeFile(join(value.workspace, value.descriptor.entry), '#!/bin/sh\necho changed\n')

    expect(await readFile(capability.entryPath, 'utf8')).toBe('#!/bin/sh\necho v1\n')
    expect(capability.env).toMatchObject({
      SCRY_RECORDER_COMMIT_HOOK: capability.entryPath,
      SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: inspection.fingerprint,
      CLAUDE_PROJECT_DIR: inspection.workspace,
      CODEX_PROJECT_DIR: inspection.workspace,
      QODER_PROJECT_DIR: inspection.workspace,
      OPENCODE_PROJECT_DIR: inspection.workspace,
      OPENCODE_WORKSPACE_DIR: inspection.workspace,
      PYTHONDONTWRITEBYTECODE: '1',
      RATE_NATIVE_ASYNC_QUEUE_DIR: join(value.userData, 'commit-hook-queues', inspection.fingerprint.replace(':', ''))
    })
  })

  it('冻结副本被篡改后 fail closed', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, inspection.fingerprint)
    const capability = await resolveCommitHookCapability(value.workspace, value.descriptor, value.userData)
    await chmod(capability.entryPath, 0o700)
    await writeFile(capability.entryPath, 'tampered')
    await expect(store.materialize(inspection)).rejects.toThrow('damaged')
    await store.revoke(value.workspace, inspection.fingerprint)
    expect(await store.isGranted(value.workspace, inspection.fingerprint)).toBe(false)
  })

  it('冻结副本出现 descriptor 之外的文件后 fail closed', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, inspection.fingerprint)
    const capability = await store.materialize(inspection)
    await writeFile(join(capability.entryPath, '..', 'injected.py'), 'malicious')

    await expect(store.materialize(inspection)).rejects.toThrow('damaged')
  })

  it('静默恢复只返回当前仍匹配的已有授权', async () => {
    const value = await fixture()
    await expect(resolveGrantedCommitHookCapability(value.workspace, value.descriptor, value.userData)).resolves.toBeNull()

    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    await createCommitHookTrustStore(value.userData).grant(value.workspace, inspection.fingerprint)
    await expect(resolveGrantedCommitHookCapability(value.workspace, value.descriptor, value.userData))
      .resolves.toMatchObject({ fingerprint: inspection.fingerprint })

    await writeFile(join(value.workspace, 'hooks', 'helper.txt'), 'dependency-v2\n')
    await expect(resolveGrantedCommitHookCapability(value.workspace, value.descriptor, value.userData)).resolves.toBeNull()
  })

  // 维护者决定：仓库 commit 回调默认统一放行，不再弹窗。但自动放行不得冒充成用户批准。
  it('默认策略是 auto_grant，只有显式环境变量才恢复询问', () => {
    expect(commitHookTrustPolicy({})).toBe('auto_grant')
    expect(commitHookTrustPolicy({ SCRY_COMMIT_HOOK_TRUST: 'auto_grant' })).toBe('auto_grant')
    expect(commitHookTrustPolicy({ SCRY_COMMIT_HOOK_TRUST: 'prompt' })).toBe('prompt')
  })

  it('autoGrant 下无需预先授权即可物化，且授权记录标注 source=auto', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)

    await expect(resolveGrantedCommitHookCapability(value.workspace, value.descriptor, value.userData))
      .resolves.toBeNull()
    await expect(resolveGrantedCommitHookCapability(
      value.workspace,
      value.descriptor,
      value.userData,
      undefined,
      { autoGrant: true }
    )).resolves.toMatchObject({ fingerprint: inspection.fingerprint })

    const grants = JSON.parse(await readFile(join(value.userData, 'commit-hook-grants.json'), 'utf8'))
    expect(grants.grants).toHaveLength(1)
    expect(grants.grants[0]).toMatchObject({
      workspace: inspection.workspace,
      fingerprint: inspection.fingerprint,
      source: 'auto'
    })

    // 指纹变了也不再阻断：自动换成新指纹的授权，依旧只执行冻结字节。
    await writeFile(join(value.workspace, 'hooks', 'helper.txt'), 'dependency-v2\n')
    const next = await inspectCommitHookBundle(value.workspace, value.descriptor)
    await expect(resolveGrantedCommitHookCapability(
      value.workspace,
      value.descriptor,
      value.userData,
      undefined,
      { autoGrant: true }
    )).resolves.toMatchObject({ fingerprint: next.fingerprint })
  })

  it('用户批准与自动放行在授权记录里可区分，旧记录视为用户批准', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)

    await store.grant(value.workspace, inspection.fingerprint)
    let grants = JSON.parse(await readFile(join(value.userData, 'commit-hook-grants.json'), 'utf8'))
    expect(grants.grants[0].source).toBe('user')

    await store.grant(value.workspace, inspection.fingerprint, 'auto')
    grants = JSON.parse(await readFile(join(value.userData, 'commit-hook-grants.json'), 'utf8'))
    expect(grants.grants[0].source).toBe('auto')

    await writeFile(
      join(value.userData, 'commit-hook-grants.json'),
      `${JSON.stringify({ version: 1, grants: [{ workspace: inspection.workspace, fingerprint: inspection.fingerprint, grantedAt: 1 }] })}\n`,
      { mode: 0o600 }
    )
    await expect(store.isGranted(value.workspace, inspection.fingerprint)).resolves.toBe(true)
  })

  it('信任库只枚举去重后的已授权 workspace', async () => {
    const value = await fixture()
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, inspection.fingerprint)
    await store.grant(value.workspace, inspection.fingerprint)

    await expect(store.grantedWorkspaces()).resolves.toEqual([inspection.workspace])
  })

  it('冷启动无授权时不检查或执行 workspace callback', async () => {
    const value = await fixture()
    const capture = join(value.workspace, 'capture.jsonl')
    await writeFile(join(value.workspace, value.descriptor.entry), `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
    await enableRecorder(value.workspace, value.descriptor)
    await completeTurn(value.workspace, 'no-grant')

    await expect(redeliverGrantedCommitHooksAtStartup(value.userData)).resolves.toEqual({
      redelivered: 0, skipped: 0, errors: []
    })
    await expect(access(capture)).rejects.toThrow()
  })

  it('冷启动只对当前指纹匹配的冻结 callback 重投最新 record', async () => {
    const value = await fixture()
    const capture = join(value.workspace, 'capture.jsonl')
    await writeFile(join(value.workspace, value.descriptor.entry), `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
    await enableRecorder(value.workspace, value.descriptor)
    await completeTurn(value.workspace, 'startup-1')
    await completeTurn(value.workspace, 'startup-2')
    const inspection = await inspectCommitHookBundle(value.workspace, value.descriptor)
    const store = createCommitHookTrustStore(value.userData)
    await store.grant(value.workspace, inspection.fingerprint)
    const capability = await store.materialize(inspection)
    await drainCommitNotifications(join(value.workspace, '.scry'), { ...process.env, ...capability.env })
    const statePath = join(value.workspace, '.scry', 'notifications', 'commit-hook-state.json')
    const before = await readFile(statePath, 'utf8')
    await writeFile(capture, '')

    await expect(redeliverGrantedCommitHooksAtStartup(value.userData)).resolves.toEqual({
      redelivered: 1, skipped: 0, errors: []
    })
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(rows).toEqual([expect.objectContaining({ sessionId: 'startup-2', sequence: 2 })])
    expect(await readFile(statePath, 'utf8')).toBe(before)

    await writeFile(join(value.workspace, 'hooks', 'helper.txt'), 'dependency-v2\n')
    await writeFile(capture, '')
    await expect(redeliverGrantedCommitHooksAtStartup(value.userData)).resolves.toEqual({
      redelivered: 0, skipped: 1, errors: []
    })
    expect(await readFile(capture, 'utf8')).toBe('')
  })
})
