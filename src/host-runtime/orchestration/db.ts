import type Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, statfsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { migrateOrchestrationDatabase } from './migrations'
import { ORCHESTRATION_MIGRATIONS } from './schema'
import { OrchestrationStoreError } from './types'

const require = createRequire(import.meta.url)

const NETWORK_FS_MESSAGE = '后台服务的运行记录需要本地磁盘，当前数据目录在网络文件系统上'

// Linux statfs magic numbers for network/distributed filesystems (plan §8.3).
const LINUX_NETWORK_FS_MAGIC = new Set([
  0x6969, // NFS_SUPER_MAGIC
  0xff534d42, // CIFS_MAGIC_NUMBER
  0xfe534d42, // SMB2_MAGIC_NUMBER
  0x517b, // SMB_SUPER_MAGIC
  0x5346414f, // AFS_SUPER_MAGIC
  0x00c36400, // CEPH_SUPER_MAGIC
  0x01021997 // V9FS_MAGIC
])

export function detectNetworkFilesystem(directory: string): boolean {
  if (process.platform === 'linux') {
    try {
      const stats = statfsSync(directory)
      return LINUX_NETWORK_FS_MAGIC.has(stats.type)
    } catch {
      return false
    }
  }
  if (process.platform === 'darwin') {
    // One-time open check: BSD `df -T nfs,smbfs,afpfs,webdav,autofs <dir>` exits 0 iff
    // the directory resides on one of those network filesystem types.
    try {
      const res = spawnSync('df', ['-T', 'nfs,smbfs,afpfs,webdav,autofs', directory], {
        encoding: 'utf8',
        timeout: 2_000
      })
      return res.status === 0 && res.stdout.trim().split('\n').length >= 2
    } catch {
      return false
    }
  }
  return false
}

export function enforceOrchestrationFileModes(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600)
  }
}

export interface OpenOrchestrationDbOptions {
  userDataDir: string
  /** Optional override for macOS fullfsync experiment (plan §8.3). */
  fullfsync?: boolean
  checkpointFullfsync?: boolean
  /** Injectable test seam for network filesystem detection. */
  isNetworkFilesystem?: (dir: string) => boolean
  logId?: string
}

export interface WalCheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

export interface WalCheckpointSample {
  mode: 'passive' | 'truncate'
  durationMs: number
  walBytesBefore: number
  walBytesAfter: number
  result: WalCheckpointResult
  executor?: 'main' | 'worker'
  threadId?: number
}

export interface OrchestrationDbHandle {
  readonly db: Database.Database
  readonly dbPath: string
  readonly orchestrationDir: string
  readonly checkpointFullfsync: boolean
  enforceModes(): void
  /** Switches locking_mode temporarily to NORMAL for same-process worker checkpoints and back to EXCLUSIVE. */
  setLockingMode(mode: 'normal' | 'exclusive'): void
  /** Current `-wal` file size in bytes (0 when absent). */
  walFileBytes(): number
  /** Runs a non-blocking PASSIVE WAL checkpoint off the commit critical path. */
  checkpointPassive(): WalCheckpointResult
  /** Runs a TRUNCATE WAL checkpoint to reclaim `-wal` file size under EXCLUSIVE lock. */
  checkpointTruncate(): WalCheckpointResult
  close(options?: { skipCheckpoint?: boolean }): void
}

function classifyOpenError(error: unknown): OrchestrationStoreError {
  if (error instanceof OrchestrationStoreError) return error
  const code = (error as { code?: string })?.code ?? ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked/i.test(message)) {
    return new OrchestrationStoreError('orchestration_db_locked', message)
  }
  if (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    /not a database|malformed|corrupt/i.test(message)
  ) {
    return new OrchestrationStoreError('orchestration_db_corrupt', message)
  }
  return new OrchestrationStoreError('orchestration_write_indeterminate', message)
}

export function openOrchestrationDatabase(options: OpenOrchestrationDbOptions): OrchestrationDbHandle {
  const orchestrationDir = join(options.userDataDir, 'orchestration')
  mkdirSync(orchestrationDir, { recursive: true, mode: 0o700 })
  chmodSync(orchestrationDir, 0o700)

  const checkNetFs = options.isNetworkFilesystem ?? detectNetworkFilesystem
  if (checkNetFs(orchestrationDir)) {
    throw new OrchestrationStoreError('orchestration_network_filesystem', NETWORK_FS_MESSAGE)
  }

  const dbPath = join(orchestrationDir, 'orchestration.db')
  const DatabaseCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  let db: Database.Database | null = null

  try {
    db = new DatabaseCtor(dbPath, { timeout: 0 })
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600)

    // Layer 2 single-writer lock (core §2.9): acquire EXCLUSIVE before WAL/migration.
    db.pragma('locking_mode = EXCLUSIVE')
    db.pragma('journal_mode = WAL')
    // Move WAL checkpoints off the commit critical path (W9 P4-2); explicit PASSIVE checkpoints run idle.
    db.pragma('wal_autocheckpoint = 0')
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')
    // Maintainer decision (2026-11-20): macOS defaults fullfsync=ON and checkpoint_fullfsync=ON
    // in P4-2 authoritative mode; callers (e.g. P4-1 shadow or experiments) may explicitly override.
    const fullfsync = options.fullfsync ?? true
    const checkpointFullfsync = options.checkpointFullfsync ?? true
    db.pragma(`fullfsync = ${fullfsync ? 'ON' : 'OFF'}`)
    db.pragma(`checkpoint_fullfsync = ${checkpointFullfsync ? 'ON' : 'OFF'}`)

    const integrity = db.pragma('integrity_check(1)', { simple: true }) as string
    if (integrity !== 'ok') {
      throw new OrchestrationStoreError('orchestration_db_corrupt', `integrity_check failed: ${integrity}`)
    }

    migrateOrchestrationDatabase(db, ORCHESTRATION_MIGRATIONS, { logId: options.logId })

    // Force acquisition of the exclusive lock even when no migration statements ran.
    db.prepare('BEGIN IMMEDIATE').run()
    db.prepare('COMMIT').run()

    enforceOrchestrationFileModes(dbPath)
    const liveDb = db
    return {
      db: liveDb,
      dbPath,
      orchestrationDir,
      checkpointFullfsync,
      enforceModes: () => enforceOrchestrationFileModes(dbPath),
      setLockingMode: (mode) => {
        if (!liveDb.open) return
        if (mode === 'normal') {
          // SQLite exclusive-mode WAL only releases the exclusive lock after cycling through DELETE.
          liveDb.pragma('busy_timeout = 500')
          liveDb.pragma('journal_mode = DELETE')
          liveDb.pragma('locking_mode = NORMAL')
          liveDb.prepare('SELECT value FROM orch_meta LIMIT 1').get()
          liveDb.pragma('journal_mode = WAL')
          liveDb.pragma('wal_autocheckpoint = 0')
          liveDb.prepare('SELECT value FROM orch_meta LIMIT 1').get()
        } else {
          liveDb.pragma('locking_mode = EXCLUSIVE')
          liveDb.prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('wal_lock_mode', 'exclusive')").run()
          liveDb.pragma('busy_timeout = 0')
        }
        enforceOrchestrationFileModes(dbPath)
      },
      walFileBytes: () => {
        const walPath = `${dbPath}-wal`
        try {
          return existsSync(walPath) ? statSync(walPath).size : 0
        } catch {
          return 0
        }
      },
      checkpointPassive: () => {
        if (!liveDb.open) return { busy: 0, log: 0, checkpointed: 0 }
        const rows = liveDb.pragma('wal_checkpoint(PASSIVE)') as Array<{
          busy?: number
          log?: number
          checkpointed?: number
        }>
        const row = rows[0]
        return {
          busy: Number(row?.busy ?? 0),
          log: Number(row?.log ?? 0),
          checkpointed: Number(row?.checkpointed ?? 0)
        }
      },
      checkpointTruncate: () => {
        if (!liveDb.open) return { busy: 0, log: 0, checkpointed: 0 }
        const rows = liveDb.pragma('wal_checkpoint(TRUNCATE)') as Array<{
          busy?: number
          log?: number
          checkpointed?: number
        }>
        const row = rows[0]
        return {
          busy: Number(row?.busy ?? 0),
          log: Number(row?.log ?? 0),
          checkpointed: Number(row?.checkpointed ?? 0)
        }
      },
      close: (closeOptions) => {
        if (!liveDb.open) return
        if (!closeOptions?.skipCheckpoint) {
          try {
            liveDb.pragma('wal_checkpoint(TRUNCATE)')
          } catch {
            // Preserve clean close semantics even if checkpoint cannot run.
          }
        }
        liveDb.close()
      }
    }
  } catch (error) {
    try {
      if (db?.open) db.close()
    } catch {
      // Preserve the original open/migration failure.
    }
    throw classifyOpenError(error)
  }
}
