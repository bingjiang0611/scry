import type { ProviderId } from './provider.js'

export type ProviderCompatibilityStatus = 'supported' | 'graceful' | 'unsupported' | 'broken' | 'unknown'

export type ProviderCompatibilitySource = 'bundled' | 'cache' | 'remote'

export interface ProviderCompatibilityRule {
  range: string
  status: Exclude<ProviderCompatibilityStatus, 'unknown'>
  note?: string
}

export interface ProviderCompatibilityPolicy {
  provider: ProviderId
  scryRange?: string
  recommendedRange?: string
  rules: ProviderCompatibilityRule[]
}

export interface ProviderCompatibilityManifest {
  schemaVersion: 1
  updatedAt: string
  policies: ProviderCompatibilityPolicy[]
}

export interface ProviderCompatibilityAdvisory {
  status: ProviderCompatibilityStatus
  observedVersion: string | null
  recommendedRange: string | null
  matchedRange: string | null
  reason: string
  source: ProviderCompatibilitySource
  manifestUpdatedAt: string
}

interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

const SEMVER = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function normalizeProviderVersion(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const match = raw.match(/\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/)
  if (!match) return null
  return parseSemver(match[0]) ? match[0] : null
}

export function parseSemver(value: string): Semver | null {
  const match = value.trim().match(SEMVER)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] ?? null
  }
}

function comparePrerelease(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

export function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

const COMPARATOR = /^(>=|<=|>|<|=)?\s*(.+)$/

export function satisfiesRange(version: string, range: string): boolean | null {
  const target = parseSemver(version)
  if (!target) return null
  const alternatives = range.split('||').map((part) => part.trim()).filter(Boolean)
  if (alternatives.length === 0) return null
  let matched = false
  for (const alternative of alternatives) {
    const comparators = alternative.split(/\s+/).filter(Boolean)
    let ok = true
    for (const comparator of comparators) {
      const parts = comparator.match(COMPARATOR)
      const bound = parts ? parseSemver(parts[2]) : null
      if (!parts || !bound) return null
      const order = compareSemver(target, bound)
      const operator = parts[1] ?? '='
      const satisfied = operator === '>=' ? order >= 0
        : operator === '>' ? order > 0
          : operator === '<=' ? order <= 0
            : operator === '<' ? order < 0
              : order === 0
      if (!satisfied) ok = false
    }
    if (ok) matched = true
  }
  return matched
}

const STATUSES: ReadonlySet<string> = new Set(['supported', 'graceful', 'unsupported', 'broken'])
const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCompatibilityManifest(value: unknown): ProviderCompatibilityManifest | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== 1) return null
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return null
  if (!Array.isArray(value.policies)) return null
  const policies: ProviderCompatibilityPolicy[] = []
  for (const entry of value.policies) {
    if (!isRecord(entry)) return null
    if (typeof entry.provider !== 'string' || !PROVIDERS.has(entry.provider)) return null
    if (entry.scryRange !== undefined && typeof entry.scryRange !== 'string') return null
    if (entry.recommendedRange !== undefined && typeof entry.recommendedRange !== 'string') return null
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) return null
    const rules: ProviderCompatibilityRule[] = []
    for (const rule of entry.rules) {
      if (!isRecord(rule)) return null
      if (typeof rule.range !== 'string' || !rule.range.trim()) return null
      if (typeof rule.status !== 'string' || !STATUSES.has(rule.status)) return null
      if (rule.note !== undefined && typeof rule.note !== 'string') return null
      if (satisfiesRange('0.0.0', rule.range) === null) return null
      rules.push({
        range: rule.range,
        status: rule.status as ProviderCompatibilityRule['status'],
        ...(rule.note ? { note: rule.note } : {})
      })
    }
    if (entry.scryRange && satisfiesRange('0.0.0', entry.scryRange) === null) return null
    if (entry.recommendedRange && satisfiesRange('0.0.0', entry.recommendedRange) === null) return null
    policies.push({
      provider: entry.provider as ProviderId,
      ...(entry.scryRange ? { scryRange: entry.scryRange } : {}),
      ...(entry.recommendedRange ? { recommendedRange: entry.recommendedRange } : {}),
      rules
    })
  }
  return { schemaVersion: 1, updatedAt: value.updatedAt, policies }
}

export function isNewerManifest(
  candidate: ProviderCompatibilityManifest,
  current: ProviderCompatibilityManifest | undefined
): boolean {
  if (!current) return true
  return Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)
}

const STATUS_REASON: Record<Exclude<ProviderCompatibilityStatus, 'unknown'>, string> = {
  supported: '已验证版本：证据采集按预期工作',
  graceful: '可运行，但已知有证据缺口',
  unsupported: '未验证版本：Scry 不保证证据完整',
  broken: '已知不兼容版本：证据可能错误或无法运行'
}

export function resolveProviderCompatibility(args: {
  manifest: ProviderCompatibilityManifest
  source: ProviderCompatibilitySource
  provider: ProviderId
  version: string | undefined | null
  scryVersion: string
}): ProviderCompatibilityAdvisory {
  const base = { source: args.source, manifestUpdatedAt: args.manifest.updatedAt }
  const policy = args.manifest.policies.find((entry) => (
    entry.provider === args.provider &&
    (!entry.scryRange || satisfiesRange(args.scryVersion, entry.scryRange) === true)
  ))
  const observedVersion = normalizeProviderVersion(args.version)
  const recommendedRange = policy?.recommendedRange ?? null
  if (!policy) {
    return {
      ...base,
      status: 'unknown',
      observedVersion,
      recommendedRange,
      matchedRange: null,
      reason: `没有适用于 Scry ${args.scryVersion} 的 ${args.provider} 兼容性策略`
    }
  }
  if (!observedVersion) {
    return {
      ...base,
      status: 'unknown',
      observedVersion: null,
      recommendedRange,
      matchedRange: null,
      reason: args.version
        ? `无法从版本输出中解析版本号：${args.version.slice(0, 80)}`
        : '未探测到 CLI 版本'
    }
  }
  const matched = policy.rules.find((rule) => satisfiesRange(observedVersion, rule.range) === true)
  if (!matched) {
    return {
      ...base,
      status: 'unknown',
      observedVersion,
      recommendedRange,
      matchedRange: null,
      reason: `版本 ${observedVersion} 不在任何已声明的兼容性区间内`
    }
  }
  return {
    ...base,
    status: matched.status,
    observedVersion,
    recommendedRange,
    matchedRange: matched.range,
    reason: matched.note ?? `${STATUS_REASON[matched.status]}（${matched.range}）`
  }
}
