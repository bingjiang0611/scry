import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'

const BUSY = 'upload worker is already running'
const READY = '__scry_lock_acquired__\n'
// EOF releases the lease even if the caller crashes. These are fixed shell
// instructions; the workspace path is a separate argv entry, never shell text.
const HOLD = "printf '__scry_lock_acquired__\\n'; exec /bin/cat >/dev/null"

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
  const command = process.platform === 'darwin'
    ? { executable: '/usr/bin/lockf', args: ['-k', '-t', '0'], busy: 75 }
    : process.platform === 'linux'
      ? { executable: '/usr/bin/flock', args: ['-n'], busy: 1 }
      : undefined
  if (!command) throw new Error('kernel lock helper is unavailable on this platform')

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
