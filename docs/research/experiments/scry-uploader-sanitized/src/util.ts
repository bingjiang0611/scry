import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export async function directoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function now(): string {
  return new Date().toISOString()
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function ensurePrivateDirectory(path: string, recursive = true): Promise<void> {
  let created: string | undefined
  try {
    created = await mkdir(path, { recursive, mode: 0o700 })
  } catch (error) {
    if (recursive || (error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await stat(path)).isDirectory())
      throw error
  }
  await chmod(path, 0o700)
  let current = resolve(path)
  while (true) {
    await syncDirectory(current)
    await syncDirectory(dirname(current))
    if (!created || current === resolve(created)) break
    current = dirname(current)
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeFileAtomic(path: string, source: string | Buffer, mode = 0o600): Promise<void> {
  // Parents belong to preparation, not a write retry. Recreating them here can
  // resurrect a workspace removed while a detached upload is in flight.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, mode)
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  signal?: NodeJS.Signals
  timedOut?: boolean
}

const MAX_PROCESS_DIAGNOSTICS = 64 * 1024
function boundedDiagnostic(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

export async function run(
  executablePath: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: string
    timeoutMs?: number
  } = {}
): Promise<RunResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let escalation: NodeJS.Timeout | undefined
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      // stderr is diagnostics, not protocol data. Keep draining the stream but
      // retain only a bounded prefix; callers handle diagnostic redaction.
      if (stderrBytes < MAX_PROCESS_DIAGNOSTICS) {
        const keep = Math.min(MAX_PROCESS_DIAGNOSTICS - stderrBytes, chunk.length)
        stderr.push(chunk.subarray(0, keep))
      }
      stderrBytes += chunk.length
    })
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // close/error will report the process outcome.
        }
      }
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killProcessGroup('SIGTERM')
          escalation = setTimeout(() => killProcessGroup('SIGKILL'), 1_000)
          escalation.unref()
        }, options.timeoutMs)
      : undefined
    timer?.unref()
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        if (escalation) clearTimeout(escalation)
        reject(error)
      }
    })
    // `close` waits for stdout/stderr to drain. `exit` can fire first and lose
    // the final diagnostics needed to classify a transport failure.
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = boundedDiagnostic(stderr)
      if (timedOut) {
        const error = new Error(`process deadline exceeded after ${options.timeoutMs}ms`) as Error & {
          code?: string
          signal?: NodeJS.Signals
          stderr?: string
        }
        error.code = 'ETIMEDOUT'
        error.signal = signal ?? undefined
        error.stderr = err
        reject(error)
        return
      }
      resolvePromise({ stdout: out, stderr: err, exitCode: code ?? 1, signal: signal ?? undefined })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

export async function exactGitRoot(input: string): Promise<string> {
  let workspace: string
  try {
    workspace = await realpath(resolve(input))
  } catch {
    throw new Error(`目录不存在：${resolve(input)}`)
  }
  const result = await run('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
  if (result.exitCode !== 0) throw new Error(`当前目录不是 Git 项目：${workspace}`)
  const root = await realpath(result.stdout.trim())
  if (root !== workspace) throw new Error(`请在 Git 项目根目录执行：${root}`)
  return root
}

export { acquireDirectoryLock } from './locks.js'

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
