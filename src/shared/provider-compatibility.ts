import type { ProviderId } from './provider.js'

/**
 * Provider CLI 版本兼容性策略。
 *
 * Scry 观测的是本机已安装的 Provider CLI，它们的发版节奏与 Scry 无关：一个新版本
 * 可能换掉 transcript 结构、审批协议或 rollout 字段，让 Scry 的证据变得不完整甚至
 * 错误。版本判定必须是可声明、可随时更新的数据，而不是散落在各 adapter 里的硬编码
 * if；同时它只是**建议**，绝不替用户阻止运行，也绝不在拉取失败时让探测失败。
 *
 * 四档语义（与证据诚实原则一一对应）：
 * - `supported`：已验证，证据完整。
 * - `graceful`：可用，但已知有能力缺失；UI 必须说明缺什么。
 * - `unsupported`：未验证过，证据可能不完整，不保证正确。
 * - `broken`：已知会产出错误证据或无法运行。
 * - `unknown`：没有适用规则或版本号无法解析；不得冒充 supported。
 */
export type ProviderCompatibilityStatus = 'supported' | 'graceful' | 'unsupported' | 'broken' | 'unknown'

/** manifest 的来源，决定这条建议的权威性，必须随建议一起暴露。 */
export type ProviderCompatibilitySource = 'bundled' | 'cache' | 'remote'

export interface ProviderCompatibilityRule {
  /** 版本范围，例如 `>=1.2.0 <2.0.0`；多段用 `||` 取并集。 */
  range: string
  status: Exclude<ProviderCompatibilityStatus, 'unknown'>
  /** 面向用户的说明，例如缺失哪项证据。 */
  note?: string
}

export interface ProviderCompatibilityPolicy {
  provider: ProviderId
  /** 本条策略适用的 Scry 版本范围；缺省表示所有版本。 */
  scryRange?: string
  /** 推荐安装的 Provider CLI 版本范围。 */
  recommendedRange?: string
  /** 顺序匹配，先命中先生效。 */
  rules: ProviderCompatibilityRule[]
}

export interface ProviderCompatibilityManifest {
  schemaVersion: 1
  /** ISO 时间戳，用于在 remote / 磁盘缓存 / 内置之间择新。 */
  updatedAt: string
  policies: ProviderCompatibilityPolicy[]
}

export interface ProviderCompatibilityAdvisory {
  status: ProviderCompatibilityStatus
  /** 规整后的版本号；无法解析时为 null，此时 status 必为 unknown。 */
  observedVersion: string | null
  recommendedRange: string | null
  /** 命中的规则范围，便于用户复核判定依据。 */
  matchedRange: string | null
  reason: string
  source: ProviderCompatibilitySource
  manifestUpdatedAt: string
}

interface Semver {
  major: number
  minor: number
  patch: number
  /** 预发布标识；存在时版本低于同号正式版。 */
  prerelease: string | null
}

const SEMVER = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 从 CLI 原始输出里取出可比较的版本号。Provider 的 `--version` 会混入名称、构建号或
 * 日期前缀（如 `codex-cli 0.52.0`、`2026.01.02-a1b2c3`），取第一个 semver 形状的片段；
 * 取不到就返回 null，让上层如实标 unknown，而不是猜一个版本去比较。
 */
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

/**
 * 范围求值。支持 `>= > <= < =` 比较符，空格分隔取交集，`||` 取并集。
 * 范围或版本无法解析时返回 null —— 这是「判不了」，不是「不匹配」。
 */
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
const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格校验 manifest。任何一条非法就整体拒绝：半个策略表会让某些 Provider 静默失去
 * 兼容性判定，而用户看到的仍是「已检查」。拒绝后调用方回退到上一份可信 manifest。
 */
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
      // 范围必须可求值，否则这条规则永远判不出结果。
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

/** `updatedAt` 更新的 manifest 胜出；时间相同或无法比较时保留现有的。 */
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
  /** CLI 原始版本输出，可带名称/前缀。 */
  version: string | undefined | null
  /** 当前 Scry 版本，用于挑选适用策略。 */
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
