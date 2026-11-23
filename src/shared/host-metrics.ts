// Host metrics (P8 机器管理): what one machine reports about its own resources.
// Sampled on demand by the daemon, cached briefly, and redacted before a paired
// device or another Desktop may read it.
//
// Every unreadable number is `null`, never 0: "we could not read the swap" and
// "the machine has no swap in use" are different facts and must not look alike.

export type HostMetricsScope = 'local' | 'remote'
export type HostMemoryPressure = 'low' | 'medium' | 'high'
export type HostDiskRole = 'data' | 'workspace'

// Provider id, or 'other' for a descendant whose provider cannot be named
// (P8 §3: an unattributable child counts as 「其他」, never as a Provider).
export interface HostProviderUsage {
  providerId: string
  processes: number
  cpuPercent: number | null
  rssBytes: number
}

export interface HostMetricsSnapshot {
  /** Epoch milliseconds of the read this snapshot was assembled from. */
  sampledAt: number
  uptimeSec: number | null
  cpu: { percent: number | null; cores: number; load1: number | null }
  memory: {
    totalBytes: number
    usedBytes: number | null
    pressure: HostMemoryPressure | null
    swapUsedBytes: number | null
    /** Total swap the machine has configured; the swap bar needs a denominator. */
    swapTotalBytes: number | null
  }
  /** One entry per volume, deduplicated by volume. Only the role is a name. */
  disks: Array<{ role: HostDiskRole; totalBytes: number; freeBytes: number }>
  scry: {
    daemon: {
      cpuPercent: number | null
      rssBytes: number
      /** Local scope only; stripped before any remote answer. */
      pid?: number
    }
    /** null = the process table could not be read this time (not "no processes"). */
    providers: HostProviderUsage[] | null
  }
  runs: { active: number; queued: number }
}

/** Cached snapshots younger than this are returned as they are (P8 §4). */
export const HOST_METRICS_CACHE_MS = 5_000
/** Two real samples are never closer than this, however often the page refreshes. */
export const HOST_METRICS_MIN_INTERVAL_MS = 2_000
/** The daemon reads the CPU twice on a cold start, 500 ms apart (P8 §4). */
export const HOST_METRICS_COLD_CPU_GAP_MS = 500
/** A single answer never exceeds this; the sampler caps its own provider rows. */
export const HOST_METRICS_MAX_BYTES = 8 * 1024
/** Resource-bar thresholds shared by every machine card (P8: 70% / 85%). */
export const HOST_METRICS_WARN_PERCENT = 70
export const HOST_METRICS_DANGER_PERCENT = 85

/**
 * The shape a remote peer receives (P8 §5). PID is local detail only, so it is
 * dropped here rather than at each transport: Desktop forwarding and the paired
 * device path both go through this function.
 */
export function redactHostMetricsForRemote(snapshot: HostMetricsSnapshot): HostMetricsSnapshot {
  const { pid: _pid, ...daemon } = snapshot.scry.daemon
  return { ...snapshot, scry: { ...snapshot.scry, daemon } }
}

/** True when the serialized snapshot stays inside the protocol's 8 KiB bound. */
export function hostMetricsWithinBound(snapshot: HostMetricsSnapshot): boolean {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= HOST_METRICS_MAX_BYTES
}

/** Share of a whole, or null when the whole is unknown or zero. */
export function hostMetricsPercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)))
}

export function hostMetricsTone(percent: number | null | undefined): 'normal' | 'warn' | 'danger' | 'none' {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'none'
  if (percent >= HOST_METRICS_DANGER_PERCENT) return 'danger'
  if (percent >= HOST_METRICS_WARN_PERCENT) return 'warn'
  return 'normal'
}
