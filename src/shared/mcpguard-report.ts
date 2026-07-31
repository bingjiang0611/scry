import type {
  Finding,
  FindingEvidence,
  InventoryTarget,
  ScanReport,
  Severity,
  ToolFingerprint
} from '../cli/mcpguard-core.js'

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const string = (value: unknown): value is string => typeof value === 'string'
const optionalString = (value: unknown): boolean => value == null || typeof value === 'string'
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(string)
const nonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number.isFinite(value) && Number(value) >= 0
const sourceSpan = (value: unknown): boolean => {
  const item = record(value)
  return !!item && optionalString(item.jsonPointer)
}

function isToolFingerprint(value: unknown): value is ToolFingerprint {
  const item = record(value)
  return !!item && string(item.name) && item.kind === 'tool' && string(item.canonicalHash) &&
    optionalString(item.previousHash) && typeof item.changed === 'boolean'
}

function isTarget(value: unknown): value is InventoryTarget {
  const item = record(value)
  const introspection = record(item?.introspection)
  return !!item && string(item.targetId) && string(item.serverName) && string(item.client) && string(item.scope) &&
    ['stdio', 'streamable_http', 'sse', 'unknown'].includes(String(item.transport)) &&
    ['local_config', 'server_dir', 'package'].includes(String(item.sourceType)) && string(item.sourcePath) &&
    (item.sourceSpan == null || sourceSpan(item.sourceSpan)) && optionalString(item.command) && stringArray(item.args) &&
    optionalString(item.url) && optionalString(item.package) && optionalString(item.version) && optionalString(item.repository) &&
    stringArray(item.envKeys) && stringArray(item.roots) && typeof item.enabled === 'boolean' && string(item.serverDigest) &&
    Array.isArray(item.toolFingerprints) && item.toolFingerprints.every(isToolFingerprint) && !!introspection &&
    (introspection.status === 'not_observed' || introspection.status === 'not_run') && string(introspection.reason)
}

function isEvidence(value: unknown): value is FindingEvidence {
  const item = record(value)
  return !!item && string(item.evidenceId) &&
    ['config', 'tool_fingerprint', 'tool_description', 'baseline'].includes(String(item.kind)) &&
    string(item.targetId) && optionalString(item.path) && (item.sourceSpan == null || sourceSpan(item.sourceSpan)) &&
    optionalString(item.keyName) && optionalString(item.toolName) && optionalString(item.canonicalHash) &&
    optionalString(item.previousHash) && optionalString(item.snippetHash) && item.redacted === true
}

function isFinding(value: unknown): value is Finding {
  const item = record(value)
  const rule = record(item?.rule)
  const policy = record(item?.policy)
  return !!item && string(item.findingInstanceId) && string(item.dedupeKey) && string(item.fingerprint) &&
    string(item.title) && SEVERITIES.includes(item.severity as Severity) &&
    ['high', 'medium', 'possible'].includes(String(item.confidence)) &&
    Array.isArray(item.affectedTargets) && item.affectedTargets.every((raw) => {
      const target = record(raw)
      return !!target && string(target.targetId) && ['subject', 'source', 'sink'].includes(String(target.role))
    }) && !!rule && string(rule.id) && string(rule.version) && rule.source === 'mcpguard-rules' &&
    string(item.category) && (item.firstSeen === null || string(item.firstSeen)) &&
    (item.baselineSeen === null || typeof item.baselineSeen === 'boolean') &&
    Array.isArray(item.evidence) && item.evidence.every(isEvidence) &&
    Array.isArray(item.relationships) && item.relationships.every((relationship) => !!record(relationship)) &&
    string(item.impact) && string(item.recommendation) && stringArray(item.references) && !!policy &&
    policy.profile === 'enterprise-default' && ['block', 'warn', 'pass'].includes(String(policy.decision)) &&
    (policy.exceptionId === null || string(policy.exceptionId)) && typeof policy.allowException === 'boolean'
}

export function isMcpGuardReport(value: unknown): value is ScanReport {
  const report = record(value)
  const scan = record(report?.scan)
  const summary = record(report?.summary)
  const posture = record(report?.sessionAuthPosture)
  const audit = record(report?.audit)
  if (!report || !scan || !summary || !posture || !audit) return false
  if (report.schemaVersion !== '0.1' || scan.tool !== 'mcpguard' || !string(scan.id) || !string(scan.toolVersion) ||
      !string(scan.ruleVersion) || !string(scan.startedAt) || !Number.isFinite(Date.parse(scan.startedAt)) ||
      !string(scan.mcpSpecVersion) || scan.mode !== 'static' || scan.offline !== true ||
      scan.redactionPolicy !== 'hash_secret_values_keep_key_names' || !Array.isArray(scan.analyzers) ||
      !scan.analyzers.every((raw) => { const analyzer = record(raw); return !!analyzer && string(analyzer.name) && string(analyzer.version) })) return false
  if (!Array.isArray(report.targets) || !report.targets.every(isTarget) || !Array.isArray(report.findings) || !report.findings.every(isFinding)) return false
  if (!SEVERITIES.every((severity) => nonNegativeInteger(summary[severity])) || !['pass', 'warn', 'block'].includes(String(summary.status))) return false
  if (posture.status !== 'not_analyzed' || posture.missingAuthCount !== null || !Array.isArray(posture.items)) return false
  if (!string(audit.reportHash) || !/^sha256:[a-f0-9]{64}$/i.test(audit.reportHash) || audit.signedBundle !== null || audit.generatedFor !== 'local-only') return false
  if (!stringArray(report.errors) || !Array.isArray(report.skipped) || !report.skipped.every((raw) => {
    const item = record(raw)
    return !!item && string(item.targetId) && string(item.reason)
  })) return false

  const targetIds = new Set(report.targets.map((target) => target.targetId))
  if (targetIds.size !== report.targets.length) return false
  for (const finding of report.findings) {
    if (!finding.affectedTargets.every((target) => targetIds.has(target.targetId))) return false
    if (!finding.evidence.every((evidence) => targetIds.has(evidence.targetId))) return false
  }
  for (const skipped of report.skipped) if (!targetIds.has(skipped.targetId)) return false
  const expectedCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>
  for (const finding of report.findings) expectedCounts[finding.severity]++
  if (!SEVERITIES.every((severity) => summary[severity] === expectedCounts[severity])) return false
  const expectedStatus = expectedCounts.critical > 0 || expectedCounts.high > 0
    ? 'block'
    : report.findings.length > 0 || report.errors.length > 0 || report.skipped.some((item) => item.reason === 'dynamic_introspection_disabled')
      ? 'warn'
      : 'pass'
  return summary.status === expectedStatus
}
