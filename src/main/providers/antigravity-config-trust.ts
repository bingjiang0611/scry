import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ANTIGRAVITY_CONFIG_DIR_ALIASES, antigravityScanRoots } from './antigravity-mcp-paths'

const MAX_CONFIG_FILE_BYTES = 1024 * 1024

export interface AntigravityConfigFileDigest {
  path: string
  size: number
  sha256: string
}

export interface AntigravityWorkspaceConfigInspection {
  cwd: string
  boundaryRoot: string
  fingerprint: string
  files: AntigravityConfigFileDigest[]
}

export interface AntigravityConfigGrantRecord {
  cwd: string
  boundaryRoot: string
  fingerprint: string
  fileCount: number
  /** 2026-09-21 policy: auto-authorized on first run and re-verified on change, never user-approved. */
  source: 'auto'
  updatedAt: number
}

interface AntigravityConfigGrantFile {
  version: 1
  grants: AntigravityConfigGrantRecord[]
}

const PLUGIN_RELATIVE_FILES = [
  'plugin.json',
  join('.antigravity-plugin', 'plugin.json'),
  join('.gemini-plugin', 'plugin.json'),
  'hooks.json',
  'mcp_config.json'
] as const

function isInsideRoot(canonicalRoot: string, canonicalTarget: string): boolean {
  const rel = relative(canonicalRoot, canonicalTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertNoSymlinkAncestors(path: string, stopAt: string): void {
  let current = resolve(path)
  const stop = resolve(stopAt)
  while (true) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`Antigravity 配置门禁拒绝符号链接（fail closed）：${current}`)
    }
    if (current === stop) return
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function inspectJsonConfigFile(
  filePath: string,
  canonicalBoundaryRoot: string,
  options: { forbidPermissionKeys?: boolean } = {}
): { digest: AntigravityConfigFileDigest; parsed: Record<string, unknown> } {
  assertNoSymlinkAncestors(filePath, canonicalBoundaryRoot)
  const stat = lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Antigravity 配置门禁拒绝非普通文件或符号链接：${filePath}`)
  }
  const canonicalFile = realpathSync.native(filePath)
  if (!isInsideRoot(canonicalBoundaryRoot, canonicalFile)) {
    throw new Error(`Antigravity 配置门禁拒绝越出工作区/仓库根的路径：${filePath}`)
  }
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new Error(`Antigravity 配置文件超过 1 MiB 大小上限（fail closed）：${filePath}`)
  }
  const raw = readFileSync(canonicalFile)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error(
      `Antigravity 配置文件 JSON 解析失败（fail closed）：${filePath} (${error instanceof Error ? error.message : String(error)})`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Antigravity 配置文件必须是 JSON 对象（fail closed）：${filePath}`)
  }
  const record = parsed as Record<string, unknown>
  if (options.forbidPermissionKeys && (record.toolPermission !== undefined || record.permissions !== undefined)) {
    throw new Error(
      `已拒绝启动 Antigravity：工作区配置文件 ${filePath} 包含权限类键（toolPermission / permissions），禁止由仓库配置抬高权限。`
    )
  }
  return {
    digest: {
      path: canonicalFile,
      size: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex')
    },
    parsed: record
  }
}

function scanPluginDir(
  pluginDir: string,
  canonicalBoundaryRoot: string,
  collected: Map<string, AntigravityConfigFileDigest>
): void {
  if (!existsSync(pluginDir)) {
    throw new Error(`Antigravity plugins.json 目标目录不存在（fail closed）：${pluginDir}`)
  }
  assertNoSymlinkAncestors(pluginDir, canonicalBoundaryRoot)
  const stat = lstatSync(pluginDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Antigravity 插件目录拒绝符号链接或非目录（fail closed）：${pluginDir}`)
  }
  const canonicalDir = realpathSync.native(pluginDir)
  if (!isInsideRoot(canonicalBoundaryRoot, canonicalDir)) {
    throw new Error(`Antigravity 插件路径越出工作区/仓库根（fail closed）：${pluginDir}`)
  }
  for (const rel of PLUGIN_RELATIVE_FILES) {
    const candidate = join(canonicalDir, rel)
    if (!existsSync(candidate)) continue
    const { digest } = inspectJsonConfigFile(candidate, canonicalBoundaryRoot)
    collected.set(digest.path, digest)
  }
}

/**
 * Inspect and fingerprint all repository-controlled Antigravity configuration surfaces
 * from `cwd` up to `.git` root (P7 §5.4 B4/B5). Fail closed on any symlink, path escape,
 * oversize file, corrupt JSON, or workspace `settings.json` containing permission keys.
 */
export function inspectAntigravityWorkspaceConfig(cwd: string): AntigravityWorkspaceConfigInspection {
  const roots = antigravityScanRoots(cwd)
  const canonicalCwd = realpathSync.native(resolve(cwd))
  const canonicalBoundaryRoot = realpathSync.native(resolve(roots[roots.length - 1]))
  if (!isInsideRoot(canonicalBoundaryRoot, canonicalCwd)) {
    throw new Error(`Antigravity 工作区路径异常：${cwd}`)
  }

  const collected = new Map<string, AntigravityConfigFileDigest>()

  for (const rawRoot of roots) {
    const canonicalRoot = realpathSync.native(resolve(rawRoot))
    if (!isInsideRoot(canonicalBoundaryRoot, canonicalRoot)) continue

    for (const settingsPath of [
      join(canonicalRoot, '.gemini', 'settings.json'),
      join(canonicalRoot, '.gemini', 'antigravity-cli', 'settings.json')
    ]) {
      if (!existsSync(settingsPath)) continue
      const { digest } = inspectJsonConfigFile(settingsPath, canonicalBoundaryRoot, { forbidPermissionKeys: true })
      collected.set(digest.path, digest)
    }

    for (const alias of ANTIGRAVITY_CONFIG_DIR_ALIASES) {
      const aliasDir = join(canonicalRoot, alias)
      if (!existsSync(aliasDir)) continue
      const aliasStat = lstatSync(aliasDir)
      if (aliasStat.isSymbolicLink()) {
        throw new Error(`Antigravity 配置门禁拒绝符号链接目录（fail closed）：${aliasDir}`)
      }
      if (!aliasStat.isDirectory()) continue

      const aliasSettings = join(aliasDir, 'settings.json')
      if (existsSync(aliasSettings)) {
        const { digest } = inspectJsonConfigFile(aliasSettings, canonicalBoundaryRoot, { forbidPermissionKeys: true })
        collected.set(digest.path, digest)
      }

      for (const name of ['hooks.json', 'mcp_config.json'] as const) {
        const candidate = join(aliasDir, name)
        if (!existsSync(candidate)) continue
        const { digest } = inspectJsonConfigFile(candidate, canonicalBoundaryRoot)
        collected.set(digest.path, digest)
      }

      const pluginsDir = join(aliasDir, 'plugins')
      if (existsSync(pluginsDir)) {
        const pluginsStat = lstatSync(pluginsDir)
        if (pluginsStat.isSymbolicLink() || !pluginsStat.isDirectory()) {
          throw new Error(`Antigravity 配置门禁拒绝符号链接 plugins 目录（fail closed）：${pluginsDir}`)
        }
        for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
          const entryPath = join(pluginsDir, entry.name)
          const entryStat = lstatSync(entryPath)
          if (entryStat.isSymbolicLink()) {
            throw new Error(`Antigravity 配置门禁拒绝符号链接插件（fail closed）：${entryPath}`)
          }
          if (!entryStat.isDirectory()) continue
          scanPluginDir(entryPath, canonicalBoundaryRoot, collected)
        }
      }

      const pluginsJsonPath = join(aliasDir, 'plugins.json')
      if (existsSync(pluginsJsonPath)) {
        const { digest, parsed } = inspectJsonConfigFile(pluginsJsonPath, canonicalBoundaryRoot)
        collected.set(digest.path, digest)
        const targets: string[] = []
        if (Array.isArray(parsed.entries)) {
          for (const entry of parsed.entries) {
            if (typeof entry === 'string') targets.push(entry)
            else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
              targets.push((entry as { path: string }).path)
            } else {
              throw new Error(`Antigravity plugins.json entries 格式非法（fail closed）：${pluginsJsonPath}`)
            }
          }
        }
        if (Array.isArray(parsed.inherits)) {
          for (const item of parsed.inherits) {
            if (typeof item === 'string') targets.push(item)
            else throw new Error(`Antigravity plugins.json inherits 格式非法（fail closed）：${pluginsJsonPath}`)
          }
        }
        for (const rawTarget of targets) {
          const resolvedTarget = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(aliasDir, rawTarget)
          if (!isInsideRoot(canonicalBoundaryRoot, resolvedTarget)) {
            throw new Error(`Antigravity plugins.json 指向路径越出工作区/仓库根（fail closed）：${rawTarget}`)
          }
          scanPluginDir(resolvedTarget, canonicalBoundaryRoot, collected)
        }
      }
    }
  }

  const files = [...collected.values()].sort((a, b) => a.path.localeCompare(b.path))
  const payload = [
    'scry-antigravity-config-v1',
    canonicalCwd,
    canonicalBoundaryRoot,
    ...files.map((f) => `${f.path}\0${f.size}\0${f.sha256}`)
  ].join('\n')
  const fingerprint = `sha256:${createHash('sha256').update(payload).digest('hex')}`

  return {
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundaryRoot,
    fingerprint,
    files
  }
}

function readGrantFile(file: string): AntigravityConfigGrantFile {
  let fd: number | undefined
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0) return { version: 1, grants: [] }
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as Partial<AntigravityConfigGrantFile>
    return {
      version: 1,
      grants: Array.isArray(parsed.grants)
        ? parsed.grants.filter(
            (grant): grant is AntigravityConfigGrantRecord =>
              !!grant &&
              typeof grant.cwd === 'string' &&
              typeof grant.boundaryRoot === 'string' &&
              typeof grant.fingerprint === 'string' &&
              typeof grant.fileCount === 'number' &&
              grant.source === 'auto' &&
              typeof grant.updatedAt === 'number'
          )
        : []
    }
  } catch {
    return { version: 1, grants: [] }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function createAntigravityConfigTrustStore(userDataDir: string) {
  const file = join(userDataDir, 'antigravity-config-grants.json')

  const verifyAndAuthorize = (cwd: string): AntigravityWorkspaceConfigInspection & {
    source: 'auto'
    changed: boolean
  } => {
    const inspection = inspectAntigravityWorkspaceConfig(cwd)
    const current = readGrantFile(file)
    const existing = current.grants.find((g) => g.cwd === inspection.cwd)
    const changed = !existing || existing.fingerprint !== inspection.fingerprint
    if (changed) {
      mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
      const next: AntigravityConfigGrantFile = {
        version: 1,
        grants: [
          ...current.grants.filter((g) => g.cwd !== inspection.cwd),
          {
            cwd: inspection.cwd,
            boundaryRoot: inspection.boundaryRoot,
            fingerprint: inspection.fingerprint,
            fileCount: inspection.files.length,
            source: 'auto',
            updatedAt: Date.now()
          }
        ]
      }
      const temporary = join(userDataDir, `.antigravity-config-grants-${process.pid}-${Date.now()}.tmp`)
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, file)
      chmodSync(file, 0o600)
    }
    return { ...inspection, source: 'auto', changed }
  }

  return { verifyAndAuthorize }
}
