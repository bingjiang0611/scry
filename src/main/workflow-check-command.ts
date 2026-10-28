import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, relative, resolve, sep } from 'node:path'
import { sanitizeProviderEnv, shellEnv } from './claude-locate'
import type { WorkflowCheckRequest, WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowReplicaReceipt } from '../shared/workflow-replica'
import { workflowCheckCopy as copy } from '../shared/constants/copy'

const DEFAULT_TIMEOUT = 10 * 60 * 1000
// Node interprets file arguments as glob patterns, including canonical paths.
const nodeTestPattern = /[\\*?\[\]{}()]/
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
const environmentHash = (env: Record<string, string>): string => createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
export const cleanWorkflowCheckEnvironment = (environment: Record<string, string>): Record<string, string> => sanitizeProviderEnv(environment)

export function validateWorkflowCheck(value: unknown): WorkflowCheckRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.request)
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(key => !['argv', 'cwd', 'timeoutMs', 'parser'].includes(key)) ||
    !Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 64 ||
    request.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) || !request.argv[0] ||
    typeof request.cwd !== 'string' || request.cwd.length > 4096 || request.cwd.includes('\0') || isAbsolute(request.cwd) ||
    request.cwd.split(/[\\/]/).includes('..') ||
    (request.parser !== undefined && request.parser !== 'exit_code' && request.parser !== 'typescript' && request.parser !== 'node_test') ||
    (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > 2_147_483_647))) throw new Error(copy.request)
  const parser = (request.parser as WorkflowCheckRequest['parser'] | undefined) ?? 'exit_code'
  if (parser === 'node_test' && (request.argv.length < 4 || request.argv[1] !== '--test' || request.argv[2] !== '--test-reporter=tap' || request.argv.slice(3).some(arg => !arg || arg.startsWith('-') || nodeTestPattern.test(arg)))) throw new Error(copy.request)
  return { argv: [...request.argv] as string[], cwd: request.cwd, timeoutMs: (request.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT, parser }
}

export function validateWorkflowFrozenCheck(value: unknown): WorkflowFrozenCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.request)
  const input = value as Record<string, unknown>
  const request = validateWorkflowCheck({ argv: input.argv, cwd: input.cwd, timeoutMs: input.timeoutMs, parser: input.parser })
  const keys = ['argv', 'cwd', 'timeoutMs', 'parser', 'executable', 'executableHash', 'interpreters', 'launch', 'replicaRoot', 'replicaIdentity', 'workingDirectory', 'environmentHash', 'repositoryCode', 'sourceRoot', 'entrypoint', 'testFiles']
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
  if (input.parser === 'node_test') {
    if (input.entrypoint !== undefined || basename(input.executable as string) !== 'node' && basename(input.executable as string) !== 'nodejs' || !Array.isArray(input.testFiles) || input.testFiles.length !== request.argv.length - 3 || input.testFiles.length < 1 || input.testFiles.length > 61 || !input.testFiles.every(item => item && typeof item === 'object' && Object.keys(item).length === 2 && path(item.path) && hash(item.hash))) throw new Error(copy.request)
  } else if (input.testFiles !== undefined) throw new Error(copy.request)
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
  // Use 1 MiB read chunks without caching or omitting any bytes.
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk)
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
  const cwd = await realpath(resolve(root, request.cwd)), env = cleanWorkflowCheckEnvironment(environment)
  if (!inside(root, cwd) || !(await stat(cwd)).isDirectory()) throw new Error(copy.directory)
  const command = await executable(request.argv[0], cwd, env), rootStat = await stat(root)
  const entrypoint = request.parser === 'node_test' ? undefined : await checkEntrypoint(request.argv, command, cwd, root)
  const testFiles = request.parser === 'node_test' ? await freezeNodeTestFiles(request.argv.slice(3), cwd, root) : undefined
  if (request.parser === 'node_test' && !['node', 'nodejs'].includes(basename(command))) throw new Error(copy.executable)
  return { ...request, ...(entrypoint ? { entrypoint } : {}), ...(testFiles ? { testFiles } : {}), replicaIdentity: { device: rootStat.dev, inode: rootStat.ino }, executable: command, executableHash: await fingerprint(command), ...await executablePlan(command, cwd, env), replicaRoot: root, workingDirectory: cwd, environmentHash: environmentHash(env), repositoryCode: true }
}

async function freezeNodeTestFiles(files: string[], cwd: string, root: string): Promise<Array<{ path: string; hash: string }>> {
  const result: Array<{ path: string; hash: string }> = [], seen = new Set<string>()
  for (const file of files) {
    const path = await realpath(resolve(cwd, file)), info = await stat(path)
    if (!inside(root, path) || !info.isFile() || nodeTestPattern.test(path) || seen.has(path)) throw new Error(copy.entrypoint)
    seen.add(path)
    result.push({ path, hash: await fingerprint(path) })
  }
  return result
}

async function assertNodeTestFiles(check: WorkflowFrozenCheck): Promise<void> {
  if (check.parser !== 'node_test' || !check.testFiles || check.testFiles.length !== check.argv.length - 3 || !['node', 'nodejs'].includes(basename(check.executable))) throw new Error(copy.changed)
  for (const [index, file] of check.testFiles.entries()) {
    const resolved = await realpath(resolve(check.workingDirectory, check.argv[index + 3])), info = await stat(resolved)
    if (resolved !== file.path || !inside(check.replicaRoot, resolved) || !info.isFile() || await fingerprint(resolved) !== file.hash) throw new Error(copy.changed)
  }
}

/** Deterministic authority binding, not re-approval or an executable fallback.
 * The main registry supplies the exact copy inode; approved bytes/environment
 * stay the same, and all project-local executable paths move into that copy. */
export function bindWorkflowCheck(check: WorkflowFrozenCheck, replica: WorkflowReplicaReceipt, environment = shellEnv()): { check: WorkflowFrozenCheck; environment: Record<string, string> } {
  const env = cleanWorkflowCheckEnvironment(environment)
  if (environmentHash(env) !== check.environmentHash || check.sourceRoot !== undefined || replica.state !== 'ready') throw new Error(copy.changed)
  const map = (path: string): string => isAbsolute(path) && inside(check.replicaRoot, path) ? resolve(replica.directory, relative(check.replicaRoot, path)) : path
  const boundEnv = { ...env, ...(env.PATH !== undefined ? { PATH: env.PATH.split(delimiter).map(map).join(delimiter) } : {}) }
  return { check: { ...check, sourceRoot: check.replicaRoot, replicaRoot: replica.directory, replicaIdentity: replica.identity,
    workingDirectory: map(check.workingDirectory), executable: map(check.executable), argv: check.argv.map((arg, index) => map(check.parser === 'node_test' && index >= 3 ? check.testFiles![index - 3].path : index === 1 && check.entrypoint ? check.entrypoint.path : arg)),
    ...(check.entrypoint ? { entrypoint: { ...check.entrypoint, path: map(check.entrypoint.path) } } : {}),
    ...(check.testFiles ? { testFiles: check.testFiles.map(file => ({ ...file, path: map(file.path) })) } : {}),
    interpreters: check.interpreters.map(artifact => ({ ...artifact, path: map(artifact.path) })),
    launch: { executable: map(check.launch.executable), args: check.launch.args.map(map) }, environmentHash: environmentHash(boundEnv)
  }, environment: boundEnv }
}

export async function assertWorkflowCheckUnchanged(check: WorkflowFrozenCheck, env: Record<string, string>): Promise<void> {
  const root = await stat(check.replicaRoot)
  if (!root.isDirectory() || root.dev !== check.replicaIdentity.device || root.ino !== check.replicaIdentity.inode || await realpath(check.replicaRoot) !== check.replicaRoot || await realpath(resolve(check.replicaRoot, check.cwd)) !== check.workingDirectory ||
    !inside(check.replicaRoot, check.workingDirectory) || await realpath(check.executable) !== check.executable ||
    await fingerprint(check.executable) !== check.executableHash || environmentHash(env) !== check.environmentHash) throw new Error(copy.changed)
  if (check.parser === 'node_test') await assertNodeTestFiles(check)
  if (check.parser !== 'node_test' && JSON.stringify(await checkEntrypoint(check.argv, check.executable, check.workingDirectory, check.replicaRoot)) !== JSON.stringify(check.entrypoint)) throw new Error(copy.changed)
  const plan = await executablePlan(check.executable, check.workingDirectory, env, new Set(), check.sourceRoot ? { source: check.sourceRoot, target: check.replicaRoot } : undefined)
  if (JSON.stringify(plan) !== JSON.stringify({ interpreters: check.interpreters, launch: check.launch })) throw new Error(copy.changed)
}
