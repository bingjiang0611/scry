import { app, shell } from 'electron'
import type { ProviderId } from '../../shared/provider'
import type { UsageAnalyticsRangeDays } from '../../shared/trace'
import { join } from 'node:path'
import type { RemoteHostService } from '../remote/remote-host-service'
import { shellEnv, warmShellEnv } from '../claude-locate'
import { buildMcpExecutionSnapshot } from '../mcp-execution-trust'
import { isMcpGuardReport } from '../../shared/mcpguard-report'
import { usageAnalyticsWithCreditsQuery } from '../db'
import { readLlmPerformanceHistory } from '../llm-performance-history'
import { summarizeRunningLlmSessions } from '../../shared/llm-performance'
import { resolveRemoteRelay } from './remote-relay'
import { createRemoteHistoryHandlers } from './remote-history'
import { RunOutputWorkerStore } from '../remote/run-output-worker'
import { remoteHostEnabled } from '../remote/remote-defaults'
import type { IpcMainInvokeEvent } from 'electron'
import type { RemoteStatus } from '../../shared/remote'

import { createHostRuntime } from '../../host-runtime/host-runtime'
import type { RemoteHostRuntime, RemoteRuns, RemoteReceipts, DeleteOptions, RemoteStartOptions } from '../../host-runtime/host-runtime-types'

export type { RemoteHostRuntime, RemoteRuns, RemoteReceipts, DeleteOptions, RemoteStartOptions }
export async function startRemoteHostIfEnabled(runtime: RemoteHostRuntime): Promise<void> {

  if (runtime.remoteHostService || !remoteHostEnabled(process.env.SCRY_REMOTE_HOST, app.isPackaged)) return
  try {
    const stateDirectory = join(app.getPath('userData'), 'remote')
    const relay = await resolveRemoteRelay(stateDirectory)
    await runtime.refreshRemoteProviderSnapshot()
    if (!runtime.remoteProviderRefresh) runtime.remoteProviderRefresh = setInterval(() => { void runtime.refreshRemoteProviderSnapshot() }, 15_000)
    const remotePermissionRaw = process.env.SCRY_REMOTE_PERMISSION_MODE
    const remotePermissionMode = runtime.configuredRemotePermissionMode()
    if (remotePermissionRaw && !remotePermissionMode) console.warn(`[scry] ignoring invalid SCRY_REMOTE_PERMISSION_MODE=${remotePermissionRaw}`)
    else if (remotePermissionMode) console.warn(`[scry] remote runs use owner-set permissionMode=${remotePermissionMode}`)
    const historyHandlers = createRemoteHistoryHandlers(runtime, app.getPath('userData'))
    const service = await createHostRuntime({
      runtime,
      stateDirectory,
      userDataDir: app.getPath('userData'),
      relay,
      gatewayLabel: 'Mac1',
      shellEnvironment: warmShellEnv,
      openPath: runtime.openLocalPath,
      trashItem: (path: string) => shell.trashItem(path),
      historyHandlers,
      // This expression stays in out/main/index.js, beside the worker entry. The
      // store module is shared with the daemon and may be emitted under chunks, so
      // its own import.meta.url is not a stable production base.
      createOutputStore: (directory) => RunOutputWorkerStore.create(
        directory,
        new URL('./run-output-file-worker.js', import.meta.url)
      ),
      toolPanels: {
        analytics: (rangeDays: UsageAnalyticsRangeDays) => usageAnalyticsWithCreditsQuery(rangeDays),
        llmPerformance: async () => [await readLlmPerformanceHistory(app.getPath('userData')),
        summarizeRunningLlmSessions(runtime.runs.activeStates())] as const,
        mcpTrust: async ({ providerId }: { providerId: string }) => {
          if (runtime.providerRegistry.isDisabled(providerId as ProviderId)) {
            return { snapshot: null, unavailable: '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用' }
          }
          if (providerId === 'pi') {
            return { snapshot: null, unavailable: 'Pi snapshot 仅返回脱敏后的有效配置与运行态，不包含 MCP Guard 所需的可执行配置和凭据指纹' }
          }
          const context = { providerId: providerId as ProviderId, cwd: runtime.getCurrentCwd() ?? '' }
          const envelope = await runtime.providerRegistry.mcpSnapshot(context, false)
          let scan: unknown
          try {
            const built = buildMcpExecutionSnapshot({
              providerId: context.providerId,
              cwd: context.cwd,
              homeDir: runtime.homeDir,
              settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
              env: shellEnv()
            })
            if (isMcpGuardReport(built.report)) scan = built.report
          } catch {
            scan = undefined
          }
          return { snapshot: envelope.data, ...(scan ? { scan } : {}) }
        }
      }
    })
    runtime.remoteHostService = service
    await service.start()
    console.warn(`[scry] remote host subsystem started (${relay.createTransport ? 'relay transport configured' : 'dormant: no relay transport configured'})`)
  } catch (error) {
    console.warn('[scry] remote host subsystem failed to start:', error)
    try { await runtime.remoteHostService?.dispose() } catch (cleanupError) {
      console.warn('[scry] failed remote host cleanup:', cleanupError)
    }
    runtime.remoteHostService = null
  }
}


type TrustedHandler = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void

export function registerRemoteHostHandlers(handleTrusted: TrustedHandler, runtime: RemoteHostRuntime): void {
  const requireRemoteHost = (): RemoteHostService => {
    const service = runtime.remoteHostService
    if (!service) throw new Error('远程访问未启用')
    return service
  }
  handleTrusted('remote:status', (): RemoteStatus => runtime.remoteHostService ? runtime.remoteHostService.status() : { enabled: false })
  handleTrusted('remote:desktop:status', () => runtime.remoteHostService?.desktopStatus() ?? { enabled: false })
  handleTrusted('remote:desktop:invite', () => requireRemoteHost().beginDesktopPairing())
  handleTrusted('remote:desktop:disable', () => requireRemoteHost().disableDesktop())
  handleTrusted('remote:pairing:begin', () => requireRemoteHost().beginPairing())
  handleTrusted('remote:pairing:confirm', (_event, pairingId: unknown, expectedPublicKeySHA256: unknown) => {
    if (typeof pairingId !== 'string' || typeof expectedPublicKeySHA256 !== 'string') throw new Error('无效的配对确认参数')
    return requireRemoteHost().confirmPairing(pairingId, expectedPublicKeySHA256)
  })
  handleTrusted('remote:pairing:cancel', (_event, pairingId: unknown) => {
    if (typeof pairingId !== 'string') throw new Error('无效的配对标识')
    return requireRemoteHost().cancelPairing(pairingId)
  })
  handleTrusted('remote:device:revoke', (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new Error('无效的设备标识')
    return requireRemoteHost().revokeDevice(deviceId)
  })
}
