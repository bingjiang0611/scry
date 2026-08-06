import { createHash, createHmac, randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { MessageBoxOptions } from 'electron'
import { scanMcp, type ScanReport, type Severity } from '../cli/mcpguard-core'
import type { ProviderId } from '../shared/provider'
import { resolveCommandOnPath } from './claude-locate'
import {
  minimalMcpEnv,
  providerMcpConfigPaths,
  proxyEnvValueContainsCredentials,
  resolveProviderMcpConfigs,
  type ResolvedMcpConfig
} from './mcp-config'

export type McpExecutionOperation = 'run' | 'live' | `test:${string}`

export interface McpExecutionSnapshot {
  providerId: ProviderId
  cwd: string
  fingerprint: string
  settingSources: string
  executionEnv: NodeJS.ProcessEnv
  targets: ResolvedMcpConfig[]
  report: ScanReport
  errors: string[]
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

const EXECUTION_SHAPING_ENV = new Set([
  'PATH', 'Path', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME',
  'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'DOTNET_STARTUP_HOOKS', 'LUA_INIT'
])

const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g

function interpolationReferences(value: unknown, path: string, result: string[]): void {
  if (typeof value === 'string') {
    const names = [...value.matchAll(ENV_INTERPOLATION)].map((match) => match[1])
    if (names.length > 0) result.push(`${path}: ${[...new Set(names)].join(', ')}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => interpolationReferences(item, `${path}[${index}]`, result))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    interpolationReferences(item, `${path}.${key}`, result)
  }
}

function normalizedExecutionTarget(
  target: ResolvedMcpConfig,
  cwd: string,
  inheritedEnv: NodeJS.ProcessEnv,
  errors: string[],
  executable: boolean
): ResolvedMcpConfig {
  const config = { ...target.config }
  if (!executable) return { ...target, config }
  const interpolations: string[] = []
  for (const key of ['command', 'args', 'env', 'url', 'headers'] as const) {
    interpolationReferences(config[key], key, interpolations)
  }
  if (interpolations.length > 0) {
    errors.push(
      `MCP server ${target.name} 使用不受支持的父进程环境插值（${interpolations.join('；')}）；请把值显式放入已审查的 config.env/headers 或安全存储`
    )
  }
  const configuredEnv = config.env && typeof config.env === 'object'
    ? config.env as Record<string, unknown>
    : {}
  const dangerousKeys = Object.keys(configuredEnv).filter((key) =>
    EXECUTION_SHAPING_ENV.has(key) || key.startsWith('DYLD_') || key.startsWith('LD_')
  )
  if (dangerousKeys.length > 0) {
    errors.push(`MCP server ${target.name} 使用可改变执行目标的 env：${dangerousKeys.join(', ')}`)
  }
  if (typeof config.command === 'string' && config.command.trim()) {
    const command = config.command.trim()
    const absolute = isAbsolute(command)
      ? command
      : command.includes('/') || command.includes('\\')
        ? resolve(cwd, command)
        : resolveCommandOnPath(command, inheritedEnv.PATH ?? '')
    if (!absolute) {
      errors.push(`MCP server ${target.name} 的 executable 无法在登录 shell PATH 中解析：${command}`)
    } else {
      try {
        const canonical = realpathSync(absolute)
        const stat = statSync(canonical)
        if (!stat.isFile()) throw new Error('not a regular file')
        if (process.platform !== 'win32') accessSync(canonical, constants.X_OK)
        config.command = canonical
        return {
          ...target,
          config,
          executableIdentity: `${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
        }
      } catch {
        errors.push(`MCP server ${target.name} 的 executable 不是可信可执行文件：${absolute}`)
      }
    }
  }
  return { ...target, config }
}

export function buildMcpExecutionSnapshot(args: {
  providerId?: ProviderId
  cwd?: string
  homeDir: string
  settingSources?: string
  env?: NodeJS.ProcessEnv
  selectedTargetId?: string
}): McpExecutionSnapshot {
  const providerId = args.providerId ?? 'claude'
  const errors: string[] = []
  const requestedCwd = args.cwd ?? process.cwd()
  let cwd = resolve(requestedCwd)
  try {
    cwd = realpathSync(cwd)
  } catch {
    errors.push(`MCP 工作目录不存在或不可解析：${requestedCwd}`)
  }
  const executionEnv = {
    ...minimalMcpEnv(args.env),
    ...(providerId === 'claude' ? { CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1' } : {})
  }
  const targets = resolveProviderMcpConfigs(providerId, args.cwd, args.homeDir, args.env).map((target) =>
    normalizedExecutionTarget(
      target,
      cwd,
      executionEnv,
      errors,
      target.enabled || target.targetId === args.selectedTargetId
    )
  )
  const credentialProxyKeys = Object.entries(args.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([key, value]) => proxyEnvValueContainsCredentials(key, value))
    .map(([key]) => key)
  const enabledRemoteTargets = targets.filter((target) => target.enabled && target.transport === 'http')
  if (credentialProxyKeys.length > 0 && enabledRemoteTargets.length > 0) {
    errors.push(
      `启用的远程 MCP（${enabledRemoteTargets.map((target) => target.name).join(', ')}）无法与含凭据代理环境隔离：${credentialProxyKeys.join(', ')}`
    )
  }
  const configPaths = providerMcpConfigPaths(providerId, args.cwd, args.homeDir, args.env)
    .filter((path) => existsSync(path))
  const report = scanMcp({ cwd, home: args.homeDir, configPaths })
  const reportIds = new Set(report.targets.map((target) => target.targetId))
  errors.push(...report.errors)
  for (const target of targets) {
    if (!reportIds.has(target.targetId)) errors.push(`MCP Guard 未识别配置目标 ${target.targetId}`)
  }
  const enabledNames = new Map<string, string[]>()
  for (const target of targets.filter((item) => item.enabled)) {
    const ids = enabledNames.get(target.name) ?? []
    ids.push(target.targetId)
    enabledNames.set(target.name, ids)
  }
  for (const [name, ids] of enabledNames) {
    if (ids.length > 1) errors.push(`MCP server ${name} 存在 ${ids.length} 个启用定义，执行优先级不唯一`)
  }
  const settingSources = args.settingSources?.trim() || `default:${providerId}:user,project,local`
  const canonical = {
    providerId,
    cwd,
    settingSources,
    executionEnv,
    targets: targets.map((target) => ({
      targetId: target.targetId,
      sourcePath: target.sourcePath,
      jsonPointer: target.jsonPointer,
      enabled: target.enabled,
      config: target.config,
      executableIdentity: target.executableIdentity
    }))
  }
  return {
    providerId,
    cwd,
    settingSources,
    executionEnv,
    targets,
    report,
    errors,
    fingerprint: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`
  }
}

export class McpExecutionTrust {
  private readonly grants = new Set<string>()

  isGranted(operation: McpExecutionOperation, snapshot: McpExecutionSnapshot): boolean {
    return this.grants.has(`${operation}\0${snapshot.cwd}\0${snapshot.fingerprint}`)
  }

  grant(operation: McpExecutionOperation, snapshot: McpExecutionSnapshot): void {
    this.grants.add(`${operation}\0${snapshot.cwd}\0${snapshot.fingerprint}`)
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

const REDACTION_DIGEST_KEY = randomBytes(32)
const DETAIL_COLUMNS = 84
const TARGET_LINES_PER_PAGE = 18

function redactionDigest(value: string): string {
  return createHmac('sha256', REDACTION_DIGEST_KEY).update(value).digest('hex').slice(0, 10)
}

function summarizedUrl(value: string, maxWidth: number, targetDigest: string): string {
  try {
    const url = new URL(value)
    const origin = `${url.protocol}//${url.host}`
    const hasRouteDetails = Boolean(url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    const route = ` · ${hasRouteDetails ? '路由' : '配置'}#${targetDigest}`
    const originWidth = Math.max(1, maxWidth - displayWidth(route))
    return `${compactIdentity(origin, originWidth)}${route}`
  } catch {
    return compactIdentity(`<无效 URL#${targetDigest}>`, maxWidth)
  }
}

function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]|\p{Default_Ignorable_Code_Point}/gu, (char) =>
      `\\u{${char.codePointAt(0)!.toString(16).padStart(4, '0')}}`
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function displayWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0)
}

function sliceStartByWidth(value: string, maxWidth: number): string {
  let width = 0
  let result = ''
  for (const char of value) {
    const next = char.codePointAt(0)! > 0x7f ? 2 : 1
    if (width + next > maxWidth) break
    result += char
    width += next
  }
  return result
}

function sliceEndByWidth(value: string, maxWidth: number): string {
  let width = 0
  let result = ''
  for (const char of [...value].reverse()) {
    const next = char.codePointAt(0)! > 0x7f ? 2 : 1
    if (width + next > maxWidth) break
    result = char + result
    width += next
  }
  return result
}

function compactIdentity(value: string, maxWidth: number): string {
  const compact = singleLine(value)
  const marker = `#${shortHash(value)}`
  const normalized = compact !== value
  if (!normalized && displayWidth(compact) <= maxWidth) return compact
  if (maxWidth <= displayWidth(marker) + 2) return marker.slice(0, Math.max(1, maxWidth))
  if (displayWidth(compact) + displayWidth(marker) + 1 <= maxWidth) return `${compact} ${marker}`
  const visibleBudget = Math.max(2, maxWidth - displayWidth(marker) - 4)
  const suffixBudget = Math.ceil(visibleBudget * 0.7)
  const prefixBudget = visibleBudget - suffixBudget
  return `${sliceStartByWidth(compact, prefixBudget)}…${marker}…${sliceEndByWidth(compact, suffixBudget)}`
}

function summarizedArgs(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  const visible = value.slice(0, 6).map((item) => {
    const raw = String(item)
    if (/^--[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw)) {
      return displayWidth(raw) <= 40 ? raw : `<flag#${redactionDigest(raw)}>`
    }
    if (/^-[A-Za-z0-9]$/.test(raw)) return raw
    const assignment = raw.match(/^(--?[A-Za-z0-9][A-Za-z0-9_-]*)=/)
    if (assignment) return `${compactIdentity(assignment[1], 32)}=<redacted:#${redactionDigest(raw)}>`
    return `<arg#${redactionDigest(raw)}>`
  })
  const hidden = value.length - visible.length
  if (hidden > 0) visible.push(`<另 ${hidden} 个参数；#${redactionDigest(stableJson(value))}>`)
  return visible.join(' ')
}

interface McpTargetDisplayFacts {
  destination: string
  args: string
  url?: string
  queryKeys: string[]
  envKeys: string[]
  headerKeys: string[]
}

function mcpTargetDisplayFacts(target: ResolvedMcpConfig): McpTargetDisplayFacts {
  const config = target.config
  const args = summarizedArgs(config.args)
  const command = String(config.command ?? '')
  const url = typeof config.url === 'string' ? config.url : undefined
  const destination = command || '(未指定启动目标)'
  let queryKeys: string[] = []
  if (url) {
    try {
      queryKeys = [...new Set(new URL(url).searchParams.keys())].sort()
    } catch {
      // Invalid URLs are represented only by a keyed digest.
    }
  }
  const envKeys = config.env && typeof config.env === 'object'
    ? Object.keys(config.env as Record<string, unknown>).sort()
    : []
  const headerKeys = config.headers && typeof config.headers === 'object'
    ? Object.keys(config.headers as Record<string, unknown>).sort()
    : []
  return { destination, args, url, queryKeys, envKeys, headerKeys }
}

function scopeLabel(scope: string): string {
  if (scope === 'user') return '用户配置'
  if (scope === 'project') return '项目配置'
  if (scope === '.mcp.json') return '项目 .mcp.json'
  return compactIdentity(scope, 32) || '未知来源'
}

function compactScopeMarker(scope: string, count: number): string {
  if (scope === '用户配置') return `用户×${count}`
  if (scope === '项目配置') return `项目×${count}`
  if (scope === '项目 .mcp.json') return `.mcp×${count}`
  return `S#${shortHash(scope).slice(0, 6)}×${count}`
}

function operationLabel(operation: McpExecutionOperation): string {
  if (operation === 'run') return '启动会话'
  if (operation === 'live') return '刷新 MCP 运行状态'
  return '测试单个 MCP 连接'
}

function guardStatusLabel(status: string): string {
  if (status === 'block') return '阻断'
  if (status === 'warn') return '警告'
  if (status === 'pass') return '通过'
  return singleLine(status) || '未知'
}

function wrappedKeyLines(
  label: string,
  keys: string[],
  values?: unknown,
  indent = '  '
): string[] {
  if (keys.length === 0) return [`${label}：无`]
  const prefix = `${label}：`
  const continuation = ' '.repeat(displayWidth(prefix))
  const tokens = keys.map((key) => compactIdentity(key, 36))
  const suffix = values === undefined ? '' : ` · 值摘要#${redactionDigest(stableJson(values))}`
  const lines: string[] = []
  let line = `${indent}${prefix}`
  for (const token of tokens) {
    const separator = line.endsWith(prefix) ? '' : ', '
    if (!line.endsWith(prefix) && displayWidth(`${line}${separator}${token}`) > DETAIL_COLUMNS) {
      lines.push(line)
      line = `${indent}${continuation}${token}`
    } else {
      line += `${separator}${token}`
    }
  }
  if (suffix && displayWidth(`${line}${suffix}`) > DETAIL_COLUMNS) {
    lines.push(line)
    line = `${indent}${continuation}${suffix.trimStart()}`
  } else {
    line += suffix
  }
  lines.push(line)
  return lines
}

function wrappedTextLines(label: string, value: string): string[] {
  const prefix = `  ${label}：`
  const continuation = ' '.repeat(displayWidth(prefix))
  const tokenWidth = DETAIL_COLUMNS - displayWidth(prefix)
  const tokens = value
    .split(' ')
    .filter(Boolean)
    .map((token) => displayWidth(token) <= tokenWidth ? token : compactIdentity(token, tokenWidth))
  const lines: string[] = []
  let line = prefix
  for (const token of tokens) {
    const separator = line === prefix ? '' : ' '
    if (line !== prefix && displayWidth(`${line}${separator}${token}`) > DETAIL_COLUMNS) {
      lines.push(line)
      line = `${continuation}${token}`
    } else {
      line += `${separator}${token}`
    }
  }
  lines.push(line)
  return lines
}

interface AuthorizationTargetBlock {
  scope: string
  continuation: string
  lines: string[]
}

function targetAuthorizationDigest(target: ResolvedMcpConfig): string {
  return redactionDigest(stableJson({
    targetId: target.targetId,
    scope: target.scope,
    transport: target.transport,
    sourcePath: target.sourcePath,
    jsonPointer: target.jsonPointer,
    enabled: target.enabled,
    config: target.config,
    executableIdentity: target.executableIdentity
  }))
}

function urlNeedsOwnLine(value: string, maxWidth: number): boolean {
  try {
    const url = new URL(value)
    const origin = `${url.protocol}//${url.host}`
    const hasRouteDetails = Boolean(url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    const suffix = ` · ${hasRouteDetails ? '路由' : '配置'}#0000000000`
    return displayWidth(origin) + displayWidth(suffix) > maxWidth
  } catch {
    return false
  }
}

function mcpExecutionAuthorizationTargetBlock(
  target: ResolvedMcpConfig,
  groupMarker = ''
): AuthorizationTargetBlock {
  const { destination, args, url, queryKeys, envKeys, headerKeys } = mcpTargetDisplayFacts(target)
  const transport = target.transport === 'http' ? 'HTTP' : target.transport
  const name = compactIdentity(target.name, 28)
  const marker = groupMarker ? `[${groupMarker}] ` : ''
  const identity = `• ${marker}${name} · ${compactIdentity(transport, 8)}`
  const prefix = `${identity} → `
  const targetDigest = targetAuthorizationDigest(target)
  const configDigest = url ? '' : ` · 配置#${targetDigest}`
  const destinationWidth = Math.max(1, DETAIL_COLUMNS - displayWidth(prefix) - displayWidth(configDigest))
  const lines = url && urlNeedsOwnLine(url, destinationWidth)
    ? [identity, `  → ${summarizedUrl(url, DETAIL_COLUMNS - 4, targetDigest)}`]
    : [`${prefix}${url ? summarizedUrl(url, destinationWidth, targetDigest) : compactIdentity(destination, destinationWidth)}${configDigest}`]
  if (args) lines.push(...wrappedTextLines('args', args))
  if (queryKeys.length > 0) lines.push(...wrappedKeyLines('query', queryKeys, url))
  if (envKeys.length > 0) lines.push(...wrappedKeyLines('env', envKeys, target.config.env))
  if (headerKeys.length > 0) lines.push(...wrappedKeyLines('headers', headerKeys, target.config.headers))
  return {
    scope: scopeLabel(target.scope),
    continuation: `• ${name}（续）`,
    lines
  }
}

export function mcpExecutionAuthorizationTargetLine(target: ResolvedMcpConfig): string {
  return mcpExecutionAuthorizationTargetBlock(target).lines.join('\n')
}

export type McpExecutionGuardSummary = ScanReport['summary'] & { incomplete: number }

export function mcpExecutionGuardSummary(
  snapshot: McpExecutionSnapshot,
  selected: ResolvedMcpConfig[]
): McpExecutionGuardSummary {
  const selectedIds = new Set(selected.map((target) => target.targetId))
  const inventoryById = new Map(snapshot.report.targets.map((target) => [target.targetId, target]))
  const findings = snapshot.report.findings.filter((finding) =>
    finding.affectedTargets.some((target) => selectedIds.has(target.targetId))
  )
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  const incompleteIds = new Set(
    selected
      .filter((target) => inventoryById.get(target.targetId)?.enabled !== true)
      .map((target) => target.targetId)
  )
  for (const item of snapshot.report.skipped) {
    if (selectedIds.has(item.targetId)) incompleteIds.add(item.targetId)
  }
  const status: ScanReport['summary']['status'] = counts.critical > 0 || counts.high > 0
    ? 'block'
    : findings.length > 0 || incompleteIds.size > 0
      ? 'warn'
      : 'pass'
  return { ...counts, status, incomplete: incompleteIds.size }
}

function guardSummaryLine(summary: McpExecutionGuardSummary): string {
  const labels: Array<[Severity, string]> = [
    ['critical', '严重'], ['high', '高'], ['medium', '中'], ['low', '低'], ['info', '信息']
  ]
  const findings = labels
    .filter(([severity]) => summary[severity] > 0)
    .map(([severity, label]) => `${label} ${summary[severity]}`)
  if (summary.incomplete > 0) findings.push(`未完整扫描 ${summary.incomplete}`)
  if (findings.length === 0) findings.push('无风险项')
  return `Guard：${guardStatusLabel(summary.status)} · ${findings.join(' / ')}`
}

function splitTargetBlock(block: AuthorizationTargetBlock): AuthorizationTargetBlock[] {
  const available = TARGET_LINES_PER_PAGE
  if (block.lines.length <= available) return [block]
  const [primary, ...detail] = block.lines
  const chunks: AuthorizationTargetBlock[] = []
  let offset = 0
  let first = true
  while (offset < detail.length || first) {
    const heading = first ? primary : block.continuation
    const take = Math.max(0, available - 1)
    chunks.push({ ...block, lines: [heading, ...detail.slice(offset, offset + take)] })
    offset += take
    first = false
  }
  return chunks
}

function targetPages(selected: ResolvedMcpConfig[]): string[][] {
  const groups = new Map<string, ResolvedMcpConfig[]>()
  for (const target of selected) {
    const scope = scopeLabel(target.scope)
    const targets = groups.get(scope) ?? []
    targets.push(target)
    groups.set(scope, targets)
  }
  const pages: string[][] = []
  let page: string[] = []
  const flush = (): void => {
    if (page.length > 0) pages.push(page)
    page = []
  }
  for (const [scope, targets] of groups) {
    for (const [targetIndex, target] of targets.entries()) {
      const groupMarker = targetIndex === 0 ? compactScopeMarker(scope, targets.length) : ''
      const original = mcpExecutionAuthorizationTargetBlock(target, groupMarker)
      for (const block of splitTargetBlock(original)) {
        if (page.length > 0 && page.length + block.lines.length > TARGET_LINES_PER_PAGE) flush()
        page.push(...block.lines)
      }
    }
  }
  flush()
  return pages.length > 0 ? pages : [[]]
}

/**
 * Builds the compact native-dialog body. Execution-wide facts are shown once;
 * every selected target keeps a compact, redacted destination line.
 */
export function mcpExecutionAuthorizationDetail(
  snapshot: McpExecutionSnapshot,
  operation: McpExecutionOperation,
  selected: ResolvedMcpConfig[]
): string {
  return mcpExecutionAuthorizationPages(snapshot, operation, selected).join('\n\n')
}

export function mcpExecutionAuthorizationPages(
  snapshot: McpExecutionSnapshot,
  operation: McpExecutionOperation,
  selected: ResolvedMcpConfig[]
): string[] {
  const severity = mcpExecutionGuardSummary(snapshot, selected)
  const inheritedKeys = Object.keys(snapshot.executionEnv).sort()
  const proxyKeys = inheritedKeys.filter((key) => /^(?:https?|all|no)_proxy$/i.test(key))
  const sources = new Map<string, number>()
  for (const target of selected) {
    const label = scopeLabel(target.scope)
    sources.set(label, (sources.get(label) ?? 0) + 1)
  }
  const sourceSequence = [...sources.entries()].map(([label, count]) => `${label} ${count}`).join(' → ') || '无'
  const common = [
    `工作目录：${compactIdentity(snapshot.cwd, DETAIL_COLUMNS - 10)}`,
    `操作：${operationLabel(operation)} · ${guardSummaryLine(severity)}`,
    `继承环境：${inheritedKeys.length} 个白名单键${proxyKeys.length > 0 ? `（代理 ${proxyKeys.length}）` : ''} · 值摘要#${redactionDigest(stableJson(snapshot.executionEnv))}`
  ]
  const pages = targetPages(selected)
  return pages.map((targets, index) => [
    ...common,
    '',
    `执行对象（${selected.length}${pages.length > 1 ? `；清单 ${index + 1}/${pages.length}` : ''}）：${sourceSequence}`,
    ...targets,
    '',
    '授权绑定当前进程、目录、配置与操作；变化或重启后重新询问。'
  ].join('\n'))
}

export interface McpExecutionAuthorizationPrompt {
  status: ScanReport['summary']['status']
  title: string
  message: string
  confirmLabel: string
  pages: string[]
}

export function mcpExecutionAuthorizationPrompt(
  snapshot: McpExecutionSnapshot,
  operation: McpExecutionOperation,
  selected: ResolvedMcpConfig[]
): McpExecutionAuthorizationPrompt {
  const severity = mcpExecutionGuardSummary(snapshot, selected)
  return {
    status: severity.status,
    title: '授权 MCP 执行',
    message: `允许 Scry 执行 ${selected.length} 个 MCP 配置？`,
    confirmLabel: severity.status === 'pass' ? `执行 ${selected.length} 个 MCP` : `仍然执行 ${selected.length} 个 MCP`,
    pages: mcpExecutionAuthorizationPages(snapshot, operation, selected)
  }
}

export function mcpExecutionAuthorizationDialogOptions(
  prompt: McpExecutionAuthorizationPrompt,
  pageIndex: number,
  platform = process.platform
): MessageBoxOptions {
  const lastPage = pageIndex === prompt.pages.length - 1
  return {
    type: prompt.status === 'pass' ? 'info' : 'warning',
    title: prompt.title,
    message: prompt.pages.length > 1 ? `${prompt.message}（第 ${pageIndex + 1}/${prompt.pages.length} 页）` : prompt.message,
    detail: prompt.pages[pageIndex],
    buttons: ['取消', lastPage ? prompt.confirmLabel : `查看下一页（${pageIndex + 2}/${prompt.pages.length}）`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    ...(platform === 'darwin' ? { textWidth: 600 } : {})
  }
}

export async function confirmMcpExecutionAuthorization(
  prompt: McpExecutionAuthorizationPrompt,
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>,
  platform = process.platform
): Promise<boolean> {
  for (let pageIndex = 0; pageIndex < prompt.pages.length; pageIndex++) {
    const result = await showMessageBox(mcpExecutionAuthorizationDialogOptions(prompt, pageIndex, platform))
    if (result.response !== 1) return false
  }
  return true
}
