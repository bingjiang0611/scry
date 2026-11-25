import { join } from 'node:path'
import { acquireDaemonLock, readDaemonLockRecord, type AcquireDaemonLockOptions, type DaemonLockRecord } from './ledger-lock'

export const USERDATA_LOCK_NAME = 'scry-userdata.lock'

export const USERDATA_OWNED_ERROR = 'daemon_userdata_owned'

export type UserDataOwnerRole = 'daemon' | 'app'

export type UserDataLockOutcome =
  | { status: 'acquired'; record: DaemonLockRecord; previous?: DaemonLockRecord; release: () => void }
  | { status: 'owned'; holder: DaemonLockRecord; reason: 'live-holder' | 'identity-unverifiable' }

export interface AcquireUserDataLockOptions extends Pick<AcquireDaemonLockOptions,
  'startedBy' | 'pid' | 'lister' | 'daemonEntry' | 'afterValidate' | 'sleep' | 'now'> {
  userDataDir: string
  role: UserDataOwnerRole
}

export async function acquireUserDataLock(options: AcquireUserDataLockOptions): Promise<UserDataLockOutcome> {
  const { userDataDir, role, ...rest } = options
  const outcome = await acquireDaemonLock({
    ...rest,
    directory: userDataDir,
    name: USERDATA_LOCK_NAME,
    restrictDirectory: false,
    role
  })
  if (outcome.status === 'already-running') {
    return { status: 'owned', holder: outcome.holder, reason: outcome.reason ?? 'live-holder' }
  }
  return {
    status: 'acquired',
    record: outcome.record,
    ...(outcome.status === 'replaced-stale' && outcome.previous ? { previous: outcome.previous } : {}),
    release: outcome.release
  }
}

export function readUserDataLockRecord(userDataDir: string): DaemonLockRecord | undefined {
  return readDaemonLockRecord(join(userDataDir, USERDATA_LOCK_NAME))
}
