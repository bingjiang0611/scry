import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExportPage } from './types.js'
import { EXPORT_LIMIT } from './constants.js'
import { object, run } from './util.js'

const require = createRequire(import.meta.url)

function safeDiagnostic(value: string): string {
  return value
    .replace(/(authorization|cookie|token|password|secret|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(0, 512)
}

export function bundledScryEntrypoint(): string {
  const packageJson = require.resolve('@review/scry-turn-recorder/package.json')
  return join(dirname(packageJson), 'dist', 'cli', 'scry.js')
}

export async function recordUploadDisabled(dataDirectory: string, recordId: string): Promise<boolean> {
  // Reuse the pinned recorder's identity/schema checks; do not reinterpret its
  // saved environment or import executable settings into a recovery worker.
  const reader = await import(require.resolve('@review/scry-turn-recorder/dist/core/turn-recorder/commit-environment.js')) as {
    recordUploadEnvironment(root: string, id: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>
  }
  return (await reader.recordUploadEnvironment(dataDirectory, recordId, {})).SCRY_TURN_UPLOAD_ENABLED === '0'
}

export function uploaderEntrypoint(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url))
}

export async function runScry(
  args: string[],
  workspace: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string> {
  const env = options.env ?? process.env
  const configured = env.SCRY_CLI_PATH
  if (configured !== undefined && !configured.trim()) throw new Error('SCRY_CLI_PATH is empty')
  const executable = configured || process.execPath
  const command = configured ? args : [bundledScryEntrypoint(), ...args]
  const result = await run(executable, command, {
    cwd: workspace,
    env,
    timeoutMs: options.timeoutMs ?? 30_000
  })
  if (result.exitCode !== 0) {
    const failure = new Error(`scry ${args[0] ?? ''} 失败：${safeDiagnostic(result.stderr.trim()) || `exit ${result.exitCode}`}`) as Error & {
      exitCode?: number
      signal?: NodeJS.Signals
      stderr?: string
    }
    failure.exitCode = result.exitCode
    failure.signal = result.signal
    failure.stderr = safeDiagnostic(result.stderr)
    throw failure
  }
  return result.stdout
}

export async function verifyScryVersion(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const actual = (await runScry(['version'], workspace, { timeoutMs: 10_000, env })).trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(actual)) {
    throw new Error(`内置 Scry 版本无效：${actual || 'unknown'}`)
  }
  return actual
}

export async function exportPage(
  workspace: string,
  after: number,
  snapshot?: number,
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = process.env,
  limit = EXPORT_LIMIT
): Promise<ExportPage> {
  const args = ['turns', 'export', '--workspace', workspace, '--after', String(after)]
  args.push('--limit', String(limit))
  if (snapshot !== undefined) args.push('--snapshot', String(snapshot))
  const parsed = JSON.parse(await runScry(args, workspace, { timeoutMs, env })) as unknown
  const root = object(parsed)
  if (!root || !Array.isArray(root.records)) throw new Error('scry export 返回格式无效')
  const nextCursor = Number(root.nextCursor)
  const snapshotMaxSequence = Number(root.snapshotMaxSequence)
  if (
    !Number.isSafeInteger(nextCursor) ||
    nextCursor < 0 ||
    !Number.isSafeInteger(snapshotMaxSequence) ||
    snapshotMaxSequence < 0
  ) {
    throw new Error('scry export 游标无效')
  }
  return {
    records: root.records,
    nextCursor,
    hasMore: root.hasMore === true,
    snapshotMaxSequence
  }
}

export async function safeSnapshotMaxSequence(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000
): Promise<number> {
  // The recorder supports a max-safe after cursor without reading older
  // records. This is the only baseline contract used for enable/registration.
  const page = await exportPage(workspace, Number.MAX_SAFE_INTEGER, undefined, timeoutMs, env, 1)
  if (page.records.length || page.hasMore || page.nextCursor !== Number.MAX_SAFE_INTEGER)
    throw new Error('scry baseline query returned an invalid page')
  return page.snapshotMaxSequence
}
