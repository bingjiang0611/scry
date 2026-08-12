import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface CommitHookDescriptor {
  entry: string
  files: string[]
}

export interface CommitHookLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export interface CommitHookBundleInspection {
  workspace: string
  entry: string
  fingerprint: string
  files: ReadonlyArray<{ path: string; hash: string; bytes: Buffer }>
}

export interface CommitHookCapability {
  fingerprint: string
  entryPath: string
  env: Record<string, string>
}

interface GrantFile {
  version: 1
  grants: Array<{ workspace: string; fingerprint: string; grantedAt: number }>
}

export const DEFAULT_COMMIT_HOOK_LIMITS: CommitHookLimits = {
  maxFiles: 64,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024
}

const fingerprintOf = (entry: string, files: ReadonlyArray<{ path: string; hash: string }>): string => {
  const hash = createHash('sha256').update('scry-commit-hook-bundle-v1\0').update(entry).update('\0')
  for (const file of files) hash.update(file.path).update('\0').update(file.hash).update('\0')
  return `sha256:${hash.digest('hex')}`
}

function validatedRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\')) throw new Error(`Invalid bundle path: ${value}`)
  const normalized = value.split('/').filter((part) => part !== '.')
  if (normalized.length === 0 || normalized.some((part) => !part || part === '..')) {
    throw new Error(`Invalid bundle path: ${value}`)
  }
  return normalized.join('/')
}

function unchanged(
  before: { dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number },
  after: { dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

async function snapshotAncestors(workspace: string, path: string) {
  const parts = path.split('/').slice(0, -1)
  const snapshots: Array<{
    path: string
    stat: { dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number }
  }> = []
  let current = workspace
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Bundle path contains an unsafe directory: ${path}`)
    snapshots.push({
      path: current,
      stat: {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs
      }
    })
  }
  return snapshots
}

async function assertAncestorsUnchanged(
  before: Awaited<ReturnType<typeof snapshotAncestors>>,
  workspace: string,
  path: string
): Promise<void> {
  const after = await snapshotAncestors(workspace, path)
  if (before.length !== after.length || before.some((item, index) => item.path !== after[index]?.path || !unchanged(item.stat, after[index].stat))) {
    throw new Error(`Bundle path changed while reading: ${path}`)
  }
}

export async function inspectCommitHookBundle(
  workspacePath: string,
  descriptor: CommitHookDescriptor,
  limits: CommitHookLimits = DEFAULT_COMMIT_HOOK_LIMITS
): Promise<CommitHookBundleInspection> {
  const workspace = await realpath(workspacePath)
  if (!(await lstat(workspace)).isDirectory()) throw new Error('Workspace must be a directory')

  const entry = validatedRelativePath(descriptor.entry)
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) throw new Error('Bundle files are required')
  if (descriptor.files.length > limits.maxFiles) throw new Error('Bundle has too many files')
  const paths = descriptor.files.map(validatedRelativePath)
  if (new Set(paths).size !== paths.length) throw new Error('Bundle contains duplicate files')
  if (!paths.includes(entry)) throw new Error('Bundle entry must be listed in files')

  let totalBytes = 0
  const files: Array<{ path: string; hash: string; bytes: Buffer }> = []
  for (const path of [...paths].sort()) {
    const absolute = resolve(workspace, path)
    const fromWorkspace = relative(workspace, absolute)
    if (!fromWorkspace || fromWorkspace.startsWith(`..${sep}`) || fromWorkspace === '..' || isAbsolute(fromWorkspace)) {
      throw new Error(`Bundle path escapes workspace: ${path}`)
    }
    const ancestors = await snapshotAncestors(workspace, path)
    if ((await realpath(absolute)) !== absolute) throw new Error(`Bundle path contains a symlink: ${path}`)
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`Bundle path is not a regular file: ${path}`)
      if (before.size > limits.maxFileBytes) throw new Error(`Bundle file is too large: ${path}`)
      totalBytes += before.size
      if (totalBytes > limits.maxTotalBytes) throw new Error('Bundle is too large')
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (!unchanged(before, after) || bytes.length !== before.size) throw new Error(`Bundle file changed while reading: ${path}`)
      await assertAncestorsUnchanged(ancestors, workspace, path)
      if ((await realpath(absolute)) !== absolute) throw new Error(`Bundle path changed while reading: ${path}`)
      files.push({ path, hash: createHash('sha256').update(bytes).digest('hex'), bytes })
    } finally {
      await handle.close()
    }
  }

  return { workspace, entry, fingerprint: fingerprintOf(entry, files), files }
}

function parseGrants(value: unknown): GrantFile {
  const grants = (value as Partial<GrantFile> | null)?.grants
  return {
    version: 1,
    grants: Array.isArray(grants)
      ? grants.filter(
          (grant): grant is GrantFile['grants'][number] =>
            !!grant && typeof grant.workspace === 'string' && typeof grant.fingerprint === 'string' && typeof grant.grantedAt === 'number'
        )
      : []
  }
}

export function createCommitHookTrustStore(userDataDir: string) {
  const grantPath = join(userDataDir, 'commit-hook-grants.json')
  const bundlesDir = join(userDataDir, 'commit-hook-bundles')

  const readGrants = async (): Promise<GrantFile> => {
    try {
      return parseGrants(JSON.parse(await readFile(grantPath, 'utf8')))
    } catch {
      return { version: 1, grants: [] }
    }
  }

  const isGranted = async (workspacePath: string, fingerprint: string): Promise<boolean> => {
    const workspace = await realpath(workspacePath)
    return (await readGrants()).grants.some((grant) => grant.workspace === workspace && grant.fingerprint === fingerprint)
  }

  const grantedFingerprints = async (workspacePath: string): Promise<string[]> => {
    const workspace = await realpath(workspacePath)
    return (await readGrants()).grants
      .filter((grant) => grant.workspace === workspace)
      .map((grant) => grant.fingerprint)
  }

  const grantedWorkspaces = async (): Promise<string[]> =>
    [...new Set((await readGrants()).grants.map((grant) => grant.workspace))]

  const grant = async (workspacePath: string, fingerprint: string): Promise<void> => {
    const workspace = await realpath(workspacePath)
    const current = await readGrants()
    const next: GrantFile = {
      version: 1,
      grants: [
        ...current.grants.filter((item) => item.workspace !== workspace),
        { workspace, fingerprint, grantedAt: Date.now() }
      ]
    }
    await mkdir(userDataDir, { recursive: true })
    const temporary = `${grantPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, grantPath)
  }

  const revoke = async (workspacePath: string, fingerprint?: string): Promise<void> => {
    const workspace = await realpath(workspacePath)
    const current = await readGrants()
    const next: GrantFile = {
      version: 1,
      grants: current.grants.filter((item) =>
        item.workspace !== workspace || (fingerprint !== undefined && item.fingerprint !== fingerprint)
      )
    }
    await mkdir(userDataDir, { recursive: true })
    const temporary = `${grantPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, grantPath)
  }

  const materialize = async (inspection: CommitHookBundleInspection): Promise<CommitHookCapability> => {
    if (!(await isGranted(inspection.workspace, inspection.fingerprint))) throw new Error('Commit hook bundle is not granted')
    const bundleDir = join(bundlesDir, inspection.fingerprint.replace(':', ''))
    let reusable = true
    const frozenFiles = new Set<string>()
    const enumerateFrozenFiles = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name)
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const metadata = await lstat(entryPath)
        if (metadata.isSymbolicLink()) throw new Error('Frozen commit hook bundle is missing or damaged')
        if (metadata.isDirectory()) {
          await enumerateFrozenFiles(entryPath, relativePath)
        } else if (metadata.isFile()) {
          frozenFiles.add(relativePath)
        } else {
          throw new Error('Frozen commit hook bundle is missing or damaged')
        }
      }
    }
    try {
      await enumerateFrozenFiles(bundleDir)
      const expectedFiles = new Set(inspection.files.map((file) => file.path))
      if (frozenFiles.size !== expectedFiles.size || [...frozenFiles].some((path) => !expectedFiles.has(path))) reusable = false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') reusable = false
      else throw error
    }
    for (const file of inspection.files) {
      try {
        const frozenPath = join(bundleDir, file.path)
        const metadata = await lstat(frozenPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          reusable = false
          continue
        }
        const frozen = await readFile(frozenPath)
        if (createHash('sha256').update(frozen).digest('hex') !== file.hash) reusable = false
      } catch {
        reusable = false
      }
    }
    if (!reusable) {
      try {
        await lstat(bundleDir)
        throw new Error('Frozen commit hook bundle is missing or damaged')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mkdir(bundlesDir, { recursive: true })
      const temporary = `${bundleDir}.${process.pid}.${Date.now()}.tmp`
      try {
        for (const file of inspection.files) {
          const target = join(temporary, file.path)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.bytes, { mode: file.path === inspection.entry ? 0o700 : 0o600, flag: 'wx' })
          await chmod(target, file.path === inspection.entry ? 0o700 : 0o600)
        }
        await rename(temporary, bundleDir)
      } catch (error) {
        await rm(temporary, { recursive: true, force: true })
        throw error
      }
    }

    const entryPath = join(bundleDir, inspection.entry)
    return {
      fingerprint: inspection.fingerprint,
      entryPath,
      env: {
        SCRY_RECORDER_COMMIT_HOOK: entryPath,
        SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: inspection.fingerprint,
        CLAUDE_PROJECT_DIR: inspection.workspace,
        CODEX_PROJECT_DIR: inspection.workspace,
        QODER_PROJECT_DIR: inspection.workspace,
        OPENCODE_PROJECT_DIR: inspection.workspace,
        OPENCODE_WORKSPACE_DIR: inspection.workspace,
        PYTHONDONTWRITEBYTECODE: '1',
        RATE_NATIVE_ASYNC_QUEUE_DIR: join(userDataDir, 'commit-hook-queues', inspection.fingerprint.replace(':', ''))
      }
    }
  }

  return { isGranted, grantedFingerprints, grantedWorkspaces, grant, revoke, materialize }
}

export async function resolveCommitHookCapability(
  workspacePath: string,
  descriptor: CommitHookDescriptor,
  userDataDir: string,
  limits?: CommitHookLimits
): Promise<CommitHookCapability> {
  const inspection = await inspectCommitHookBundle(workspacePath, descriptor, limits)
  return createCommitHookTrustStore(userDataDir).materialize(inspection)
}

export async function resolveGrantedCommitHookCapability(
  workspacePath: string,
  descriptor: CommitHookDescriptor,
  userDataDir: string,
  limits?: CommitHookLimits
): Promise<CommitHookCapability | null> {
  const store = createCommitHookTrustStore(userDataDir)
  if ((await store.grantedFingerprints(workspacePath)).length === 0) return null
  const inspection = await inspectCommitHookBundle(workspacePath, descriptor, limits)
  if (!(await store.isGranted(inspection.workspace, inspection.fingerprint))) return null
  return store.materialize(inspection)
}
