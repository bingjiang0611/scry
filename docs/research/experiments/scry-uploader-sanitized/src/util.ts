import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
        }, options.timeoutMs)
      : undefined
    timer?.unref()
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (timedOut) {
        const error = new Error(`process timeout after ${options.timeoutMs}ms`) as Error & { code?: string }
        error.code = 'ETIMEDOUT'
        reject(error)
        return
      }
      if (signal && code == null) {
        reject(new Error(`process exited with signal ${signal}: ${err.trim()}`))
        return
      }
      resolvePromise({ stdout: out, stderr: err, exitCode: code ?? 1 })
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

export async function acquireDirectoryLock(path: string): Promise<() => Promise<void>> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = await readJson<{ pid?: number; createdAt?: number }>(`${path}/owner.json`).catch(() => null)
    if (!owner) {
      const metadata = await stat(path).catch(() => null)
      const age = metadata ? Date.now() - metadata.mtimeMs : 0
      if (age < 5 * 60_000) throw new Error('upload worker is already running')
    }
    let alive = false
    if (owner?.pid && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0)
        alive = true
      } catch {}
    }
    const old = !owner?.createdAt || Date.now() - owner.createdAt > 5 * 60_000
    if (alive || (!owner?.pid && !old)) throw new Error('upload worker is already running')
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { mode: 0o700 })
  }
  await writeJsonAtomic(`${path}/owner.json`, {
    pid: process.pid,
    createdAt: Date.now()
  })
  return async () => await rm(path, { recursive: true, force: true })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
