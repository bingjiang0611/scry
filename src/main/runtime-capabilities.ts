import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { RuntimeProvider } from '../shared/runtime'
import { findMcpConfig, listMcp } from './mcp-config'
import { isSkillOff, listSkills } from './skill-config'

export interface PreparedRuntimeCapabilities {
  promptPrefix?: string
  extraAllowedDirs: string[]
  codexConfigArgs: string[]
  mcpConfigPath?: string
  metadata: Record<string, unknown>
  cleanup: () => void
}

interface DigestInfo {
  digest: string | null
  files: string[]
  bytes: number
  failures: Array<{ path: string; reason: string }>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function filesUnder(dir: string): { files: string[]; failures: Array<{ path: string; reason: string }> } {
  if (!existsSync(dir)) return { files: [], failures: [] }
  const out: string[] = []
  const failures: Array<{ path: string; reason: string }> = []
  const walk = (cur: string): void => {
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch (err) {
      failures.push({ path: cur, reason: String((err as Error).message) })
      return
    }
    for (const entry of entries) {
      const path = join(cur, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  walk(dir)
  return { files: out.sort(), failures }
}

function digestTree(dir: string): DigestInfo {
  const { files, failures } = filesUnder(dir)
  if (files.length === 0) return { digest: null, files: [], bytes: 0, failures }
  const hash = createHash('sha256')
  let bytes = 0
  const readFiles: string[] = []
  for (const file of files) {
    let content: Buffer
    try {
      content = readFileSync(file)
    } catch (err) {
      failures.push({ path: file, reason: String((err as Error).message) })
      continue
    }
    bytes += content.byteLength
    hash.update(relative(dir, file))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
    readFiles.push(file)
  }
  return {
    digest: readFiles.length > 0 ? hash.digest('hex') : null,
    files: readFiles.map((file) => relative(dir, file)),
    bytes,
    failures
  }
}

function readSkillBody(skillDir: string): { body: string; failure?: string } {
  try {
    return { body: readFileSync(join(skillDir, 'SKILL.md'), 'utf8') }
  } catch (err) {
    return { body: '', failure: String((err as Error).message) }
  }
}

function skillAbsDir(item: { scope: string; dir: string }, cwd: string | undefined, homeDir: string): string | null {
  if (item.scope === 'project') return cwd ? join(cwd, '.claude', 'skills', item.dir) : null
  if (item.scope === 'user') return join(homeDir, '.claude', 'skills', item.dir)
  return null
}

function prepareSkills(cwd: string | undefined, homeDir: string): {
  prompt: string
  dirs: string[]
  metadata: Array<Record<string, unknown>>
  failures: Array<Record<string, unknown>>
} {
  const failures: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const enabled = listSkills(cwd, homeDir).filter((item) => item.enabled && !isSkillOff(item.name, cwd, homeDir))
  const dirs: string[] = []
  const metadata: Array<Record<string, unknown>> = []
  const promptParts: string[] = []
  for (const item of enabled) {
    const dir = skillAbsDir(item, cwd, homeDir)
    if (!dir || !existsSync(join(dir, 'SKILL.md'))) {
      failures.push({ kind: 'skill', stage: 'capability', name: item.name, reason: 'missing SKILL.md' })
      continue
    }
    if (seen.has(item.name)) {
      failures.push({ kind: 'skill', stage: 'capability', name: item.name, reason: 'duplicate skill name' })
      continue
    }
    seen.add(item.name)
    dirs.push(dir)
    const bodyResult = readSkillBody(dir)
    const body = bodyResult.body
    if (bodyResult.failure) {
      failures.push({
        kind: 'skill',
        stage: 'capability',
        name: item.name,
        resource: 'SKILL.md',
        path: join(dir, 'SKILL.md'),
        reason: bodyResult.failure
      })
    }
    const references = digestTree(join(dir, 'references'))
    const assets = digestTree(join(dir, 'assets'))
    for (const failure of references.failures) {
      failures.push({
        kind: 'skill',
        stage: 'capability',
        name: item.name,
        resource: 'references',
        path: failure.path,
        reason: failure.reason
      })
    }
    for (const failure of assets.failures) {
      failures.push({
        kind: 'skill',
        stage: 'capability',
        name: item.name,
        resource: 'assets',
        path: failure.path,
        reason: failure.reason
      })
    }
    const skillMeta = {
      id: item.name,
      path: dir,
      scope: item.scope,
      injectionStrategy: 'prompt+add-dir',
      enabled: true,
      order: metadata.length,
      bodyDigest: sha256(body),
      referencesDigest: references.digest,
      references: references.files,
      referencesBytes: references.bytes,
      assetsDigest: assets.digest,
      assets: assets.files,
      assetsBytes: assets.bytes
    }
    metadata.push(skillMeta)
    promptParts.push(
      [
        `### Skill: ${item.name}`,
        `Base directory: ${dir}`,
        `Injection: prompt body plus readable skill directory via --add-dir.`,
        `Body digest: ${skillMeta.bodyDigest}`,
        `References digest: ${references.digest ?? 'none'}; files: ${references.files.join(', ') || 'none'}`,
        `Assets digest: ${assets.digest ?? 'none'}; files: ${assets.files.join(', ') || 'none'}`,
        body
      ].join('\n')
    )
  }
  return { prompt: promptParts.join('\n\n'), dirs, metadata, failures }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function codexMcpConfigArgs(name: string, cfg: Record<string, unknown>): string[] | null {
  const key = `mcp_servers.${tomlKey(name)}`
  if (typeof cfg.url === 'string' && cfg.url.trim()) return ['-c', `${key}.url=${tomlString(cfg.url)}`]
  if (typeof cfg.command !== 'string' || !cfg.command.trim()) return null
  const args = Array.isArray(cfg.args) ? cfg.args.map((arg) => String(arg)) : []
  const env = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? (cfg.env as Record<string, unknown>) : {}
  if (Object.keys(env).length > 0) return null
  const out = ['-c', `${key}.command=${tomlString(cfg.command)}`, '-c', `${key}.args=${tomlArray(args)}`]
  return out
}

function prepareMcp(
  runtimeProvider: RuntimeProvider,
  cwd: string | undefined,
  homeDir: string
): {
  codexConfigArgs: string[]
  metadata: Array<Record<string, unknown>>
  failures: Array<Record<string, unknown>>
} {
  const failures: Array<Record<string, unknown>> = []
  const metadata: Array<Record<string, unknown>> = []
  const codexConfigArgs: string[] = []
  const seen = new Set<string>()
  if (runtimeProvider === 'qoder_cli') {
    return { codexConfigArgs, metadata, failures }
  }
  for (const item of listMcp(cwd, homeDir).filter((mcp) => mcp.enabled)) {
    if (seen.has(item.name)) {
      failures.push({ kind: 'mcp', stage: 'capability', name: item.name, reason: 'duplicate MCP server name' })
      continue
    }
    seen.add(item.name)
    const cfg = findMcpConfig(item.name, cwd, homeDir)
    if (!cfg) {
      failures.push({ kind: 'mcp', stage: 'capability', name: item.name, reason: 'missing config' })
      continue
    }
    const digest = sha256(stableStringify(cfg))
    let injected = true
    let failureReason: string | null = null
    if (runtimeProvider === 'codex_cli') {
      const args = codexMcpConfigArgs(item.name, cfg)
      if (args) codexConfigArgs.push(...args)
      else {
        injected = false
        failureReason = 'unsupported Codex MCP config'
        failures.push({ kind: 'mcp', stage: 'capability', name: item.name, reason: failureReason })
      }
    }
    metadata.push({
      id: item.name,
      name: item.name,
      source: item.scope,
      transport: item.transport,
      detail: item.detail,
      digest,
      enabled: true,
      injected,
      failureReason,
      order: metadata.length,
      injectionStrategy: 'codex-config-override'
    })
  }
  return { codexConfigArgs, metadata, failures }
}

export function prepareRuntimeCapabilities(args: {
  runtimeProvider: RuntimeProvider
  cwd?: string
  homeDir: string
}): PreparedRuntimeCapabilities {
  if (args.runtimeProvider === 'claude_sdk') {
    return { extraAllowedDirs: [], codexConfigArgs: [], metadata: {}, cleanup: () => {} }
  }
  const skills = prepareSkills(args.cwd, args.homeDir)
  const mcp = prepareMcp(args.runtimeProvider, args.cwd, args.homeDir)
  const failures = [...skills.failures, ...mcp.failures]
  const metadata = {
    runtimeProvider: args.runtimeProvider,
    skills: skills.metadata,
    mcpServers: mcp.metadata,
    capabilityFailures: failures
  }
  const promptPrefix = [
    'Scry runtime capability injection:',
    'Use the enabled skills and MCP servers listed below when relevant. Do not claim a skill, reference, asset, or MCP tool was used unless you actually read or call it.',
    skills.prompt ? `## Enabled Skills\n\n${skills.prompt}` : '',
    failures.length > 0 ? `## Capability Failures\n\n${JSON.stringify(failures, null, 2)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    promptPrefix: promptPrefix || undefined,
    extraAllowedDirs: skills.dirs,
    codexConfigArgs: mcp.codexConfigArgs,
    mcpConfigPath: undefined,
    metadata,
    cleanup: () => {}
  }
}
