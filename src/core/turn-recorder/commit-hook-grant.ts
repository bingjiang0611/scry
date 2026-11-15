import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { chmod, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RecorderCommitHookConfig, RecorderConfig } from './config.js'
import { readJson, writeJsonAtomic } from './io.js'
import { RECORDER_VERSION, stableHash } from './store.js'

// The commit hook runs with the user's own privileges and can read every record under the
// workspace data dir. Valid bundles are auto-authorized outside the repository and tagged
// source=auto. The bundle fingerprint is still re-verified before every activation; a
// changed valid bundle replaces the old automatic grant instead of prompting.

export interface CommitHookBundleFile {
  path: string
  sha256: string
  size: number
  executable: boolean
}

export interface CommitHookBundle {
  entry: string
  entryPath: string
  files: CommitHookBundleFile[]
  fingerprint: string
}

/**
 * A host (Scry App, CodeLens) injects its callback through the environment of the process it
 * starts. Later hook deliveries reach the daemon/receiver without that environment, so the same
 * fact is persisted and re-proved on read: same absolute path, same executable, same content.
 */
export interface HostCommitHookRecord {
  schemaVersion: 1
  workspace: string
  entry: string
  fingerprint: string
  recordedAt: string
}

export interface CommitHookGrant {
  schemaVersion: 1
  workspace: string
  entry: string
  fingerprint: string
  approvedAt: string
  approvedByCliVersion: string
  source?: 'auto' | 'user'
}

export type CommitHookActivation =
  | { status: 'host-provided' }
  | { status: 'not-configured' }
  | { status: 'bundle-invalid'; detail: string }
  | { status: 'trusted'; entryPath: string; fingerprint: string; grantPath: string }

export function commitHookGrantPath(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.SCRY_GRANT_DIR?.trim()
    ? resolve(env.SCRY_GRANT_DIR.trim())
    : join(env.HOME?.trim() || homedir(), '.scry', 'grants')
  const digest = createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 32)
  return join(base, `${digest}.json`)
}

/** Beside the grant, so an operator cleanup of grants also drops the host activation. */
export function hostCommitHookPath(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${commitHookGrantPath(workspaceRoot, env).replace(/\.json$/, '')}.host.json`
}

async function hostEntryFingerprint(entry: string): Promise<string | null> {
  try {
    if (!isAbsolute(entry)) return null
    const info = await stat(entry)
    if (!info.isFile() || (info.mode & 0o111) === 0) return null
    const content = await readFile(entry)
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

/** Record the host-injected callback so processes the host did not start can still deliver. */
async function rememberHostCommitHook(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  entry: string
): Promise<void> {
  const fingerprint = await hostEntryFingerprint(entry)
  if (!fingerprint) return
  const path = hostCommitHookPath(workspaceRoot, env)
  const current = await readJson<HostCommitHookRecord>(path).catch(() => null)
  if (
    current?.schemaVersion === 1 && current.workspace === resolve(workspaceRoot) &&
    current.entry === entry && current.fingerprint === fingerprint
  ) return
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    workspace: resolve(workspaceRoot),
    entry,
    fingerprint,
    recordedAt: new Date().toISOString()
  } satisfies HostCommitHookRecord)
  await chmod(path, 0o600).catch(() => undefined)
}

/**
 * The host callback this workspace already proved, if its file still matches byte for byte.
 * A changed or missing file drops the record: this is not a way to keep executing an old hook.
 */
async function persistedHostCommitHook(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const path = hostCommitHookPath(workspaceRoot, env)
  const record = await readJson<HostCommitHookRecord>(path).catch(() => null)
  if (!record || record.schemaVersion !== 1) return undefined
  if (record.workspace !== resolve(workspaceRoot) || typeof record.entry !== 'string' || !record.entry) return undefined
  const fingerprint = await hostEntryFingerprint(record.entry)
  if (fingerprint && fingerprint === record.fingerprint) return record.entry
  await rm(path, { force: true })
  return undefined
}

async function bundleFile(workspaceRoot: string, relPath: string): Promise<CommitHookBundleFile> {
  if (!relPath || isAbsolute(relPath) || relative('.', relPath).startsWith('..')) {
    throw new Error(`commitHook path must be workspace-relative: ${relPath}`)
  }
  const absolute = join(workspaceRoot, relPath)
  const resolved = await realpath(absolute).catch(() => {
    throw new Error(`commitHook file is missing: ${relPath}`)
  })
  const root = await realpath(workspaceRoot)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`commitHook file escapes the workspace: ${relPath}`)
  }
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`commitHook file is not a regular file: ${relPath}`)
  const content = await readFile(resolved)
  return {
    path: relPath,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: info.size,
    executable: (info.mode & 0o111) !== 0
  }
}

export async function inspectCommitHookBundle(
  workspaceRoot: string,
  commitHook: RecorderCommitHookConfig
): Promise<CommitHookBundle> {
  const root = resolve(workspaceRoot)
  const ordered = [...new Set(commitHook.files)].sort((a, b) => a.localeCompare(b))
  if (!ordered.includes(commitHook.entry)) {
    throw new Error('commitHook.entry must be listed in commitHook.files')
  }
  const files: CommitHookBundleFile[] = []
  for (const relPath of ordered) files.push(await bundleFile(root, relPath))
  const entryFile = files.find((file) => file.path === commitHook.entry)
  if (!entryFile) throw new Error('commitHook.entry must be listed in commitHook.files')
  if (!entryFile.executable) throw new Error(`commitHook.entry must be executable: ${commitHook.entry}`)
  return {
    entry: commitHook.entry,
    entryPath: join(root, commitHook.entry),
    files,
    fingerprint: stableHash({ entry: commitHook.entry, files })
  }
}

export async function readCommitHookGrant(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommitHookGrant | null> {
  const grant = await readJson<CommitHookGrant>(commitHookGrantPath(workspaceRoot, env))
  if (!grant || grant.schemaVersion !== 1) return null
  if (typeof grant.fingerprint !== 'string' || !grant.fingerprint) return null
  if (grant.workspace !== resolve(workspaceRoot)) return null
  return grant
}

export async function writeCommitHookGrant(
  workspaceRoot: string,
  bundle: CommitHookBundle,
  env: NodeJS.ProcessEnv = process.env,
  source: 'auto' | 'user' = 'user'
): Promise<{ grantPath: string; grant: CommitHookGrant }> {
  const grantPath = commitHookGrantPath(workspaceRoot, env)
  await mkdir(join(grantPath, '..'), { recursive: true, mode: 0o700 })
  const grant: CommitHookGrant = {
    schemaVersion: 1,
    workspace: resolve(workspaceRoot),
    entry: bundle.entry,
    fingerprint: bundle.fingerprint,
    approvedAt: new Date().toISOString(),
    approvedByCliVersion: RECORDER_VERSION,
    source
  }
  await writeJsonAtomic(grantPath, grant)
  await chmod(grantPath, 0o600).catch(() => undefined)
  return { grantPath, grant }
}

export async function revokeCommitHookGrant(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ grantPath: string; removed: boolean }> {
  const grantPath = commitHookGrantPath(workspaceRoot, env)
  const existed = await readJson<CommitHookGrant>(grantPath)
  await rm(grantPath, { force: true })
  return { grantPath, removed: existed != null }
}

export async function resolveCommitHookActivation(
  workspaceRoot: string,
  config: RecorderConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommitHookActivation> {
  // A managed host (Scry App, CodeLens) performs its own fingerprint gate and injects the entry
  // directly; never override or second-guess it from the workspace config. The same activation is
  // recorded here because the host only controls the process it starts: the daemon and the hook
  // receiver deliver every later commit, and without this record they would find no callback.
  const hosted = env.SCRY_RECORDER_COMMIT_HOOK?.trim()
  if (hosted) {
    await rememberHostCommitHook(workspaceRoot, env, hosted)
    return { status: 'host-provided' }
  }
  // A declared hook in the workspace config is the reproducible, reviewable declaration and always
  // wins: a host callback recorded here must not silently replace it or change its identity.
  if (!config.commitHook) {
    const persisted = await persistedHostCommitHook(workspaceRoot, env)
    if (persisted) {
      const fingerprint = await hostEntryFingerprint(persisted)
      if (fingerprint) {
        return {
          status: 'trusted',
          entryPath: persisted,
          fingerprint: env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT?.trim() || fingerprint,
          grantPath: commitHookGrantPath(workspaceRoot, env)
        }
      }
    }
    return { status: 'not-configured' }
  }
  const grantPath = commitHookGrantPath(workspaceRoot, env)
  let bundle: CommitHookBundle
  try {
    bundle = await inspectCommitHookBundle(workspaceRoot, config.commitHook)
  } catch (error) {
    return { status: 'bundle-invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  const grant = await readCommitHookGrant(workspaceRoot, env)
  if (!grant || grant.fingerprint !== bundle.fingerprint) {
    await writeCommitHookGrant(workspaceRoot, bundle, env, 'auto')
  }
  return { status: 'trusted', entryPath: bundle.entryPath, fingerprint: bundle.fingerprint, grantPath }
}

export function commitHookEnv(
  activation: CommitHookActivation,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (activation.status !== 'trusted') return env
  return {
    ...env,
    SCRY_RECORDER_COMMIT_HOOK: activation.entryPath,
    SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: activation.fingerprint
  }
}
