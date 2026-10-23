import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, relative, resolve, sep } from 'node:path'
import { sanitizeProviderEnv, shellEnv } from './claude-locate'
import type { WorkflowCheckRequest, WorkflowCheckResult, WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowReplicaReceipt } from '../shared/workflow-replica'
import { workflowCheckCopy as copy } from '../shared/constants/copy'

const OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT = 10 * 60 * 1000
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
const environmentHash = (env: Record<string, string>): string => createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
const cleanEnvironment = (environment: Record<string, string>): Record<string, string> => sanitizeProviderEnv(environment)

export function validateWorkflowCheck(value: unknown): WorkflowCheckRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.request)
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(key => !['argv', 'cwd', 'timeoutMs', 'parser'].includes(key)) ||
    !Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 64 ||
    request.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) || !request.argv[0] ||
    typeof request.cwd !== 'string' || request.cwd.length > 4096 || request.cwd.includes('\0') || isAbsolute(request.cwd) ||
    request.cwd.split(/[\\/]/).includes('..') ||
    (request.parser !== undefined && request.parser !== 'exit_code' && request.parser !== 'typescript') ||
    (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > 2_147_483_647))) throw new Error(copy.request)
  return { argv: [...request.argv] as string[], cwd: request.cwd, timeoutMs: (request.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT, parser: (request.parser as WorkflowCheckRequest['parser'] | undefined) ?? 'exit_code' }
}

export function validateWorkflowFrozenCheck(value: unknown): WorkflowFrozenCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.request)
  const input = value as Record<string, unknown>
  const request = validateWorkflowCheck({ argv: input.argv, cwd: input.cwd, timeoutMs: input.timeoutMs, parser: input.parser })
  const keys = ['argv', 'cwd', 'timeoutMs', 'parser', 'executable', 'executableHash', 'interpreters', 'launch', 'replicaRoot', 'replicaIdentity', 'workingDirectory', 'environmentHash', 'repositoryCode', 'sourceRoot', 'entrypoint']
  const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (Object.keys(input).some(key => !keys.includes(key)) || (input.sourceRoot !== undefined && !path(input.sourceRoot)) || !path(input.executable) || !path(input.replicaRoot) || !path(input.workingDirectory) || !hash(input.executableHash) || !hash(input.environmentHash) || input.repositoryCode !== true) throw new Error(copy.request)
  if (input.entrypoint !== undefined) {
    if (!input.entrypoint || typeof input.entrypoint !== 'object' || Array.isArray(input.entrypoint)) throw new Error(copy.request)
    const entry = input.entrypoint as Record<string, unknown>
    if (Object.keys(entry).length !== 2 || !path(entry.path) || !hash(entry.hash)) throw new Error(copy.request)
  }
  if (!input.replicaIdentity || typeof input.replicaIdentity !== 'object') throw new Error(copy.request)
  const info = input.replicaIdentity as Record<string, unknown>
  if (!Number.isSafeInteger(info.device) || !Number.isSafeInteger(info.inode)) throw new Error(copy.request)
  if (!Array.isArray(input.interpreters) || input.interpreters.length > 8 || !input.interpreters.every(item => item && typeof item === 'object' && Object.keys(item).length === 2 && path(item.path) && hash(item.hash))) throw new Error(copy.request)
  if (!input.launch || typeof input.launch !== 'object') throw new Error(copy.request)
  const launch = input.launch as Record<string, unknown>
  if (!path(launch.executable) || !Array.isArray(launch.args) || launch.args.length > 8 || !launch.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) throw new Error(copy.request)
  if (![input.executable, ...input.interpreters.map(item => item.path)].includes(launch.executable)) throw new Error(copy.request)
  return { ...structuredClone(input), ...request } as WorkflowFrozenCheck
}

async function executable(command: string, cwd: string, env: Record<string, string>): Promise<string> {
  const paths = isAbsolute(command) || command.includes('/') ? [resolve(cwd, command)] : (env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => resolve(path, command))
  for (const path of paths) {
    try { await access(path, constants.X_OK) } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isFile()) throw new Error(copy.executable)
    return canonical
  }
  throw new Error(copy.executable)
}

async function fingerprint(path: string): Promise<string> {
  const before = await stat(path)
  if (!before.isFile()) throw new Error(copy.executable)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = await stat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(copy.changed)
  return hash.digest('hex')
}

async function executablePlan(path: string, cwd: string, env: Record<string, string>, seen = new Set<string>(), binding?: { source: string; target: string }): Promise<Pick<WorkflowFrozenCheck, 'interpreters' | 'launch'>> {
  if (seen.size >= 4 || seen.has(path)) throw new Error(copy.executable)
  seen.add(path)
  const file = await open(path, 'r'), head = Buffer.alloc(4096)
  try { await file.read(head, 0, head.length, 0) } finally { await file.close() }
  if (head.subarray(0, 2).toString() !== '#!') return { interpreters: [], launch: { executable: path, args: [] } }
  const words = head.toString('utf8').split('\n')[0].slice(2).trim().split(/\s+/)
  if (!words[0] || words.some(word => /['"\\]/.test(word))) throw new Error(copy.executable)
  const interpreterPath = binding && isAbsolute(words[0]) && inside(binding.source, words[0]) ? resolve(binding.target, relative(binding.source, words[0])) : words[0]
  const interpreter = await executable(interpreterPath, cwd, env)
  if (interpreter === '/usr/bin/env') {
    // Resolve the approved interpreter ourselves; a copied absolute shebang
    // must not silently execute the original project's interpreter.
    if (words.length !== 2 || words[1].startsWith('-') || words[1].includes('=')) throw new Error(copy.executable)
    const target = await executable(words[1], cwd, env), plan = await executablePlan(target, cwd, env, seen, binding)
    return { interpreters: [{ path: interpreter, hash: await fingerprint(interpreter) }, { path: target, hash: await fingerprint(target) }, ...plan.interpreters], launch: { executable: plan.launch.executable, args: [...plan.launch.args, path] } }
  }
  if (words.length > 2) throw new Error(copy.executable)
  const plan = await executablePlan(interpreter, cwd, env, seen, binding)
  return { interpreters: [{ path: interpreter, hash: await fingerprint(interpreter) }, ...plan.interpreters], launch: { executable: plan.launch.executable, args: [...plan.launch.args, ...words.slice(1), path] } }
}

/** Explicit command interpreters/inline host code are not check syntax. A
 * runtime CLI needs a concrete repository entry file, not -e/-c/-m/preloads.
 * Repository executable scripts and their frozen shebang remain supported.
 * This is an entry grammar, not a sandbox for the code inside those files. */
async function checkEntrypoint(argv: string[], command: string, cwd: string, root: string): Promise<WorkflowFrozenCheck['entrypoint']> {
  const name = basename(command)
  if (/^(?:ba|da|z|fi|c|tc|k)?sh$/.test(name) || ['env', 'busybox', 'toybox', 'pwsh', 'powershell'].includes(name)) throw new Error(copy.entrypoint)
  if (!/^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|lua(?:\d+(?:\.\d+)*)?|deno|qjs|jsc|d8)$/.test(name) && !(name === 'bun' && argv[1]?.startsWith('-'))) return undefined
  if (!argv[1] || argv[1].startsWith('-')) throw new Error(copy.entrypoint)
  const path = await realpath(resolve(cwd, argv[1]))
  if (!inside(root, path)) throw new Error(copy.entrypoint)
  return { path, hash: await fingerprint(path) }
}

/** replicaRoot is supplied by the main-owned replica registry, never by an IPC payload. */
export async function freezeWorkflowCheck(value: unknown, replicaRoot: string, environment = shellEnv()): Promise<WorkflowFrozenCheck> {
  const request = validateWorkflowCheck(value), root = await realpath(replicaRoot)
  const cwd = await realpath(resolve(root, request.cwd)), env = cleanEnvironment(environment)
  if (!inside(root, cwd) || !(await stat(cwd)).isDirectory()) throw new Error(copy.directory)
  const command = await executable(request.argv[0], cwd, env), rootStat = await stat(root)
  const entrypoint = await checkEntrypoint(request.argv, command, cwd, root)
  return { ...request, ...(entrypoint ? { entrypoint } : {}), replicaIdentity: { device: rootStat.dev, inode: rootStat.ino }, executable: command, executableHash: await fingerprint(command), ...await executablePlan(command, cwd, env), replicaRoot: root, workingDirectory: cwd, environmentHash: environmentHash(env), repositoryCode: true }
}

/** Deterministic authority binding, not re-approval or an executable fallback.
 * The main registry supplies the exact copy inode; approved bytes/environment
 * stay the same, and all project-local executable paths move into that copy. */
export function bindWorkflowCheck(check: WorkflowFrozenCheck, replica: WorkflowReplicaReceipt, environment = shellEnv()): { check: WorkflowFrozenCheck; environment: Record<string, string> } {
  const env = cleanEnvironment(environment)
  if (environmentHash(env) !== check.environmentHash || check.sourceRoot !== undefined || replica.state !== 'ready') throw new Error(copy.changed)
  const map = (path: string): string => isAbsolute(path) && inside(check.replicaRoot, path) ? resolve(replica.directory, relative(check.replicaRoot, path)) : path
  const boundEnv = { ...env, ...(env.PATH !== undefined ? { PATH: env.PATH.split(delimiter).map(map).join(delimiter) } : {}) }
  return { check: { ...check, sourceRoot: check.replicaRoot, replicaRoot: replica.directory, replicaIdentity: replica.identity,
    workingDirectory: map(check.workingDirectory), executable: map(check.executable), argv: check.argv.map((arg, index) => map(index === 1 && check.entrypoint ? check.entrypoint.path : arg)),
    ...(check.entrypoint ? { entrypoint: { ...check.entrypoint, path: map(check.entrypoint.path) } } : {}),
    interpreters: check.interpreters.map(artifact => ({ ...artifact, path: map(artifact.path) })),
    launch: { executable: map(check.launch.executable), args: check.launch.args.map(map) }, environmentHash: environmentHash(boundEnv)
  }, environment: boundEnv }
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => execFile('/bin/ps', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolveResult(stdout)))
}

async function identity(pid: number): Promise<string | undefined> {
  // Only this registered PID's arguments, not a machine-wide command dump.
  try { return (await ps(['-p', String(pid), '-o', 'lstart=,command='])).trim() || undefined } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined
    throw error
  }
}
async function groupEmpty(pid: number): Promise<boolean> {
  const rows = (await ps(['-axo', 'pid=,pgid=,stat='])).trim().split('\n')
  let live = false
  for (const row of rows) {
    const columns = row.trim().split(/\s+/)
    if (columns.length !== 3 || !/^\d+$/.test(columns[0]) || !/^\d+$/.test(columns[1])) throw new Error(copy.scope)
    if (Number(columns[1]) === pid && !columns[2].startsWith('Z')) live = true
  }
  return !live
}

export function workflowCheckDiagnostics(parser: WorkflowCheckRequest['parser'], stdout: string, stderr: string, truncated: boolean, exitCode?: number | null): WorkflowCheckResult['diagnostics'] {
  if (truncated) return { state: 'unavailable', reason: copy.truncated }
  if (parser === 'exit_code') return { state: 'unavailable', reason: copy.noParser }
  const lines = (stdout + '\n' + stderr).split('\n'), items: Array<{ file: string; line: number; column: number; code: string; message: string }> = []
  const pattern = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/
  for (const line of lines) {
    if (!line.trim()) continue
    const match = pattern.exec(line)
    if (!match) return { state: 'unavailable', reason: copy.parser }
    items.push({ file: match[1].replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5] })
  }
  if (!items.length && exitCode !== 0) return { state: 'unavailable', reason: copy.parser }
  return { state: 'available', source: 'derived', items }
}

export interface WorkflowCheckExecution {
  result: Promise<WorkflowCheckResult>
  /** Resolves only for proven closure of the owned process group. */
  settled: Promise<void>
  /** Acknowledges the cancellation latch, not physical convergence. */
  stop(): boolean
}

/** Called only after the canonical Runner durably admits a SystemStep intent. */
export function executeWorkflowCheck(check: WorkflowFrozenCheck, environment = shellEnv()): WorkflowCheckExecution {
  let cancelled = false, timedOut = false, child: ChildProcess | undefined, processIdentity: string | undefined
  let closeScope!: () => void
  const settled = new Promise<void>(resolveScope => { closeScope = resolveScope })
  let requestStop = (): void => {}
  const stop = async (): Promise<boolean> => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null || !processIdentity) return false
    if (await identity(child.pid) !== processIdentity) return false
    try { process.kill(-child.pid, 'SIGKILL'); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return false
    }
  }
  const result = (async (): Promise<WorkflowCheckResult> => {
    const startedAt = Date.now(), env = cleanEnvironment(environment)
    const base = { startedAt, finishedAt: startedAt, exitCode: null, signal: null, settled: true, stdout: '', stderr: '', truncated: false, evidence: 'exact' as const, diagnostics: { state: 'unavailable' as const, reason: copy.noParser } }
    try {
      if (process.platform === 'win32') throw new Error(copy.platform)
      const root = await stat(check.replicaRoot)
      if (!root.isDirectory() || root.dev !== check.replicaIdentity.device || root.ino !== check.replicaIdentity.inode || await realpath(check.replicaRoot) !== check.replicaRoot || await realpath(resolve(check.replicaRoot, check.cwd)) !== check.workingDirectory ||
        !inside(check.replicaRoot, check.workingDirectory) || await realpath(check.executable) !== check.executable ||
        await fingerprint(check.executable) !== check.executableHash || environmentHash(env) !== check.environmentHash) throw new Error(copy.changed)
      if (JSON.stringify(await checkEntrypoint(check.argv, check.executable, check.workingDirectory, check.replicaRoot)) !== JSON.stringify(check.entrypoint)) throw new Error(copy.changed)
      const plan = await executablePlan(check.executable, check.workingDirectory, env, new Set(), check.sourceRoot ? { source: check.sourceRoot, target: check.replicaRoot } : undefined)
      if (JSON.stringify(plan) !== JSON.stringify({ interpreters: check.interpreters, launch: check.launch })) throw new Error(copy.changed)
    } catch (error) { closeScope(); return { ...base, state: 'rejected', finishedAt: Date.now(), error: String(error) } }
    if (cancelled) { closeScope(); return { ...base, state: 'cancelled', finishedAt: Date.now(), error: copy.stopped } }
    return new Promise<WorkflowCheckResult>(resolveResult => {
      child = spawn(check.launch.executable, [...check.launch.args, ...check.argv.slice(1)], { cwd: check.workingDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0)
      let truncated = false, spawnError: Error | undefined, stopError: string | undefined
      let identityReady = false, published = false
      const publishUnknown = (error: string): void => {
        if (published) return
        published = true
        clearTimeout(timer)
        resolveResult({ ...base, state: 'unknown', settled: false, finishedAt: Date.now(), stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated: true, diagnostics: { state: 'unavailable', reason: copy.scope }, error })
      }
      requestStop = (): void => { void stop().then(async signalled => {
        if (!signalled && identityReady) {
          if (child!.pid && await groupEmpty(child!.pid)) closeScope()
          publishUnknown(stopError ?? copy.scope)
          child!.stdout!.destroy()
          child!.stderr!.destroy()
        }
      }).catch(error => { stopError = String(error); publishUnknown(stopError) }) }
      const timer = setTimeout(() => { timedOut = true; requestStop() }, check.timeoutMs)
      const append = (old: Buffer, chunk: Buffer): Buffer => {
        const remaining = Math.max(0, OUTPUT_BYTES - old.length)
        if (chunk.length > remaining) truncated = true
        return remaining ? Buffer.concat([old, chunk.subarray(0, remaining)]) : old
      }
      child.stdout!.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr!.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.on('error', error => { spawnError = error })
      child.on('spawn', () => { void (async () => {
        try { processIdentity = await identity(child!.pid!) } finally { identityReady = true }
        if (cancelled || timedOut) requestStop()
      })().catch(error => { stopError = String(error); if (cancelled || timedOut) requestStop() }) })
      child.on('close', () => { void (async () => {
        clearTimeout(timer)
        const closed = !child!.pid || await groupEmpty(child!.pid)
        if (closed) closeScope()
        const output = stdout.toString('utf8'), errors = stderr.toString('utf8')
        if (published) return
        published = true
        const diagnostics = workflowCheckDiagnostics(check.parser, output, errors, truncated, child!.exitCode)
        const diagnosticFailure = diagnostics.state === 'available' && diagnostics.items.length > 0
        const state = !closed ? 'unknown' : spawnError ? 'failed' : timedOut ? 'timed_out' : cancelled ? 'cancelled' : child!.exitCode === 0 && !truncated && !diagnosticFailure ? 'passed' : 'failed'
        resolveResult({ ...base, state, finishedAt: Date.now(), exitCode: child!.exitCode, signal: child!.signalCode, settled: closed, stdout: output, stderr: errors, truncated,
          diagnostics,
          ...(!closed || spawnError || timedOut || cancelled || stopError ? { error: !closed ? copy.scope : spawnError ? String(spawnError) : stopError ?? (timedOut ? copy.timedOut : copy.stopped) } : {}) })
      })().catch(error => resolveResult({ ...base, state: 'unknown', settled: false, finishedAt: Date.now(), error: String(error) })) })
    })
  })()
  return { result, settled, stop: () => { cancelled = true; requestStop(); return true } }
}
