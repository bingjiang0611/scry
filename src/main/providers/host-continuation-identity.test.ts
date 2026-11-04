import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count real executable opens without replacing the filesystem itself.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
import { open } from 'node:fs/promises'
import { openCodeContinuationKey, qoderContinuationKey } from './host-continuation-identity'

describe('host continuation identity', () => {
  let root = ''
  let home = ''
  let config = ''
  let workspace = ''
  let executable = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scry-host-identity-'))
    home = join(root, 'home')
    config = join(root, 'config')
    workspace = join(root, 'workspace')
    executable = join(root, 'qodercli')
    await mkdir(join(config, '.auth'), { recursive: true })
    await mkdir(home, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(config, '.auth', 'user'), 'qoder-raw-credential')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)
    vi.mocked(open).mockClear()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const qoderKey = (
    cwd = workspace,
    overrides: { executable?: string; env?: Record<string, string> } = {}
  ): Promise<string> => qoderContinuationKey(
    { providerId: 'qoder', cwd },
    home,
    overrides.executable ?? executable,
    { QODER_CONFIG_DIR: config, ...overrides.env }
  )

  const openCodeKey = (
    overrides: { cwd?: string; sessionStateRoot?: string; env?: Record<string, string> } = {}
  ): Promise<string> => openCodeContinuationKey(
    { providerId: 'opencode', cwd: overrides.cwd ?? workspace },
    {
      homeDir: home,
      executable,
      sessionStateRoot: overrides.sessionStateRoot,
      runtimeEnv: { XDG_DATA_HOME: join(root, 'data'), ...overrides.env }
    }
  )

  it('derives a stable Qoder key from the same cwd, executable, config root and auth', async () => {
    const key = await qoderKey()
    expect(await qoderKey()).toBe(key)
    expect(key).toMatch(/^qoder:[a-f0-9]{64}$/)
  })

  it('changes the Qoder key when the persisted auth material changes', async () => {
    const before = await qoderKey()
    await writeFile(join(config, '.auth', 'user'), 'rotated-credential')
    expect(await qoderKey()).not.toBe(before)
  })

  it('changes the Qoder key when the workspace or the executable content changes', async () => {
    const other = join(root, 'other-workspace')
    const otherBin = join(root, 'other-cli')
    await mkdir(other, { recursive: true })
    await writeFile(otherBin, '#!/bin/sh\necho other\n')
    await chmod(otherBin, 0o755)
    const base = await qoderKey()
    expect(await qoderKey(other)).not.toBe(base)
    const otherIdentity = await qoderKey(workspace, { executable: otherBin })
    expect(otherIdentity).not.toBe(base)
    // Same path, mutated content: the cached digest must not outlive the file.
    await writeFile(otherBin, '#!/bin/sh\necho mutated\n')
    await chmod(otherBin, 0o755)
    expect(await qoderKey(workspace, { executable: otherBin })).not.toBe(otherIdentity)
  })

  it('hashes an unchanged executable once for concurrent callers', async () => {
    const keys = await Promise.all([qoderKey(), qoderKey(), qoderKey()])
    expect(new Set(keys).size).toBe(1)
    await qoderKey()
    // One open for the executable across the concurrent and repeated calls; the
    // auth file is read each time because it is small and re-verified.
    const canonical = await realpath(executable)
    const executableOpens = vi.mocked(open).mock.calls.filter(([path]) => path === canonical)
    expect(executableOpens).toHaveLength(1)
  })

  it('never returns raw Qoder credentials', async () => {
    expect(await qoderKey()).not.toContain('qoder-raw-credential')
    expect(await qoderKey(workspace, { env: { QODER_PERSONAL_ACCESS_TOKEN: 'secret-token' } }))
      .not.toContain('secret-token')
  })

  it('fails closed for Qoder when no auth material can be verified', async () => {
    await rm(join(config, '.auth', 'user'))
    await expect(qoderKey()).rejects.toThrow('Qoder 缺少可验证的认证状态')
  })

  it('fails closed for an unresolvable workspace instead of guessing an identity', async () => {
    await expect(qoderKey(join(root, 'missing-workspace'))).rejects.toThrow('Provider 工作目录 不可解析')
    await expect(openCodeKey({ cwd: join(root, 'missing-workspace') })).rejects.toThrow('Provider 工作目录 不可解析')
  })

  it('changes the OpenCode key when the auth state or session root changes', async () => {
    const authPath = join(root, 'data', 'opencode', 'auth.json')
    await mkdir(join(root, 'data', 'opencode'), { recursive: true })
    await writeFile(authPath, '{"anthropic":{"key":"one"}}')
    const base = await openCodeKey({ sessionStateRoot: join(root, 'sessions') })
    expect(await openCodeKey({ sessionStateRoot: join(root, 'sessions') })).toBe(base)
    await writeFile(authPath, '{"anthropic":{"key":"two"}}')
    expect(await openCodeKey({ sessionStateRoot: join(root, 'sessions') })).not.toBe(base)
    expect(await openCodeKey({ sessionStateRoot: join(root, 'other-sessions') })).not.toBe(base)
  })

  it('separates a proven absent OpenCode auth file from an unverifiable one', async () => {
    // No auth.json and no inherited auth material is a supported anonymous start.
    const anonymous = await openCodeKey({ sessionStateRoot: join(root, 'sessions') })
    expect(anonymous).toMatch(/^opencode:[a-f0-9]{64}$/)
    expect(await openCodeKey({ sessionStateRoot: join(root, 'sessions') })).toBe(anonymous)
    // Injected auth material is part of the identity, so its presence changes the key.
    expect(await openCodeKey({ sessionStateRoot: join(root, 'sessions'), env: { OPENCODE_AUTH_CONTENT: '{"x":1}' } }))
      .not.toBe(anonymous)
    // A path that exists but cannot be verified fails closed instead of pretending absence.
    await mkdir(join(root, 'data', 'opencode', 'auth.json'), { recursive: true })
    await expect(openCodeKey({ sessionStateRoot: join(root, 'sessions') }))
      .rejects.toThrow('OpenCode auth 状态 不是普通文件')
  })

  it('never returns raw OpenCode credentials', async () => {
    const key = await openCodeKey({ sessionStateRoot: join(root, 'sessions'), env: { OPENCODE_API_KEY: 'opencode-secret' } })
    expect(key).not.toContain('opencode-secret')
    expect(key).toMatch(/^opencode:[a-f0-9]{64}$/)
  })
})
