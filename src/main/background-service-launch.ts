import type { BackgroundServiceRuntimeNotice } from '../shared/background-service'
import type { LoginStartMutationResult } from '../daemon/login-start'

// Coordinates launching the background service through the OS service manager when
// login-start is installed, falling back to direct supervisor spawn on failure or
// ready-timeout (P5-headless-host §2.4). Free of Electron so it can be unit-tested.

export type LaunchStepResult = { status: 'started' | 'already-running' | 'failed'; reason?: string }
export type ServiceLaunchFallback = NonNullable<BackgroundServiceRuntimeNotice['serviceLaunchFallback']>

export interface ServiceLaunchControllerDeps {
  canLaunchViaService(): boolean
  startViaService(): Promise<LoginStartMutationResult>
  spawnDirect(): LaunchStepResult
  onFallbackChange?: (fallback: ServiceLaunchFallback | undefined) => void
}

export interface ServiceLaunchController {
  launch(): Promise<LaunchStepResult>
  fallbackAfterTimeout(): Promise<LaunchStepResult>
  usedServiceManager(): boolean
  latestFallback(): ServiceLaunchFallback | undefined
  clearFallback(): void
}

export function createServiceLaunchController(deps: ServiceLaunchControllerDeps): ServiceLaunchController {
  let usedService = false
  let fallback: ServiceLaunchFallback | undefined

  const setFallback = (next: ServiceLaunchFallback | undefined): void => {
    fallback = next
    deps.onFallbackChange?.(next)
  }

  return {
    async launch(): Promise<LaunchStepResult> {
      usedService = false
      if (deps.canLaunchViaService()) {
        const started = await deps.startViaService()
        if (started.ok) {
          usedService = true
          if (fallback !== undefined) setFallback(undefined)
          return { status: 'started' }
        }
        setFallback({
          reason: started.reason,
          ...(started.exitCode !== undefined ? { exitCode: started.exitCode } : {})
        })
      }
      return deps.spawnDirect()
    },
    async fallbackAfterTimeout(): Promise<LaunchStepResult> {
      if (!usedService) return { status: 'failed', reason: 'daemon_ready_timeout' }
      usedService = false
      setFallback({ reason: 'login_start_service_ready_timeout' })
      return deps.spawnDirect()
    },
    usedServiceManager: () => usedService,
    latestFallback: () => fallback,
    clearFallback: () => { if (fallback !== undefined) setFallback(undefined) }
  }
}
