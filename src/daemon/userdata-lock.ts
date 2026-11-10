import { acquireDaemonLock, type AcquireDaemonLockOptions, type DaemonLockRecord } from './ledger-lock'

// One writer per userData directory (P3-userdata-lock.md). `daemon.lock` only says "one
// daemon per state directory", and the state directory and userData are two separate
// settings, so two daemons could still share scry.db, the session ledger and the
// remote ledger. This lock sits at the userData root and uses the same evidence as
// daemon.lock: a verified live holder blocks, a dead or pid-reused holder is taken over
// as a file operation, and a holder this module cannot verify blocks (fail closed).
export const USERDATA_LOCK_NAME = 'scry-userdata.lock'

/** Machine code a refused daemon exits with; the supervisor treats it as deterministic. */
export const USERDATA_OWNED_ERROR = 'daemon_userdata_owned'

/** `app` is reserved for the switch-off App (option B in the design); nothing writes it yet. */
export type UserDataOwnerRole = 'daemon'

export type UserDataLockOutcome =
  | { status: 'acquired'; record: DaemonLockRecord; previous?: DaemonLockRecord; release: () => void }
  // Another live writer owns this userData. The caller must not open any of its files.
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
    // userData is created by Electron with its own mode; owning it is not a reason to
    // change who else may list it.
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
