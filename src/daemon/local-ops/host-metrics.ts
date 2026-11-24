import type { HostMetricsSnapshot } from '../../shared/host-metrics'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

// The App's own machine (P8 §5): a local-only op, because the App main process may
// not run `ps` (no child_process) and the daemon already owns the sampling.
// `read` returns the local scope, which is the only scope allowed to carry a PID.
export const hostMetricsLocalOps: DaemonLocalOpGroup = (deps) => ({
  'hostMetrics:read': (async (...args: unknown[]): Promise<HostMetricsSnapshot> => {
    if (args.length > 0) throw new Error('invalid_request')
    if (!deps.hostMetrics) throw new Error('host_metrics_unavailable')
    return await deps.hostMetrics()
  }) as LocalOpHandler
} as Record<string, LocalOpHandler>)
