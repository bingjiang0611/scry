import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import { ProviderOperationGate } from '../provider-operation-gate'
import { prepareRunFrontdoor } from './run-frontdoor'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }))
// 登录 shell 采集属于本机环境准备，与工作区语义无关。
vi.mock('../claude-locate', () => ({ warmShellEnv: async () => ({}) }))

// 真实目录：App 语义会用 realpath 校验当前授权目录，不能用假路径。
const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-workspace-semantics-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const APP_CWD = join(root, 'project')
const DEVICE_CWD = join(root, 'device-project')
mkdirSync(APP_CWD)

function frontdoor(options: { grantScope?: 'local' | 'remote'; cwd?: string }) {
  const resolveKnownProjectDirectory = vi.fn((cwd: string) => {
    if (cwd !== APP_CWD) throw new Error('unknown_project')
    return APP_CWD
  })
  const resolveRemoteProjectDirectory = vi.fn((cwd: string) => cwd)
  const payload: AgentStartRequest = {
    prompt: 'go',
    providerId: 'claude',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  }
  const result = prepareRunFrontdoor(payload, { origin: 'remote', ...(options.grantScope ? { grantScope: options.grantScope } : {}) }, {
    providerRegistry: {
      get: () => ({ id: 'claude', runtimeProvider: 'claude_sdk', hookTrust: { inspect: async () => null } })
    } as unknown as ProviderRegistry,
    isShuttingDown: false,
    currentCwd: APP_CWD,
    appSessionStore: () => ({ isArchived: () => false }),
    resolveRemoteProjectDirectory,
    resolveKnownProjectDirectory,
    providerOperationGate: new ProviderOperationGate(),
    providerContextKey: (id: ProviderId, cwd: string, profile?: string) => `${id}\0${profile ?? ''}\0${cwd}`
  })
  return { result, resolveKnownProjectDirectory, resolveRemoteProjectDirectory }
}

// L3: the working directory rule follows the submitter, not the socket. The App's own
// grant resolves against known projects; a device's grant keeps the remote projection.
describe('workspace rule per verified grant scope', () => {
  it('resolves a local grant through the App known-project rule', () => {
    const { result, resolveKnownProjectDirectory, resolveRemoteProjectDirectory } = frontdoor({ grantScope: 'local', cwd: APP_CWD })
    expect(resolveKnownProjectDirectory).toHaveBeenCalledWith(APP_CWD)
    expect(resolveRemoteProjectDirectory).not.toHaveBeenCalled()
    expect(result.cwd).toBe(APP_CWD)
    expect(result.appSemantics).toBe(true)
    expect(result.isRemoteRun).toBe(true)
  })

  it('keeps the remote projection for a device grant', () => {
    const { result, resolveKnownProjectDirectory, resolveRemoteProjectDirectory } = frontdoor({ grantScope: 'remote', cwd: DEVICE_CWD })
    expect(resolveRemoteProjectDirectory).toHaveBeenCalledWith(DEVICE_CWD)
    expect(resolveKnownProjectDirectory).not.toHaveBeenCalled()
    expect(result.appSemantics).toBe(false)
  })

  it('fails closed to the remote projection when the scope is not proven', () => {
    const { resolveKnownProjectDirectory, resolveRemoteProjectDirectory } = frontdoor({ cwd: DEVICE_CWD })
    expect(resolveRemoteProjectDirectory).toHaveBeenCalledTimes(1)
    expect(resolveKnownProjectDirectory).not.toHaveBeenCalled()
  })

  it('keeps the App rule that a grant cannot send into an unknown project', () => {
    // A local grant is the App, so a directory the App does not know is refused with
    // the App's own rejection rather than silently projected by the remote resolver.
    expect(() => frontdoor({ grantScope: 'local', cwd: '/tmp/not-a-project' })).toThrow()
  })
})
