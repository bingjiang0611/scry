import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type Transport = 'stdio' | 'streamable_http' | 'sse' | 'unknown'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpServerTarget {
  targetId: string
  serverName: string
  client: string
  scope: string
  transport: Transport
  sourceType: 'local_config' | 'server_dir' | 'package'
  sourcePath: string
  sourceSpan?: { jsonPointer?: string }
  command?: string
  args: string[]
  url?: string
  package?: string
  version?: string
  repository?: string
  envKeys: string[]
  envSecretSources: EnvSecretSource[]
  roots: string[]
  rootSources: RootSource[]
  tools: McpToolDefinition[]
  enabled: boolean
}

export interface EnvSecretSource {
  key: string
  pointer: string
  value: string
}

export interface RootSource {
  value: string
  pointer: string
  resolvedValue?: string
  workspaceRoot?: string
  homeRoot?: string
}

export interface ToolFingerprint {
  name: string
  kind: 'tool'
  canonicalHash: string
  previousHash?: string
  changed: boolean
}

export interface InventoryTarget extends Omit<McpServerTarget, 'tools' | 'rootSources' | 'envSecretSources'> {
  serverDigest: string
  toolFingerprints: ToolFingerprint[]
  introspection: { status: 'not_observed' | 'not_run'; reason: string }
}

export interface FindingEvidence {
  evidenceId: string
  kind: 'config' | 'tool_fingerprint' | 'tool_description' | 'baseline'
  targetId: string
  path?: string
  sourceSpan?: { jsonPointer?: string }
  keyName?: string
  toolName?: string
  canonicalHash?: string
  previousHash?: string
  snippetHash?: string
  redacted: true
}

export interface Finding {
  findingInstanceId: string
  dedupeKey: string
  fingerprint: string
  title: string
  severity: Severity
  confidence: 'high' | 'medium' | 'possible'
  affectedTargets: Array<{ targetId: string; role: 'subject' | 'source' | 'sink' }>
  rule: { id: string; version: string; source: 'mcpguard-rules' }
  category: string
  firstSeen: string | null
  baselineSeen: boolean | null
  evidence: FindingEvidence[]
  relationships: Array<Record<string, unknown>>
  impact: string
  recommendation: string
  references: string[]
  policy: {
    profile: 'enterprise-default'
    decision: 'block' | 'warn' | 'pass'
    exceptionId: string | null
    allowException: boolean
  }
}

export interface ScanReport {
  schemaVersion: '0.1'
  scan: {
    id: string
    tool: 'mcpguard'
    toolVersion: string
    ruleVersion: string
    startedAt: string
    mcpSpecVersion: string
    mode: 'static'
    offline: boolean
    redactionPolicy: 'hash_secret_values_keep_key_names'
    analyzers: Array<{ name: string; version: string }>
  }
  targets: InventoryTarget[]
  summary: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number> & { status: 'pass' | 'warn' | 'block' }
  sessionAuthPosture: { status: 'not_analyzed'; missingAuthCount: null; items: unknown[] }
  findings: Finding[]
  audit: { reportHash: string; signedBundle: null; generatedFor: 'local-only' }
  errors: string[]
  skipped: Array<{ targetId: string; reason: string }>
}

export interface ScanOptions {
  configPaths?: string[]
  configDir?: string
  serverDir?: string
  packageSpec?: string
  baselinePath?: string
  now?: string
  cwd?: string
  home?: string
}

export interface CliResult {
  report: ScanReport
  text: string
  exitCode: number
}

const TOOL_VERSION = '0.1.0'
const RULE_VERSION = '2026.07.03'
const MCP_SPEC_VERSION = '2025-11-25'
const REF = 'https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html'
const SECRET_VALUE_KEY = 'token|api[_-]?key|apikey|secret|password|private[_-]?key|credential'
const SECRET_KEY = new RegExp(`(${SECRET_VALUE_KEY})`, 'i')
const SECRET_ARG_KEY = new RegExp(`(^|[-_.])(${SECRET_VALUE_KEY})($|[-_.])`, 'i')
const SECRET_ASSIGNMENT = new RegExp(`^(?:${SECRET_VALUE_KEY})=[^&\\s]+`, 'i')
const SECRET_ASSIGNMENT_ANYWHERE = new RegExp(`(?:${SECRET_VALUE_KEY})=[^&\\s]+`, 'i')
const SECRET_QUERY = new RegExp(`(?:^|[?&])(?:${SECRET_VALUE_KEY})=`, 'i')
const SECRET_ASSIGNMENT_REDACTION = new RegExp(`((?:${SECRET_VALUE_KEY})=)([^&\\s]+)`, 'gi')
const SECRET_LITERAL = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,})\b/g
const HEADER_ARG_KEY = /^(h|header|headers|http-header|proxy-header)$/i
const DISCOVERY_VALUE_FLAGS = ['--config', '--config-dir', '--server-dir', '--package', '--baseline']
const SCAN_VALUE_FLAGS = new Set([...DISCOVERY_VALUE_FLAGS, '--format', '--out', '--output', '--evidence-bundle', '--fail-on'])
const INVENTORY_VALUE_FLAGS = new Set(DISCOVERY_VALUE_FLAGS)
const BASELINE_WRITE_VALUE_FLAGS = new Set(['--report', '--out', '--output'])
const PROMPT_INJECTION = /(ignore (all )?(previous|prior) instructions|exfiltrate|send .*secret|read .*all files|system prompt|developer message)/i
const HOME = homedir()

interface DiscoveryContext {
  cwd: string
  home: string
}

interface DiscoveryResult {
  targets: McpServerTarget[]
  errors: string[]
}

interface LaunchCommand {
  command?: string
  args: string[]
  commandName: string
}

export function scanMcp(options: ScanOptions = {}): ScanReport {
  const startedAt = options.now ?? new Date().toISOString()
  const discovery = discoverTargets(options)
  const targets = discovery.targets
  const baseline = options.baselinePath ? readBaseline(options.baselinePath) : new Map<string, string>()
  const ambiguousLegacyKeys = ambiguousLegacyBaselineKeys(targets)
  const prepared = targets.map((target) => ({ raw: target, inventory: toInventoryTarget(target, baseline, ambiguousLegacyKeys), tools: target.tools }))
  const inventory = prepared.map((target) => target.inventory)
  const activePrepared = prepared.filter((target) => target.raw.enabled)
  const findings = activePrepared.flatMap((target) => scanTarget(target.inventory, target.raw, target.tools))
  const disabledSkipped = inventory.filter((target) => !target.enabled).map((target) => ({ targetId: target.targetId, reason: 'target_disabled' }))
  const unobservedSkipped = inventory
    .filter((target) => target.enabled && target.introspection.status === 'not_observed')
    .map((target) => ({ targetId: target.targetId, reason: 'dynamic_introspection_disabled' }))
  const skipped = [...disabledSkipped, ...unobservedSkipped]
  const summary = summarize(findings, unobservedSkipped.length > 0 || discovery.errors.length > 0)
  const reportWithoutHash: Omit<ScanReport, 'audit'> = {
    schemaVersion: '0.1',
    scan: {
      id: `scan_${hashText(startedAt).slice(0, 12)}`,
      tool: 'mcpguard',
      toolVersion: TOOL_VERSION,
      ruleVersion: RULE_VERSION,
      startedAt,
      mcpSpecVersion: MCP_SPEC_VERSION,
      mode: 'static',
      offline: true,
      redactionPolicy: 'hash_secret_values_keep_key_names',
      analyzers: [{ name: 'config-static', version: TOOL_VERSION }]
    },
    targets: inventory,
    summary,
    sessionAuthPosture: { status: 'not_analyzed', missingAuthCount: null, items: [] },
    findings,
    errors: discovery.errors,
    skipped
  }
  const reportHash = `sha256:${hashJson(reportWithoutHash)}`
  return { ...reportWithoutHash, audit: { reportHash, signedBundle: null, generatedFor: 'local-only' } }
}

export function renderSarif(report: ScanReport): unknown {
  const rules = new Map<string, Finding['rule']>()
  for (const finding of report.findings) rules.set(finding.rule.id, finding.rule)
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'mcpguard',
            version: report.scan.toolVersion,
            rules: [...rules.values()].map((rule) => ({
              id: rule.id,
              shortDescription: { text: rule.id },
              properties: { version: rule.version, source: rule.source }
            }))
          }
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.rule.id,
          level: sarifLevel(finding.severity),
          message: { text: finding.title },
          partialFingerprints: {
            mcpguard: finding.fingerprint,
            dedupeKey: finding.dedupeKey
          },
          properties: {
            severity: finding.severity,
            confidence: finding.confidence,
            category: finding.category,
            affectedTargets: finding.affectedTargets,
            evidence: finding.evidence,
            recommendation: finding.recommendation
          },
          locations: finding.evidence
            .filter((ev) => ev.path)
            .map((ev) => ({ physicalLocation: { artifactLocation: { uri: ev.path } } }))
        }))
      }
    ]
  }
}

export function runCli(argv: string[], io: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliResult {
  const command = argv[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') {
    return { report: scanMcp({ configPaths: [] }), text: helpText(), exitCode: 0 }
  }
  if (command === 'inventory') {
    const parsed = parseOptions(argv.slice(1), io.cwd, INVENTORY_VALUE_FLAGS)
    rejectPositional(parsed.positional, 'inventory')
    const report = scanMcp(parsed.options)
    return { report, text: `${JSON.stringify(report.targets, null, 2)}\n`, exitCode: 0 }
  }
  if (command === 'baseline' && argv[1] === 'write') {
    const parsed = parseOptions(argv.slice(2), io.cwd, BASELINE_WRITE_VALUE_FLAGS)
    const explicitReport = parsed.readArg('--report')
    if (explicitReport && parsed.positional.length > 0) throw new Error(`unexpected argument for baseline write: ${parsed.positional[0]}`)
    if (!explicitReport && parsed.positional.length > 1) throw new Error(`unexpected argument for baseline write: ${parsed.positional[1]}`)
    const reportPath = explicitReport ?? parsed.positional[0]
    const out = parsed.readArg('--out') ?? parsed.readArg('--output')
    if (!reportPath || !out) throw new Error('baseline write requires <report> and --out <file>')
    const report = JSON.parse(readFileSync(resolvePath(reportPath, io.cwd), 'utf8')) as ScanReport
    writeFileSync(resolvePath(out, io.cwd), `${JSON.stringify(baselineFromReport(report), null, 2)}\n`)
    return { report, text: `baseline written: ${out}\n`, exitCode: 0 }
  }
  if (command !== 'scan') throw new Error(`unknown command: ${command}`)
  const parsed = parseOptions(argv.slice(1), io.cwd, SCAN_VALUE_FLAGS)
  rejectPositional(parsed.positional, 'scan')
  const report = scanMcp(parsed.options)
  const format = parsed.readArg('--format') ?? 'json'
  if (format !== 'json' && format !== 'sarif') throw new Error(`invalid --format: ${format}`)
  const out = parsed.readArg('--out') ?? parsed.readArg('--output')
  const evidenceOut = parsed.readArg('--evidence-bundle')
  const failOn = parsed.readArg('--fail-on')
  const failOnSeverity = failOn ? parseSeverity(failOn) : undefined
  const payload = format === 'sarif' ? renderSarif(report) : report
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (out) writeFileSync(resolvePath(out, io.cwd), text)
  if (evidenceOut) writeFileSync(resolvePath(evidenceOut, io.cwd), `${JSON.stringify(report, null, 2)}\n`)
  const exitCode = failOnSeverity && hasSeverityAtLeast(report.findings, failOnSeverity) ? 2 : 0
  return { report, text: out ? '' : text, exitCode }
}

function parseOptions(args: string[], cwd: string | undefined, allowedValueFlags: Set<string>): { options: ScanOptions; positional: string[]; readArg: (name: string) => string | undefined } {
  const values = new Map<string, string[]>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('-') && !arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    if (!allowedValueFlags.has(name)) throw new Error(`unknown option: ${name}`)
    if (eq > 0) {
      const value = arg.slice(eq + 1)
      if (!value) throw new Error(`missing value for ${name}`)
      values.set(name, [...(values.get(name) ?? []), value])
      continue
    }
    const next = args[i + 1]
    if (!next || next.startsWith('--')) throw new Error(`missing value for ${arg}`)
    values.set(arg, [...(values.get(arg) ?? []), next])
    i += 1
  }
  const readArg = (name: string): string | undefined => values.get(name)?.at(-1)
  const readMany = (name: string): string[] => values.get(name) ?? []
  const options: ScanOptions = {
    configPaths: readMany('--config').length ? readMany('--config').map((p) => resolvePath(p, cwd)) : undefined,
    configDir: readArg('--config-dir') ? resolvePath(readArg('--config-dir') as string, cwd) : undefined,
    serverDir: readArg('--server-dir') ? resolvePath(readArg('--server-dir') as string, cwd) : undefined,
    packageSpec: readArg('--package'),
    baselinePath: readArg('--baseline') ? resolvePath(readArg('--baseline') as string, cwd) : undefined,
    cwd: cwd ? resolve(cwd) : undefined
  }
  return { options, positional, readArg }
}

function rejectPositional(positional: string[], command: string): void {
  if (positional.length > 0) throw new Error(`unexpected argument for ${command}: ${positional[0]}`)
}

function discoverTargets(options: ScanOptions): DiscoveryResult {
  const context = discoveryContext(options)
  const files = new Map<string, { skipParseErrors: boolean }>()
  const addFile = (path: string, skipParseErrors: boolean): void => {
    const previous = files.get(path)
    files.set(path, { skipParseErrors: previous ? previous.skipParseErrors && skipParseErrors : skipParseErrors })
  }
  for (const p of options.configPaths ?? []) addFile(p, false)
  if (options.configDir) {
    if (!existsSync(options.configDir)) throw new Error(`config dir not found: ${options.configDir}`)
    for (const p of findConfigFiles(options.configDir)) addFile(p, true)
  }
  if (options.configPaths === undefined && !options.configDir && !options.serverDir && !options.packageSpec) {
    for (const p of defaultConfigPaths(context)) if (existsSync(p)) addFile(p, false)
  }
  const targets: McpServerTarget[] = []
  const errors: string[] = []
  for (const [file, source] of files) {
    if (!existsSync(file)) throw new Error(`config file not found: ${file}`)
    try {
      targets.push(...parseConfigFile(file, context))
    } catch (error) {
      if (!source.skipParseErrors) throw error
      errors.push(`skipped config file ${file}: ${errorMessage(error)}`)
    }
  }
  if (options.serverDir) targets.push(serverDirTarget(options.serverDir))
  if (options.packageSpec) targets.push(packageTarget(options.packageSpec))
  return { targets, errors }
}

function discoveryContext(options: ScanOptions): DiscoveryContext {
  return {
    cwd: resolve(options.cwd ?? process.cwd()),
    home: resolve(options.home ?? HOME)
  }
}

function parseConfigFile(path: string, context: DiscoveryContext): McpServerTarget[] {
  const json = path.endsWith('.toml') ? parseTomlDocument(readFileSync(path, 'utf8')) : (JSON.parse(readFileSync(path, 'utf8')) as unknown)
  if (samePath(path, join(context.home, '.claude.json'))) return parseClaudeJsonConfig(path, json, context)

  const groups: Array<{ servers: Record<string, unknown>; pointer: string }> = []
  if (isRecord(json) && isRecord(json.mcpServers)) groups.push({ servers: json.mcpServers, pointer: '/mcpServers' })
  if (isRecord(json) && isRecord(json.mcp_servers)) groups.push({ servers: json.mcp_servers, pointer: '/mcp_servers' })
  if (isRecord(json) && isRecord(json.servers)) groups.push({ servers: json.servers, pointer: '/servers' })
  const isProjectMcpJson = samePath(path, join(context.cwd, '.mcp.json'))
  const client = isProjectMcpJson ? 'Claude' : inferClient(path)
  const scope = isProjectMcpJson ? '.mcp.json' : inferScope(path, context.home)
  const disabled = isProjectMcpJson ? claudeDisabledSet(context) : new Set<string>()
  const rootBasePath = scope === 'user' ? dirname(path) : context.cwd
  const out: McpServerTarget[] = []
  for (const group of groups) {
    for (const [serverName, raw] of Object.entries(group.servers)) {
      if (!isRecord(raw)) continue
      out.push(
        normalizeTarget({
          raw,
          serverName,
          client,
          scope,
          sourcePath: path,
          sourceType: 'local_config',
          pointer: `${group.pointer}/${escapeJsonPointer(serverName)}`,
          enabled: !disabled.has(serverName),
          rootBasePath,
          workspaceRoot: context.cwd,
          home: context.home
        })
      )
    }
  }
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseClaudeJsonConfig(path: string, json: unknown, context: DiscoveryContext): McpServerTarget[] {
  if (!isRecord(json)) return []
  const project = isRecord(json.projects) ? json.projects[context.cwd] : undefined
  const groups: Array<{ servers: Record<string, unknown>; pointer: string; scope: string }> = []
  if (isRecord(json.mcpServers)) groups.push({ servers: json.mcpServers, pointer: '/mcpServers', scope: 'user' })
  if (isRecord(project) && isRecord(project.mcpServers)) {
    groups.push({ servers: project.mcpServers, pointer: `/projects/${escapeJsonPointer(context.cwd)}/mcpServers`, scope: 'project' })
  }

  const disabled = claudeDisabledSet(context, json)
  const out: McpServerTarget[] = []
  for (const group of groups) {
    for (const [serverName, raw] of Object.entries(group.servers)) {
      if (!isRecord(raw)) continue
      const pointer = `${group.pointer}/${escapeJsonPointer(serverName)}`
      out.push(
        normalizeTarget({
          raw,
          serverName,
          client: 'Claude',
          scope: group.scope,
          sourcePath: path,
          sourceType: 'local_config',
          pointer,
          enabled: !disabled.has(serverName),
          rootBasePath: group.scope === 'project' ? context.cwd : context.home,
          workspaceRoot: context.cwd,
          home: context.home
        })
      )
    }
  }
  return out
}

function claudeDisabledSet(context: DiscoveryContext, claudeJson?: unknown): Set<string> {
  const disabled = new Set<string>()
  const enabled = new Set<string>()
  const add = (set: Set<string>, value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) set.add(String(item))
  }
  const collect = (json: unknown): void => {
    if (!isRecord(json) || !isRecord(json.projects)) return
    const project = json.projects[context.cwd]
    if (!isRecord(project)) return
    add(disabled, project.disabledMcpjsonServers)
    add(disabled, project.disabledMcpServers)
    add(enabled, project.enabledMcpjsonServers)
  }

  if (claudeJson === undefined) {
    try {
      collect(JSON.parse(readFileSync(join(context.home, '.claude.json'), 'utf8')) as unknown)
    } catch {
      /* ignore */
    }
  } else {
    collect(claudeJson)
  }
  try {
    const localSettings = JSON.parse(readFileSync(join(context.cwd, '.claude/settings.local.json'), 'utf8')) as unknown
    if (isRecord(localSettings)) {
      add(disabled, localSettings.disabledMcpjsonServers)
      add(enabled, localSettings.enabledMcpjsonServers)
    }
  } catch {
    /* ignore */
  }
  for (const name of enabled) disabled.delete(name)
  return disabled
}

function normalizeTarget(input: {
  raw: Record<string, unknown>
  serverName: string
  client: string
  scope: string
  sourcePath: string
  sourceType: McpServerTarget['sourceType']
  pointer?: string
  enabled?: boolean
  rootBasePath?: string
  workspaceRoot?: string
  home?: string
}): McpServerTarget {
  const command = stringValue(input.raw.command)
  const args = arrayStrings(input.raw.args)
  const url = stringValue(input.raw.url) ?? stringValue(input.raw.endpoint)
  const pkg = stringValue(input.raw.package) ?? inferPackage(command, args)
  const envSecretSources = extractEnvSecretSources(input.raw.env)
  const rootSources = extractRootSources(input.raw, command, args, pkg, {
    basePath: input.rootBasePath,
    workspaceRoot: input.workspaceRoot,
    home: input.home
  })
  const targetIdentity = portableTargetIdentity(input.sourcePath, input.sourceType, input.pointer, input.workspaceRoot, input.home)
  return {
    targetId: stableId(input.serverName, targetIdentity),
    serverName: input.serverName,
    client: input.client,
    scope: input.scope,
    transport: inferTransport(input.raw, command, url),
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    sourceSpan: input.pointer ? { jsonPointer: input.pointer } : undefined,
    command,
    args,
    url,
    package: pkg,
    version: stringValue(input.raw.version),
    repository: stringValue(input.raw.repository),
    envKeys: isRecord(input.raw.env) ? Object.keys(input.raw.env) : [],
    envSecretSources,
    roots: rootSources.map((root) => root.value),
    rootSources,
    tools: extractTools(input.raw),
    enabled: input.raw.enabled !== false && input.raw.disabled !== true && input.enabled !== false
  }
}

function toInventoryTarget(target: McpServerTarget, baseline: Map<string, string>, ambiguousLegacyKeys: Set<string>): InventoryTarget {
  const serverDigest = `sha256:${hashJson(redactedTarget(target))}`
  const serverHasBaseline = hasBaselineForTarget(baseline, target, ambiguousLegacyKeys) || hasAmbiguousLegacyBaselineForTarget(baseline, target, ambiguousLegacyKeys)
  const baselineHasEntries = baseline.size > 0
  const toolFingerprints = target.tools.map((tool) => {
    const canonicalHash = `sha256:${hashJson(canonicalTool(tool))}`
    const targetKey = baselineTargetToolKey(target.targetId, tool.name)
    const legacyKey = baselineServerToolKey(target.serverName, tool.name)
    const previousHash = baseline.get(targetKey) ?? (ambiguousLegacyKeys.has(legacyKey) ? undefined : baseline.get(legacyKey))
    return { name: tool.name, kind: 'tool' as const, canonicalHash, previousHash, changed: previousHash ? previousHash !== canonicalHash : serverHasBaseline || baselineHasEntries }
  })
  const base: Omit<McpServerTarget, 'tools' | 'rootSources' | 'envSecretSources'> = {
    targetId: target.targetId,
    serverName: redactedServerName(target),
    client: target.client,
    scope: target.scope,
    transport: target.transport,
    sourceType: target.sourceType,
    sourcePath: redactedSourcePath(target),
    sourceSpan: redactSourceSpan(target.sourceSpan),
    command: redactUrl(target.command),
    args: redactArgs(target.args),
    url: redactUrl(target.url),
    package: redactUrl(target.package),
    version: target.version,
    repository: redactUrl(target.repository),
    envKeys: target.envKeys,
    roots: target.roots,
    enabled: target.enabled
  }
  return {
    ...base,
    serverDigest,
    toolFingerprints,
    introspection:
      !target.enabled
        ? { status: 'not_run', reason: 'target_disabled' }
        : toolFingerprints.length > 0
          ? { status: 'not_run', reason: 'static_manifest_available' }
          : { status: 'not_observed', reason: 'no_static_manifest_or_baseline' }
  }
}

function hasBaselineForTarget(baseline: Map<string, string>, target: McpServerTarget, ambiguousLegacyKeys: Set<string>): boolean {
  const targetPrefix = `${target.targetId}:`
  const legacyPrefix = `${target.serverName}:`
  for (const key of baseline.keys()) {
    if (key.startsWith(targetPrefix)) return true
    if (key.startsWith(legacyPrefix) && !ambiguousLegacyKeys.has(key)) return true
  }
  return false
}

function hasAmbiguousLegacyBaselineForTarget(baseline: Map<string, string>, target: McpServerTarget, ambiguousLegacyKeys: Set<string>): boolean {
  return target.tools.some((tool) => {
    const legacyKey = baselineServerToolKey(target.serverName, tool.name)
    return ambiguousLegacyKeys.has(legacyKey) && baseline.has(legacyKey)
  })
}

function scanTarget(target: InventoryTarget, raw: McpServerTarget, tools: McpToolDefinition[]): Finding[] {
  if (!raw.enabled) return []
  const findings: Finding[] = []
  const add = (ruleId: string, params: Omit<Finding, 'findingInstanceId' | 'dedupeKey' | 'fingerprint' | 'rule' | 'firstSeen' | 'baselineSeen' | 'references' | 'policy'> & { evidence: FindingEvidence[]; decision?: 'block' | 'warn' }): void => {
    const evidenceKey = params.evidence.map(findingEvidenceKey).join('|')
    const dedupeKey = `${ruleId}:${target.targetId}:${evidenceKey}`
    findings.push({
      ...params,
      findingInstanceId: `fnd_${hashText(dedupeKey).slice(0, 16)}`,
      dedupeKey,
      fingerprint: `sha256:${hashText(dedupeKey)}`,
      rule: { id: ruleId, version: RULE_VERSION, source: 'mcpguard-rules' },
      firstSeen: null,
      baselineSeen: null,
      references: [REF],
      policy: {
        profile: 'enterprise-default',
        decision: params.decision ?? (params.severity === 'high' || params.severity === 'critical' ? 'block' : 'warn'),
        exceptionId: null,
        allowException: true
      }
    })
  }

  const launch = effectiveLaunch(raw.command, raw.args)
  const cmd = [launch.command, ...launch.args].filter(Boolean).join(' ')
  const commandName = normalizedCommandName(launch.commandName)
  if (launch.command && /^(bash|sh|zsh|fish|cmd|powershell|pwsh)$/i.test(commandName)) {
    add('MCP-CMD-001', {
      title: 'Server launch command uses a shell interpreter',
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'command_execution',
      evidence: [configEvidence(target, 'command', '/command', target.command)],
      relationships: [],
      impact: 'The server launch path can execute arbitrary shell logic before the MCP handshake.',
      recommendation: 'Use an explicit executable and pinned package version; avoid shell wrappers.'
    })
  }
  if (hasInlineInterpreterCode(commandName, launch.args)) {
    add('MCP-CMD-001', {
      title: 'Server launch command executes inline interpreter code',
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'command_execution',
      evidence: [configEvidence(target, 'command_args', '/args', target.args)],
      relationships: [],
      impact: 'Inline interpreter flags can execute arbitrary code before the MCP handshake.',
      recommendation: 'Move server startup into a reviewed executable or pinned package entrypoint; avoid inline code in MCP launch config.'
    })
  }
  if (isRemoteInstallLaunch(commandName, launch.args, cmd)) {
    add('MCP-CMD-002', {
      title: 'Server launch path can install or execute remote code',
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'command_execution',
      evidence: [configEvidence(target, 'command_args', '/args', target.args)],
      relationships: [],
      impact: 'Remote install or pipe-to-shell launch paths can change code at scan or session time.',
      recommendation: 'Avoid runtime package managers in MCP launch paths; if unavoidable, pin versions and install or vendor packages before execution.'
    })
  }
  for (const key of target.envKeys.filter((k) => SECRET_KEY.test(k))) {
    add('MCP-ENV-001', {
      title: `Sensitive environment key is passed to MCP server: ${key}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'secrets',
      evidence: [{ ...configEvidence(target, 'env', `/env/${escapeJsonPointer(key)}`, key), keyName: key }],
      relationships: [],
      impact: 'The server can access a sensitive credential by environment variable name.',
      recommendation: 'Use least-privilege scoped credentials and pass only the exact keys required.'
    })
  }
  for (const secret of raw.envSecretSources) {
    add('MCP-SECRET-001', {
      title: `Sensitive credential value is embedded in MCP server env: ${secret.key}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'secrets',
      evidence: [{ ...configEvidence(target, `env:${secret.key}`, secret.pointer, secret.value), keyName: secret.key }],
      relationships: [],
      impact: 'Literal credentials in MCP config can be persisted, copied, or exposed to scanners and downstream server code.',
      recommendation: 'Move credential values to a scoped secret store or environment managed outside the committed MCP config.'
    })
  }
  for (const secret of secretArgSources(raw.args)) {
    add('MCP-SECRET-001', {
      title: `Sensitive credential is passed to MCP server via argument: ${secret.label}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'secrets',
      evidence: [{ ...configEvidence(target, `args:${secret.index}`, `/args/${secret.index}`, raw.args[secret.index]), keyName: secret.label }],
      relationships: [],
      impact: 'Command-line credentials can be captured by logs, process inspection, shell history, or downstream package code.',
      recommendation: 'Use scoped environment variables or an OS secret store, and avoid embedding credential values in MCP launch arguments.'
    })
  }
  for (const secret of secretFieldSources(raw)) {
    add('MCP-SECRET-001', {
      title: `Sensitive credential is embedded in MCP server ${secret.field}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'secrets',
      evidence: [configEvidence(target, secret.field, `/${secret.field}`, secret.value)],
      relationships: [],
      impact: 'URL credentials can be persisted in config files, logs, process lists, and generated scan artifacts.',
      recommendation: 'Move credentials out of URLs and use scoped secrets passed through a controlled secret mechanism.'
    })
  }
  for (const root of raw.rootSources.filter(isBroadRoot)) {
    add('MCP-FS-001', {
      title: `MCP server has broad filesystem root: ${root.value}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'filesystem',
      evidence: [configEvidence(target, `roots:${root.value}`, root.pointer, root.value)],
      relationships: [],
      impact: 'Broad roots can expose home, workspace, SSH, Git, browser, or note data to the MCP server.',
      recommendation: 'Restrict roots to a task-specific directory.'
    })
  }
  if (raw.url && isWildcardHttpUrl(raw.url)) {
    add('MCP-HTTP-001', {
      title: 'HTTP MCP server is bound to a wildcard interface',
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'transport',
      evidence: [configEvidence(target, 'url', '/url', target.url)],
      relationships: [],
      impact: 'A local MCP server bound to all interfaces can be reachable outside localhost.',
      recommendation: 'Bind to localhost and require auth/origin protections for HTTP transports.'
    })
  }
  for (const tool of tools.filter((t) => PROMPT_INJECTION.test(t.description ?? ''))) {
    add('MCP-TOOL-001', {
      title: `Tool description contains prompt-injection language: ${tool.name}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'tool_schema',
      evidence: [toolEvidence(target, tool, 'tool_description')],
      relationships: [],
      impact: 'Tool metadata can steer model behavior before the user sees a tool call.',
      recommendation: 'Remove instruction override language from tool descriptions.'
    })
  }
  for (const fp of target.toolFingerprints.filter((f) => f.changed)) {
    add('MCP-TOOL-003', {
      title: `Tool definition drift detected: ${fp.name}`,
      severity: 'high',
      confidence: 'high',
      affectedTargets: [{ targetId: target.targetId, role: 'subject' }],
      category: 'tool_integrity',
      evidence: [{
        evidenceId: evidenceId(target, `baseline:${fp.name}`),
        kind: 'baseline',
        targetId: target.targetId,
        toolName: fp.name,
        canonicalHash: fp.canonicalHash,
        previousHash: fp.previousHash,
        redacted: true
      }],
      relationships: [],
      impact: 'A tool definition changed from the approved baseline and may represent rug pull risk.',
      recommendation: 'Review the new tool definition and update the baseline only after approval.'
    })
  }
  return findings
}

function secretArgSources(args: string[]): Array<{ index: number; label: string }> {
  const sources = new Map<number, string>()
  const add = (index: number, label: string): void => {
    if (args[index] !== undefined && !sources.has(index)) sources.set(index, label)
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const key = secretArgKey(arg)
    const eq = arg.indexOf('=')
    if (key && SECRET_ARG_KEY.test(key)) {
      if (eq >= 0) {
        if (arg.slice(eq + 1)) add(i, arg.slice(0, eq))
      } else if (args[i + 1] && !args[i + 1].startsWith('-')) {
        add(i + 1, arg)
      }
      continue
    }
    if (key && HEADER_ARG_KEY.test(key)) {
      if (eq >= 0) {
        const value = arg.slice(eq + 1)
        if (containsSecretHeader(value) || containsAuthScheme(value)) add(i, arg.slice(0, eq))
      } else if (args[i + 1] && (containsSecretHeader(args[i + 1]) || containsAuthScheme(args[i + 1]))) {
        add(i + 1, arg)
      }
      continue
    }
    if (containsSecretAssignment(arg)) add(i, arg.slice(0, arg.indexOf('=')))
    else if (containsSecretHeader(arg)) add(i, 'authorization header')
    else if (containsAuthScheme(arg)) add(i, 'authorization value')
    else if (containsSecretUrlCredential(arg)) add(i, 'url credential')
    else if (containsSecretLiteral(arg)) add(i, 'credential literal')
  }

  return [...sources.entries()].map(([index, label]) => ({ index, label }))
}

type SecretField = 'command' | 'url' | 'package' | 'repository'

function secretFieldSources(raw: McpServerTarget): Array<{ field: SecretField; value: string }> {
  const sources: Array<{ field: SecretField; value: string }> = []
  for (const field of ['command', 'url', 'package', 'repository'] as const) {
    const value = raw[field]
    if (value && containsSecretFieldCredential(value)) sources.push({ field, value })
  }
  return sources
}

function findingEvidenceKey(evidence: FindingEvidence): string {
  return hashJson({
    kind: evidence.kind,
    targetId: evidence.targetId,
    path: evidence.path,
    pointer: evidence.sourceSpan?.jsonPointer,
    keyName: evidence.keyName,
    toolName: evidence.toolName,
    canonicalHash: evidence.canonicalHash,
    previousHash: evidence.previousHash,
    snippetHash: evidence.snippetHash
  })
}

function configEvidence(target: InventoryTarget, path: string, pointer: string, observed: unknown): FindingEvidence {
  return {
    evidenceId: evidenceId(target, `${path}:${pointer}`),
    kind: 'config',
    targetId: target.targetId,
    path: target.sourcePath,
    sourceSpan: { jsonPointer: `${target.sourceSpan?.jsonPointer ?? ''}${pointer}` },
    snippetHash: `sha256:${hashJson({ targetId: target.targetId, path, pointer, observed })}`,
    redacted: true
  }
}

function toolEvidence(target: InventoryTarget, tool: McpToolDefinition, kind: FindingEvidence['kind']): FindingEvidence {
  return {
    evidenceId: evidenceId(target, `${kind}:${tool.name}`),
    kind,
    targetId: target.targetId,
    toolName: tool.name,
    canonicalHash: `sha256:${hashJson(canonicalTool(tool))}`,
    redacted: true
  }
}

function summarize(findings: Finding[], hasWarningSignals = false): ScanReport['summary'] {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, status: 'pass' as 'pass' | 'warn' | 'block' }
  for (const f of findings) summary[f.severity] += 1
  summary.status = summary.critical > 0 || summary.high > 0 ? 'block' : findings.length > 0 || hasWarningSignals ? 'warn' : 'pass'
  return summary
}

function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium' || severity === 'low') return 'warning'
  return 'note'
}

function hasSeverityAtLeast(findings: Finding[], threshold: Severity): boolean {
  const rank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }
  return findings.some((f) => rank[f.severity] >= rank[threshold])
}

function parseSeverity(value: string): Severity {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info') return value
  throw new Error(`invalid --fail-on severity: ${value}`)
}

function readBaseline(path: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const out = new Map<string, string>()
  if (!isRecord(raw) || !Array.isArray(raw.tools)) return out
  const fallbackCandidates: Array<{ key: string; hash: string }> = []
  const fallbackCounts = new Map<string, number>()
  for (const item of raw.tools) {
    if (!isRecord(item)) continue
    const targetId = stringValue(item.targetId)
    const serverName = stringValue(item.serverName)
    const toolName = stringValue(item.toolName)
    const hash = stringValue(item.canonicalHash)
    if (targetId && toolName && hash) out.set(baselineTargetToolKey(targetId, toolName), hash)
    else if (serverName && toolName && hash) out.set(baselineServerToolKey(serverName, toolName), hash)
    if (targetId && serverName && toolName && hash) {
      const key = baselineServerToolKey(serverName, toolName)
      fallbackCandidates.push({ key, hash })
      fallbackCounts.set(key, (fallbackCounts.get(key) ?? 0) + 1)
    }
  }
  for (const candidate of fallbackCandidates) {
    if (fallbackCounts.get(candidate.key) === 1 && !out.has(candidate.key)) out.set(candidate.key, candidate.hash)
  }
  return out
}

function baselineFromReport(report: ScanReport): { schemaVersion: '0.1'; tools: Array<Record<string, string>> } {
  return {
    schemaVersion: '0.1',
    tools: report.targets.flatMap((target) =>
      target.toolFingerprints.map((tool) => ({
        targetId: target.targetId,
        serverName: target.serverName,
        client: target.client,
        scope: target.scope,
        sourcePath: target.sourcePath,
        toolName: tool.name,
        canonicalHash: tool.canonicalHash
      }))
    )
  }
}

function serverDirTarget(dir: string): McpServerTarget {
  if (!existsSync(dir)) throw new Error(`server dir not found: ${dir}`)
  const pkgPath = join(dir, 'package.json')
  let name = basename(dir)
  let pkg: string | undefined
  if (existsSync(pkgPath)) {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
    if (isRecord(raw)) {
      name = stringValue(raw.name) ?? name
      pkg = stringValue(raw.name)
    }
  }
  return normalizeTarget({
    raw: { command: 'node', args: [dir], package: pkg },
    serverName: name,
    client: 'server-dir',
    scope: 'explicit',
    sourcePath: dir,
    sourceType: 'server_dir'
  })
}

function packageTarget(spec: string): McpServerTarget {
  const redactedSpec = redactUrl(spec) ?? spec
  return normalizeTarget({
    raw: { command: 'npx', args: ['-y', spec], package: spec },
    serverName: packageServerName(redactedSpec),
    client: 'package',
    scope: 'explicit',
    sourcePath: redactedSpec,
    sourceType: 'package'
  })
}

function findConfigFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const entry of readdirSync(cur)) {
      const path = join(cur, entry)
      const st = statSync(path)
      if (st.isDirectory()) stack.push(path)
      else if (entry.endsWith('.json') || entry.endsWith('.toml')) out.push(path)
    }
  }
  return out
}

function defaultConfigPaths(context: DiscoveryContext): string[] {
  return [
    join(context.cwd, '.mcp.json'),
    join(context.cwd, '.codex/config.toml'),
    join(context.cwd, '.codex/config.json'),
    join(context.cwd, '.cursor/mcp.json'),
    join(context.cwd, '.vscode/mcp.json'),
    join(context.cwd, '.claude/settings.json'),
    join(context.cwd, '.claude/settings.local.json'),
    join(context.home, '.claude.json'),
    join(context.home, 'Library/Application Support/Claude/claude_desktop_config.json'),
    join(context.home, '.config/Claude/claude_desktop_config.json'),
    join(context.home, '.claude/settings.json'),
    join(context.home, '.codex/config.toml'),
    join(context.home, '.codex/config.json'),
    join(context.home, 'Library/Application Support/Cursor/User/mcp.json'),
    join(context.home, '.cursor/mcp.json'),
    join(context.home, 'Library/Application Support/Code/User/mcp.json'),
    join(context.home, '.vscode/mcp.json'),
    join(context.home, '.codeium/windsurf/mcp_config.json'),
    join(context.home, '.gemini/settings.json'),
    join(context.home, '.aws/amazonq/mcp.json'),
    join(context.home, '.amazonq/mcp.json')
  ]
}

function inferClient(path: string): string {
  const p = path.toLowerCase()
  const segments = p.split(/[\\/]+/)
  if (p.includes('claude')) return 'Claude'
  if (p.includes('cursor')) return 'Cursor'
  if (p.includes('vscode')) return 'VS Code'
  if (p.includes('codex')) return 'Codex'
  if (p.includes('windsurf')) return 'Windsurf'
  if (p.includes('gemini')) return 'Gemini CLI'
  if (segments.includes('.amazonq') || segments.includes('amazonq') || segments.includes('amazon q')) return 'Amazon Q'
  return 'custom'
}

function inferScope(path: string, home = HOME): string {
  if (isHomeUserConfig(path, home)) return 'user'
  if (path.includes('/.vscode/') || path.includes('/.cursor/') || path.includes('/.claude/') || path.includes('/.codex/')) return 'project'
  if (path.includes(`${home}/`)) return 'user'
  return 'explicit'
}

function isHomeUserConfig(path: string, home = HOME): boolean {
  return [
    join(home, '.claude/settings.json'),
    join(home, '.codex/config.toml'),
    join(home, '.codex/config.json'),
    join(home, '.cursor/mcp.json'),
    join(home, '.vscode/mcp.json'),
    join(home, '.codeium/windsurf/mcp_config.json'),
    join(home, '.gemini/settings.json'),
    join(home, '.aws/amazonq/mcp.json'),
    join(home, '.amazonq/mcp.json')
  ].some((configPath) => samePath(path, configPath))
}

function inferTransport(raw: Record<string, unknown>, command?: string, url?: string): Transport {
  const transport = stringValue(raw.transport)?.toLowerCase()
  if (transport === 'stdio' || transport === 'sse') return transport
  if (transport === 'http' || transport === 'streamable_http') return 'streamable_http'
  if (url) return url.includes('/sse') ? 'sse' : 'streamable_http'
  if (command) return 'stdio'
  return 'unknown'
}

function inferPackage(command?: string, args: string[] = []): string | undefined {
  const launch = effectiveLaunch(command, args)
  const base = normalizedCommandName(launch.commandName)
  if (base === 'npx' || base === 'uvx' || base === 'bunx') return firstPackageArgument(launch.args)
  if (base === 'npm') return firstPackageAfterSubcommand(launch.args, ['exec', 'x'])
  if (base === 'pnpm' || base === 'yarn') return firstPackageAfterSubcommand(launch.args, ['dlx'])
  return undefined
}

function effectiveLaunch(command?: string, args: string[] = []): LaunchCommand {
  let currentCommand = command
  let currentArgs = args
  for (let depth = 0; depth < 4 && currentCommand && isEnvCommand(currentCommand); depth += 1) {
    const unwrapped = unwrapEnvLaunch(currentArgs)
    if (!unwrapped.command) break
    currentCommand = unwrapped.command
    currentArgs = unwrapped.args
  }
  return { command: currentCommand, args: currentArgs, commandName: currentCommand ? basename(currentCommand) : '' }
}

function isEnvCommand(command: string): boolean {
  return basename(command).toLowerCase() === 'env'
}

function unwrapEnvLaunch(args: string[]): Omit<LaunchCommand, 'commandName'> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') return { command: args[index + 1], args: args.slice(index + 2) }
    if (arg === '-' || isEnvAssignment(arg) || isEnvNoValueOption(arg)) continue
    const option = envValueOption(arg)
    if (option) {
      if (option.splitString) {
        const value = option.value ?? args[index + 1]
        if (!value) return { args: [] }
        const split = splitShellWords(value)
        return { command: split[0], args: [...split.slice(1), ...args.slice(index + (option.value === undefined ? 2 : 1))] }
      }
      if (option.value === undefined) index += 1
      continue
    }
    if (arg.startsWith('-')) return { args: [] }
    return { command: arg, args: args.slice(index + 1) }
  }
  return { args: [] }
}

function isEnvAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)
}

function isEnvNoValueOption(arg: string): boolean {
  return arg === '-i' || arg === '-0' || arg === '--ignore-environment' || arg === '--null' || arg === '--debug'
}

function envValueOption(arg: string): { value?: string; splitString: boolean } | undefined {
  if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') return { splitString: false }
  if (arg === '-S' || arg === '--split-string') return { splitString: true }
  if (arg.startsWith('--unset=') || arg.startsWith('--chdir=')) return { value: arg.slice(arg.indexOf('=') + 1), splitString: false }
  if (arg.startsWith('--split-string=')) return { value: arg.slice(arg.indexOf('=') + 1), splitString: true }
  if (/^-[uC].+/.test(arg)) return { value: arg.slice(2), splitString: false }
  if (/^-S.+/.test(arg)) return { value: arg.slice(2), splitString: true }
  return undefined
}

function splitShellWords(value: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const ch of value) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (quote !== "'" && ch === '\\') {
      escaped = true
      continue
    }
    if ((ch === '"' || ch === "'") && quote === ch) {
      quote = null
      continue
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

function extractRootSources(
  raw: Record<string, unknown>,
  command?: string,
  args: string[] = [],
  pkg?: string,
  context: { basePath?: string; workspaceRoot?: string; home?: string } = {}
): RootSource[] {
  const roots: RootSource[] = []
  const addRoot = (value: string, pointer: string): void => {
    roots.push({
      value,
      pointer,
      resolvedValue: resolveRootPath(value, context.basePath ?? context.workspaceRoot ?? process.cwd(), context.home ?? HOME),
      workspaceRoot: context.workspaceRoot ? resolve(context.workspaceRoot) : undefined,
      homeRoot: resolve(context.home ?? HOME)
    })
  }
  const addArray = (value: unknown, pointer: string): void => {
    arrayStrings(value).forEach((root, index) => addRoot(root, `${pointer}/${index}`))
  }
  addArray(raw.roots, '/roots')
  addArray(raw.allowedDirectories, '/allowedDirectories')
  addArray(raw.directories, '/directories')

  const root = stringValue(raw.root)
  if (root) addRoot(root, '/root')

  if (isFilesystemServer(command, args, pkg)) {
    args.forEach((arg, index) => {
      const value = filesystemRootArgValue(arg)
      if (value) addRoot(value, `/args/${index}`)
    })
  }
  return roots
}

function extractEnvSecretSources(env: unknown): EnvSecretSource[] {
  if (!isRecord(env)) return []
  const out: EnvSecretSource[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && containsSecretFieldCredential(value)) {
      out.push({ key, pointer: `/env/${escapeJsonPointer(key)}`, value })
    }
  }
  return out
}

function resolveRootPath(root: string, basePath: string, home: string): string {
  if (root === '~') return resolve(home)
  if (root.startsWith('~/')) return resolve(home, root.slice(2))
  if (root === '$HOME') return resolve(home)
  if (root.startsWith('$HOME/')) return resolve(home, root.slice(6))
  return resolve(basePath, root)
}

function isFilesystemServer(command?: string, args: string[] = [], pkg?: string): boolean {
  const candidates = [command, command ? basename(command) : undefined, pkg, ...args].filter((value): value is string => Boolean(value))
  return candidates.some((value) => {
    const normalized = value.replace(/\\/g, '/').toLowerCase()
    return /(^|[/@])(?:mcp-server-filesystem|server-filesystem)(?:$|[@/:?#])/.test(normalized)
  })
}

function filesystemRootArgValue(arg: string): string | undefined {
  const value = arg.includes('=') && arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg
  if (value === '~' || value.startsWith('~/') || value === '$HOME' || value.startsWith('$HOME/')) return value
  if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) return value
  return value.startsWith('/') ? value : undefined
}

function extractTools(raw: Record<string, unknown>): McpToolDefinition[] {
  if (!Array.isArray(raw.tools)) return []
  return raw.tools.flatMap((item) => {
    if (!isRecord(item)) return []
    const name = stringValue(item.name)
    if (!name) return []
    return [{ name, description: stringValue(item.description), inputSchema: item.inputSchema }]
  })
}

function redactedTarget(target: McpServerTarget): Record<string, unknown> {
  return {
    serverName: redactedServerName(target),
    client: target.client,
    scope: target.scope,
    transport: target.transport,
    sourceType: target.sourceType,
    command: redactUrl(target.command),
    args: redactArgs(target.args),
    url: redactUrl(target.url),
    package: redactUrl(target.package),
    version: target.version,
    repository: redactUrl(target.repository),
    envKeys: target.envKeys,
    roots: target.roots,
    enabled: target.enabled
  }
}

function redactedServerName(target: McpServerTarget): string {
  if (target.sourceType === 'package') return packageServerName(redactedSourcePath(target))
  return redactSensitiveText(target.serverName)
}

function redactedSourcePath(target: McpServerTarget): string {
  if (target.sourceType !== 'package') return target.sourcePath
  return redactUrl(target.sourcePath) ?? target.sourcePath
}

function redactSourceSpan(span?: { jsonPointer?: string }): { jsonPointer?: string } | undefined {
  if (!span?.jsonPointer) return span
  return { jsonPointer: redactJsonPointer(span.jsonPointer) }
}

function redactJsonPointer(pointer: string): string {
  if (!pointer.startsWith('/')) return redactSensitiveText(pointer)
  return pointer
    .split('/')
    .map((segment, index) => (index === 0 ? segment : escapeJsonPointer(redactSensitiveText(unescapeJsonPointer(segment)))))
    .join('/')
}

function packageServerName(spec: string): string {
  return spec.replace(/^@/, '').replace(/[^\w.-]+/g, '_')
}

function redactArgs(args: string[]): string[] {
  let redactNext = false
  let redactNextHeader = false
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false
      return '[REDACTED]'
    }
    if (redactNextHeader) {
      redactNextHeader = false
      return redactHeaderValue(arg)
    }
    const secretFlagKey = secretArgKey(arg)
    if (secretFlagKey && SECRET_ARG_KEY.test(secretFlagKey)) {
      const eq = arg.indexOf('=')
      if (eq >= 0) return `${arg.slice(0, eq + 1)}[REDACTED]`
      redactNext = true
      return arg
    }
    if (secretFlagKey && HEADER_ARG_KEY.test(secretFlagKey)) {
      const eq = arg.indexOf('=')
      if (eq >= 0) return `${arg.slice(0, eq + 1)}${redactHeaderValue(arg.slice(eq + 1))}`
      redactNextHeader = true
      return arg
    }
    if (SECRET_ASSIGNMENT.test(arg)) {
      const eq = arg.indexOf('=')
      return `${arg.slice(0, eq + 1)}[REDACTED]`
    }
    return redactUrl(arg) ?? arg
  })
}

function secretArgKey(arg: string): string | undefined {
  const match = arg.match(/^--?([^=\s]+)(?:=.*)?$/)
  return match?.[1]
}

function redactHeaderValue(value: string): string {
  return redactSensitiveText(value)
}

function redactUrl(value?: string): string | undefined {
  if (!value) return value
  if (containsSecretHeader(value)) return redactSensitiveText(value)
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, 'REDACTED')
    }
    return redactSensitiveText(url.toString())
  } catch {
    return redactSensitiveText(value)
  }
}

function containsSecretHeader(value: string): boolean {
  return /\b(?:(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie)\s*:/i.test(value)
}

function containsAuthScheme(value: string): boolean {
  return /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/i.test(value)
}

function containsSecretAssignment(value: string): boolean {
  return SECRET_ASSIGNMENT.test(value)
}

function containsSecretUrlCredential(value: string): boolean {
  if (containsSecretHeader(value)) return true
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_KEY.test(key)))
  } catch {
    return SECRET_QUERY.test(value)
  }
}

function containsSecretFieldCredential(value: string): boolean {
  return containsSecretUrlCredential(value) || SECRET_ASSIGNMENT_ANYWHERE.test(value) || containsAuthScheme(value) || containsSecretLiteral(value)
}

function containsSecretLiteral(value: string): boolean {
  SECRET_LITERAL.lastIndex = 0
  return SECRET_LITERAL.test(value)
}

function redactSensitiveText(value: string): string {
  return redactSecretLiterals(redactAuthHeaders(redactAuthSchemes(redactSecretAssignments(value))))
}

function redactSecretAssignments(value: string): string {
  return value.replace(SECRET_ASSIGNMENT_REDACTION, (_match, prefix: string, secret: string) => {
    if (secret === 'REDACTED' || secret === '[REDACTED]') return `${prefix}${secret}`
    return `${prefix}[REDACTED]`
  })
}

function redactAuthSchemes(value: string): string {
  return value.replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi, (_match, scheme: string, secret: string) => {
    if (secret === 'REDACTED' || secret === '[REDACTED]') return `${scheme} ${secret}`
    return `${scheme} [REDACTED]`
  })
}

function redactAuthHeaders(value: string): string {
  return value
    .replace(/\b((?:proxy-)?authorization\s*:\s*)(Bearer|Basic)?\s*([^\r\n,;]+)/gi, (_match, prefix: string, scheme: string | undefined, secret: string) => {
      if (secret.trim() === 'REDACTED' || secret.trim() === '[REDACTED]') return `${prefix}${scheme ? `${scheme} ` : ''}${secret.trim()}`
      return `${prefix}${scheme ? `${scheme} ` : ''}[REDACTED]`
    })
    .replace(/\b((?:x-api-key|api-key|x-auth-token|cookie)\s*:\s*)([^\r\n]+)/gi, (_match, prefix: string, secret: string) => {
      if (secret.trim() === 'REDACTED' || secret.trim() === '[REDACTED]') return `${prefix}${secret}`
      return `${prefix}[REDACTED]`
    })
}

function redactSecretLiterals(value: string): string {
  SECRET_LITERAL.lastIndex = 0
  return value.replace(SECRET_LITERAL, '[REDACTED]')
}

function canonicalTool(tool: McpToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }
}

function hashJson(value: unknown): string {
  return hashText(stableJson(value))
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(',')}}`
}

function evidenceId(target: InventoryTarget, path: string): string {
  return `ev_${hashText(`${target.targetId}:${path}`).slice(0, 12)}`
}

function stableId(name: string, path: string): string {
  return `srv_${hashText(`${path}:${name}`).slice(0, 12)}`
}

export function mcpConfigTargetId(
  serverName: string,
  sourcePath: string,
  pointer: string,
  workspaceRoot: string,
  home: string
): string {
  return stableId(
    serverName,
    portableTargetIdentity(sourcePath, 'local_config', pointer, workspaceRoot, home)
  )
}

function portableTargetIdentity(sourcePath: string, sourceType: McpServerTarget['sourceType'], pointer?: string, workspaceRoot?: string, home = HOME): string {
  const sourceIdentity = sourceType === 'package' ? `package:${sourcePath}` : portablePathIdentity(sourcePath, workspaceRoot, home)
  const pointerIdentity = pointer ? portableJsonPointer(pointer, workspaceRoot, home) : undefined
  return pointerIdentity ? `${sourceIdentity}:${pointerIdentity}` : sourceIdentity
}

function portablePathIdentity(path: string, workspaceRoot?: string, home = HOME): string {
  const resolved = normalizePath(path)
  if (workspaceRoot) {
    const root = normalizePath(workspaceRoot)
    if (isSameOrParentPath(root, resolved)) return `cwd:${relativePathIdentity(root, resolved)}`
  }
  const homeRoot = normalizePath(home)
  if (isSameOrParentPath(homeRoot, resolved)) return `home:${relativePathIdentity(homeRoot, resolved)}`
  return `path:${resolved}`
}

function relativePathIdentity(root: string, path: string): string {
  return (relative(root, path) || '.').replace(/\\/g, '/')
}

function portableJsonPointer(pointer: string, workspaceRoot?: string, home = HOME): string {
  if (!pointer.startsWith('/')) return pointer
  return pointer
    .split('/')
    .map((segment, index) => (index === 0 ? segment : escapeJsonPointer(portablePointerSegment(unescapeJsonPointer(segment), workspaceRoot, home))))
    .join('/')
}

function portablePointerSegment(segment: string, workspaceRoot?: string, home = HOME): string {
  if (!segment.startsWith('/')) return segment
  return portablePathIdentity(segment, workspaceRoot, home)
}

function ambiguousLegacyBaselineKeys(targets: McpServerTarget[]): Set<string> {
  const counts = new Map<string, number>()
  for (const target of targets) {
    for (const tool of target.tools) {
      const key = baselineServerToolKey(target.serverName, tool.name)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key))
}

function baselineTargetToolKey(targetId: string, toolName: string): string {
  return `${targetId}:${toolName}`
}

function baselineServerToolKey(serverName: string, toolName: string): string {
  return `${serverName}:${toolName}`
}

function isBroadRoot(root: RootSource): boolean {
  const raw = root.value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (raw === '/' || raw === '~' || raw === '$HOME') return true

  const resolved = normalizePath(root.resolvedValue ?? root.value)
  const home = normalizePath(root.homeRoot ?? HOME)
  if (resolved === '/' || resolved === home || /^\/Users\/[^/]+$/.test(resolved) || isSensitiveRoot(resolved, home)) return true

  const workspace = root.workspaceRoot ? normalizePath(root.workspaceRoot) : undefined
  return Boolean(workspace && isSameOrParentPath(resolved, workspace))
}

function isSensitiveRoot(resolved: string, home: string): boolean {
  const homeRelative = [
    '.ssh',
    '.aws',
    '.config/gcloud',
    '.kube',
    '.gnupg',
    '.docker',
    '.git-credentials',
    '.gitconfig',
    '.claude',
    '.codex',
    'Library/Keychains',
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Chromium',
    'Library/Application Support/Firefox',
    'Library/Application Support/BraveSoftware',
    'Library/Application Support/Microsoft Edge',
    'Library/Application Support/Claude'
  ]
  if (basename(resolved) === '.git') return true
  return homeRelative.some((relative) => isSameOrParentPath(normalizePath(join(home, relative)), resolved))
}

function hasInlineInterpreterCode(commandName: string, args: string[]): boolean {
  const base = commandName.toLowerCase()
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(base) || base === 'node' || base === 'deno') return args.some((arg) => arg === '-c' || arg === '-e' || arg === '--eval' || arg === '--print')
  if (/^(ruby|perl)$/.test(base)) return args.some((arg) => arg === '-e')
  if (base === 'php') return args.some((arg) => arg === '-r')
  return false
}

function isRemoteInstallLaunch(commandName: string, args: string[], commandLine: string): boolean {
  const base = commandName.toLowerCase()
  if (base === 'npx' || base === 'uvx' || base === 'bunx') return true
  const subcommand = firstSubcommand(args)
  if (base === 'npm' && (subcommand === 'exec' || subcommand === 'x')) return true
  if ((base === 'pnpm' || base === 'yarn') && subcommand === 'dlx') return true
  return /\b(?:curl|wget)\b[\s\S]*\|\s*(?:\/[\w./-]+\/)?(?:sh|bash|zsh)\b/i.test(commandLine)
}

function isWildcardHttpUrl(value: string): boolean {
  if (/^https?:\/\/(?:\*|\+|0\.0\.0\.0|\[::\]|\[0:0:0:0:0:0:0:0\]|\[::ffff:0\.0\.0\.0\]|\[::ffff:0:0\])(?::|\/|$)/i.test(value)) return true
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return (
      host === '*' ||
      host === '+' ||
      host === '0.0.0.0' ||
      host === '::' ||
      host === '[::]' ||
      host === '0:0:0:0:0:0:0:0' ||
      host === '[0:0:0:0:0:0:0:0]' ||
      host === '::ffff:0.0.0.0' ||
      host === '[::ffff:0.0.0.0]' ||
      host === '::ffff:0:0' ||
      host === '[::ffff:0:0]' ||
      host === '0:0:0:0:0:ffff:0:0' ||
      host === '[0:0:0:0:0:ffff:0:0]'
    )
  } catch {
    return false
  }
}

function normalizedCommandName(commandName: string): string {
  return commandName.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
}

function firstPackageArgument(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'))
}

function firstPackageAfterSubcommand(args: string[], subcommands: string[]): string | undefined {
  const index = firstSubcommandIndex(args)
  if (index < 0) return undefined
  if (!subcommands.includes(args[index])) return undefined
  return firstPackageArgument(args.slice(index + 1))
}

function firstSubcommand(args: string[]): string | undefined {
  const index = firstSubcommandIndex(args)
  return index < 0 ? undefined : args[index]
}

function firstSubcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1
    if (packageManagerInlineValueOption(arg)) continue
    if (packageManagerValueOption(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    return i
  }
  return -1
}

function packageManagerValueOption(arg: string): boolean {
  return [
    '--prefix',
    '--cache',
    '--userconfig',
    '--registry',
    '--workspace',
    '--dir',
    '--cwd',
    '--filter',
    '--store-dir',
    '--config',
    '--global-folder',
    '-C',
    '-w',
    '-F',
    '-c'
  ].includes(arg)
}

function packageManagerInlineValueOption(arg: string): boolean {
  return (
    /^--(?:prefix|cache|userconfig|registry|workspace|workspaces|dir|cwd|filter|store-dir|config|global-folder)=/.test(arg) ||
    /^-(?:C|w|F|c).+/.test(arg)
  )
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\/+$/, '') || '/'
}

function isSameOrParentPath(parent: string, child: string): boolean {
  if (parent === '/') return true
  return child === parent || child.startsWith(`${parent}/`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function arrayStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapeJsonPointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~')
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

function parseTomlDocument(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let table: Record<string, unknown> = root
  let pending: { table: Record<string, unknown>; keyPath: string[]; value: string } | undefined
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    if (pending) {
      pending.value = `${pending.value}\n${line}`
      if (tomlValueIsComplete(pending.value)) {
        assignTomlValue(pending.table, pending.keyPath, parseTomlValue(pending.value.trim()))
        pending = undefined
      }
      continue
    }
    const tableMatch = line.match(/^\[([^\]]+)\]$/)
    if (tableMatch) {
      table = ensureTomlTable(root, splitTomlDottedKey(tableMatch[1]))
      continue
    }
    const eq = findTopLevelChar(line, '=')
    if (eq < 0) continue
    const keyPath = splitTomlDottedKey(line.slice(0, eq).trim())
    const value = line.slice(eq + 1).trim()
    if (!tomlValueIsComplete(value)) {
      pending = { table, keyPath, value }
      continue
    }
    assignTomlValue(table, keyPath, parseTomlValue(value))
  }
  if (pending) assignTomlValue(pending.table, pending.keyPath, parseTomlValue(pending.value.trim()))
  return root
}

function ensureTomlTable(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let cur = root
  for (const part of path) {
    const next = cur[part]
    if (isRecord(next)) {
      cur = next
      continue
    }
    const created: Record<string, unknown> = {}
    cur[part] = created
    cur = created
  }
  return cur
}

function assignTomlValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  if (!path.length) return
  let cur = target
  for (const part of path.slice(0, -1)) cur = ensureTomlTable(cur, [part])
  cur[path[path.length - 1]] = value
}

function parseTomlValue(value: string): unknown {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return parseTomlString(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner ? splitTopLevel(inner, ',').filter((part) => part.trim()).map((part) => parseTomlValue(part.trim())) : []
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const out: Record<string, unknown> = {}
    const inner = value.slice(1, -1).trim()
    for (const entry of inner ? splitTopLevel(inner, ',') : []) {
      const eq = findTopLevelChar(entry, '=')
      if (eq < 0) continue
      assignTomlValue(out, splitTomlDottedKey(entry.slice(0, eq).trim()), parseTomlValue(entry.slice(eq + 1).trim()))
    }
    return out
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) && /^[-+]?\d+(?:\.\d+)?$/.test(value) ? numeric : value
}

function parseTomlString(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1)
  try {
    return JSON.parse(value) as string
  } catch {
    return value.slice(1, -1)
  }
}

function tomlValueIsComplete(value: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false
  let depth = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === '"' && ch === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (ch === '"' || ch === "'")) quote = quote === ch ? null : quote ?? ch
    if (!quote && (ch === '[' || ch === '{')) depth += 1
    if (!quote && (ch === ']' || ch === '}')) depth -= 1
    escaped = false
  }
  return !quote && depth <= 0
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote === '"' && ch === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (ch === '"' || ch === "'")) quote = quote === ch ? null : quote ?? ch
    if (!quote && ch === '#') return line.slice(0, i)
    escaped = false
  }
  return line
}

function splitTomlDottedKey(value: string): string[] {
  return splitTopLevel(value, '.').map((part) => parseTomlKey(part.trim())).filter(Boolean)
}

function parseTomlKey(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return parseTomlString(value)
  return value
}

function splitTopLevel(value: string, delimiter: ',' | '.'): string[] {
  const parts: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === '"' && ch === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (ch === '"' || ch === "'")) quote = quote === ch ? null : quote ?? ch
    if (!quote && (ch === '[' || ch === '{')) depth += 1
    if (!quote && (ch === ']' || ch === '}')) depth -= 1
    if (!quote && depth === 0 && ch === delimiter) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
    escaped = false
  }
  parts.push(value.slice(start).trim())
  return parts
}

function findTopLevelChar(value: string, needle: '='): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  let depth = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === '"' && ch === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (ch === '"' || ch === "'")) quote = quote === ch ? null : quote ?? ch
    if (!quote && (ch === '[' || ch === '{')) depth += 1
    if (!quote && (ch === ']' || ch === '}')) depth -= 1
    if (!quote && depth === 0 && ch === needle) return i
    escaped = false
  }
  return -1
}

function resolvePath(path: string, cwd?: string): string {
  if (path.startsWith('/')) return path
  return resolve(cwd ?? process.cwd(), path)
}

function helpText(): string {
  return `mcpguard

Usage:
  mcpguard scan [--config file] [--config-dir dir] [--server-dir dir] [--package spec] [--baseline file] [--format json|sarif] [--out file] [--evidence-bundle file] [--fail-on high]
  mcpguard inventory [--config file] [--config-dir dir] [--server-dir dir] [--package spec]
  mcpguard baseline write <report.json> --out baseline.json

P1 is static and local-only: it never executes MCP servers, never starts OAuth, and never uploads data.
`
}
