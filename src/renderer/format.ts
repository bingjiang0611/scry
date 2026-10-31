// renderer 共享的纯逻辑入口：会话视图类型、调用/文件/Hook/分段/用量投影与显示格式。
// 无 React 依赖，给各组件复用。实现按职责分在同目录的 format-* / trace-batch 模块里，
// 这里保持既有导入路径不变，不承载新逻辑。
export { bashReadFiles } from './file-evidence'

export type { McpStatus, Turn } from './format-types'

export type {
  BillingAnalysis,
  BillingModelRow,
  BillingSignal,
  BillingSignalSeverity,
  BillingTurnRow
} from './format-billing'
export { analyzeBilling } from './format-billing'

export type { CallBreakdown, CallCount, McpGroup } from './format-calls'
export { aggregateCalls, logicalCallEventsForTurn, toolArg, toolDisplayName, toolMeta } from './format-calls'

export type { FileCoverage, FileRow } from './format-files'
export { aggregateFiles, bashFiles, fileBadge, fileWriteCoverage } from './format-files'

export type { HookCancellationDetail, HookCancellationKind } from './format-hook-command'
export { hookCancellationDetail, hookCommandLabel } from './format-hook-command'

export type { HookGroup, HookInstanceRow, HookScriptRow, HookSummary } from './format-hooks'
export { aggregateHooks } from './format-hooks'

export type { RichSegment, SegAct, Segment, SegmentReport } from './format-segments'
export { aggregateSegments, aggregateSegmentsRich, resultOf } from './format-segments'

export { buildSessionReport } from './format-session-report'

export type { ParsedUserMsg } from './format-text'
export { basename, fmtKnownTokens, fmtTok, fmtTokenCoverage, parseUserMessage, relTime } from './format-text'

export type { CacheHitEvidence } from './format-usage'
export { cacheHitEvidence, hasTokenUsage, resultTokenTotal } from './format-usage'

export { applyTraceBatch } from './trace-batch'
