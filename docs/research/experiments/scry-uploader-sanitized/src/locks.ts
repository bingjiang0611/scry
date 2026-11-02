import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

const BUSY = 'upload worker is already running'
const READY = '__scry_lock_acquired__\n'
// EOF releases the lease even if the caller crashes. These are fixed shell
// instructions; the workspace path is a separate argv entry, never shell text.
const HOLD = "printf '__scry_lock_acquired__\\n'; exec /bin/cat >/dev/null"

function executableSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Kernel lock helper discovery. A hardcoded distribution path breaks Alpine or
 * NixOS, where a missing helper must fail with an actionable error instead of
 * silently removing exclusion.
 */
export function lockHelper(
  target: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { executable: string; args: string[]; busy: number } | undefined {
  const search = (name: string, fallbacks: string[]): string | undefined => {
    for (const directory of (env.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      if (executableSync(join(directory, name))) return join(directory, name)
    }
    return fallbacks.find(candidate => executableSync(candidate))
  }
  if (target === 'darwin') {
    const path = search('lockf', ['/usr/bin/lockf'])
    return path ? { executable: path, args: ['-k', '-t', '0'], busy: 75 } : undefined
  }
  if (target === 'linux') {
    const path = search('flock', ['/usr/bin/flock', '/bin/flock'])
    return path ? { executable: path, args: ['-n'], busy: 1 } : undefined
  }
  return undefined
}

/**
 * The kernel lease is the only thing preventing a second writer. Record the
 * loss with synchronous I/O because the process must not yield to other work
 * between detecting the loss and exiting; this runs once on an unrecoverable
 * path, never on the upload hot path.
 */
function recordLeaseLoss(base: string): void {
  const path = join(base, 'health.json')
  try {
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      current = {}
    }
    const temporary = `${path}.${process.pid}.lease-lost.tmp`
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...current, status: 'error', lastErrorCode: 'lock_lease_lost', lockLeaseLostAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 }
    )
    renameSync(temporary, path)
  } catch {
    // Diagnostics are best effort; losing the lease must still stop this writer.
  }
}

async function retireLegacyDirectory(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!metadata.isDirectory()) return
  let owner: { pid?: number }
  try {
    owner = JSON.parse(await readFile(`${path}/owner.json`, 'utf8'))
  } catch {
    // An incomplete legacy owner is not evidence that its process is dead.
    throw new Error(BUSY)
  }
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) throw new Error(BUSY)
  try {
    process.kill(Number(owner.pid), 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(BUSY)
    // All new-version reclaimers hold the same native lock before this step.
    const retired = `${path}.retired-${randomUUID()}`
    await rename(path, retired)
    await rm(retired, { recursive: true })
    return
  }
  throw new Error(BUSY)
}

export async function acquireDirectoryLock(path: string): Promise<() => Promise<void>> {
  const command = lockHelper()
  if (!command)
    throw new Error(
      `kernel lock helper is unavailable on ${process.platform}; install util-linux (flock) or provide it on PATH`
    )

  // Never remove this inode: unlinking an advisory-lock file creates two
  // independently lockable resources. Legacy directory migration is separate.
  const nativePath = `${path}.native`
  const file = await open(nativePath, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    if (!(await file.stat()).isFile()) throw new Error('kernel lock target is not a regular file')
  } finally {
    await file.close()
  }
  const child = spawn(command.executable, [...command.args, nativePath, '/bin/sh', '-c', HOLD], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.on('error', () => undefined)
  child.stderr.resume()
  let spawnError: Error | undefined
  child.once('error', error => { spawnError = error })
  const closed = new Promise<number | null>(resolve => child.once('close', resolve))
  let released = false
  let acquired = false
  child.once('exit', () => {
    if (acquired && !released) {
      // Continuing after losing the kernel lease could create two writers.
      // This helper is used only inside the standalone uploader process.
      recordLeaseLoss(dirname(path))
      process.stderr.write('scry-upload: kernel lock lease was lost\n')
      process.kill(process.pid, 'SIGKILL')
    }
  })
  const release = async (): Promise<void> => {
    if (!released) {
      released = true
      child.stdin.end()
    }
    const timeout = setTimeout(() => {
      child.stdin.destroy()
      child.kill('SIGKILL')
    }, 5_000)
    timeout.unref()
    try {
      await closed
    } finally {
      clearTimeout(timeout)
    }
  }
  const ready = new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output === READY) {
        if (child.exitCode !== null || child.signalCode !== null) reject(new Error('kernel lock helper exited before admission'))
        else {
          acquired = true
          resolve()
        }
      }
    })
    void closed.then(code => reject(spawnError ?? new Error(code === command.busy ? BUSY : 'kernel lock helper failed')))
  })
  try {
    await ready
    await retireLegacyDirectory(`${path}.control`)
    await retireLegacyDirectory(path)
    return release
  } catch (error) {
    await release()
    throw error
  }
}
