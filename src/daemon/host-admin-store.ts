import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOST_ADMIN_RATE_LIMITS,
  type HostAdminNotice,
  type HostAdminNoticeKind,
  type HostAdminRateAction,
  type HostCliApprovalSelfReport
} from '../shared/host-admin'


export const HOST_ADMIN_FILE_NAME = 'host-admin.json'
const MAX_NOTICES = 32
const NOTICE_RETENTION_MS = 24 * 60 * 60 * 1000

interface PersistedHostAdminState {
  version: 1
  cliApprovalEnabled: boolean
  updatedAt: number | null
  rate: {
    approve: number[]
    invite: number[]
  }
}

export type RateConsumeResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; nextAllowedAt: number }

export interface HostAdminStoreOptions {
  stateDirectory: string
  clock?: () => number
  onNotice?: (notice: HostAdminNotice) => void
}

function emptyState(): PersistedHostAdminState {
  return { version: 1, cliApprovalEnabled: false, updatedAt: null, rate: { approve: [], invite: [] } }
}

function isTimestampList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 256 && value.every((n) => Number.isSafeInteger(n) && n >= 0)
}

function parsePersisted(raw: unknown): PersistedHostAdminState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.version !== 1 || typeof value.cliApprovalEnabled !== 'boolean') return null
  if (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0)) return null
  if (!value.rate || typeof value.rate !== 'object' || Array.isArray(value.rate)) return null
  const rate = value.rate as Record<string, unknown>
  if (!isTimestampList(rate.approve) || !isTimestampList(rate.invite)) return null
  return {
    version: 1,
    cliApprovalEnabled: value.cliApprovalEnabled,
    updatedAt: value.updatedAt as number | null,
    rate: { approve: [...rate.approve], invite: [...rate.invite] }
  }
}

export class HostAdminStore {
  readonly filePath: string
  readonly #dir: string
  readonly #clock: () => number
  readonly #listeners = new Set<(notice: HostAdminNotice) => void>()
  readonly #notices: HostAdminNotice[] = []

  constructor(options: HostAdminStoreOptions) {
    this.#dir = options.stateDirectory
    this.filePath = join(options.stateDirectory, HOST_ADMIN_FILE_NAME)
    this.#clock = options.clock ?? Date.now
    if (options.onNotice) this.#listeners.add(options.onNotice)
  }

  onNotice(listener: (notice: HostAdminNotice) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #readFailClosed(): { state: PersistedHostAdminState; corrupted: boolean } {
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(), corrupted: false }
      return { state: emptyState(), corrupted: true }
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      return { state: emptyState(), corrupted: true }
    }
    try {
      const parsed = parsePersisted(JSON.parse(readFileSync(this.filePath, 'utf8')))
      return parsed ? { state: parsed, corrupted: false } : { state: emptyState(), corrupted: true }
    } catch {
      return { state: emptyState(), corrupted: true }
    }
  }

  #writeAtomic(state: PersistedHostAdminState): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    chmodSync(this.#dir, 0o700)
    const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.filePath)
    chmodSync(this.filePath, 0o600)
  }

  isCliApprovalEnabled(): boolean {
    return this.#readFailClosed().state.cliApprovalEnabled
  }

  snapshot(): HostCliApprovalSelfReport {
    const { state } = this.#readFailClosed()
    return { enabled: state.cliApprovalEnabled, updatedAt: state.updatedAt }
  }

  setCliApprovalEnabled(enabled: boolean): HostCliApprovalSelfReport {
    const { state } = this.#readFailClosed()
    const wasEnabled = state.cliApprovalEnabled
    const now = this.#clock()
    const next: PersistedHostAdminState = {
      ...state,
      cliApprovalEnabled: enabled,
      updatedAt: now
    }
    this.#writeAtomic(next)
    if (!wasEnabled && enabled) {
      this.recordNotice({ kind: 'cli_approval_enabled' })
    }
    return { enabled: next.cliApprovalEnabled, updatedAt: next.updatedAt }
  }

  consumeRate(action: HostAdminRateAction): RateConsumeResult {
    const { state } = this.#readFailClosed()
    const now = this.#clock()
    const { max, windowMs } = HOST_ADMIN_RATE_LIMITS[action]
    const cutoff = now - windowMs
    const recent = state.rate[action].filter((ts) => ts > cutoff && ts <= now + 60_000).sort((a, b) => a - b)
    if (recent.length >= max) {
      const nextAllowedAt = recent[0]! + windowMs
      return { allowed: false, retryAfterMs: Math.max(1_000, nextAllowedAt - now), nextAllowedAt }
    }
    recent.push(now)
    const next: PersistedHostAdminState = {
      ...state,
      rate: {
        ...state.rate,
        [action]: recent
      }
    }
    this.#writeAtomic(next)
    return { allowed: true }
  }

  recordNotice(input: {
    kind: HostAdminNoticeKind
    deviceId?: string
    deviceLabel?: string
    pairingId?: string
    fingerprintPrefix?: string
  }): HostAdminNotice {
    const now = this.#clock()
    const notice: HostAdminNotice = {
      id: randomUUID(),
      kind: input.kind,
      ts: now,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.deviceLabel ? { deviceLabel: input.deviceLabel.slice(0, 320) } : {}),
      ...(input.pairingId ? { pairingId: input.pairingId } : {}),
      ...(input.fingerprintPrefix ? { fingerprintPrefix: input.fingerprintPrefix.slice(0, 16).toLowerCase() } : {})
    }
    this.#notices.push(notice)
    const cutoff = now - NOTICE_RETENTION_MS
    while (this.#notices.length > MAX_NOTICES || (this.#notices.length > 0 && this.#notices[0]!.ts < cutoff)) {
      this.#notices.shift()
    }
    for (const listener of this.#listeners) {
      try { listener(notice) } catch {}
    }
    return notice
  }

  recentNotices(): HostAdminNotice[] {
    const cutoff = this.#clock() - NOTICE_RETENTION_MS
    return this.#notices.filter((n) => n.ts >= cutoff).map((n) => ({ ...n }))
  }
}
