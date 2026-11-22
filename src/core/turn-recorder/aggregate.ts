import { createHash } from 'node:crypto'
import { captureToolContent, isFullToolContentPolicy, sanitizeToolEvents, type ToolContentPolicy } from './tool-content.js'
import { isOverviewToolErrorEvent } from '../../shared/logical-calls.js'
import { deriveModelTiming } from '../../shared/model-timing.js'
import { providerDangerCoverage } from '../../shared/provider.js'
import { providerUsageResultEvents } from '../../shared/result-timing.js'
import { HOOK_DELIVERY_STAGE, type TraceEvent } from '../../shared/trace.js'
import { limitTurnDiffPatchBytes } from './git.js'
import { normalizeTurnRepositoryLocation, TURN_REPOSITORY_LOCATION_LIMITS } from '../../shared/turn-repository-location.js'
import { aggregateCallEvidence, outputSummary } from './aggregate-call-evidence.js'
import { aggregateHooks, isRecorderHook } from './aggregate-hooks.js'
import { captureOmissionReasons, joinOmissionReasons } from './aggregate-capture.js'
import { usageFrom } from './aggregate-usage.js'
import {
  available,
  partial,
  unavailable,
  type TurnCompaction,
  type TurnEvidence,
  type TurnModelSegment
} from '../../shared/turn-record.js'
import type { DiffOmissionCode } from '../../shared/turn-record-contracts.js'

function hash(text: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

type TurnFileStatus = 'succeeded' | 'failed' | 'rejected' | 'unknown'

/** 结果能证明什么，就只记什么：被拒的尝试不是已读，没有结果的尝试不是成功。 */
function fileStatusOf(event: TraceEvent, result: TraceEvent | undefined): TurnFileStatus {
  if (result) {
    // 归一化阶段只在 Provider 明确写出拒绝时标记 denialResolution，不靠工具报错正文猜。
    if (typeof result.runtimeMetadata?.denialResolution === 'string') return 'rejected'
    return result.isError ? 'failed' : 'succeeded'
  }
  // 没有配对结果时，事件本身可能就是结果（Codex 的 file_op 直接来自 patch_apply_end）。
  if (event.isError === true) return 'failed'
  if (event.isError === false) return 'succeeded'
  return 'unknown'
}

/** 成功吸收失败；同类负面证据里拒绝最能解释“为什么没有发生”。 */
function strongerFileStatus(left: TurnFileStatus, right: TurnFileStatus): TurnFileStatus {
  const rank: Record<TurnFileStatus, number> = { succeeded: 3, rejected: 2, failed: 1, unknown: 0 }
  return rank[right] > rank[left] ? right : left
}

export function modelSegmentsFrom(events: TraceEvent[]): TurnModelSegment[] {
  const output: TurnModelSegment[] = []
  const eventOrder = new Map(events.map((event, index) => [event, index]))
  let run: TraceEvent[] = []
  let runKey: string | undefined

  const flush = (): void => {
    if (!run.length) return
    const first = run[0]
    const kind = first.stage === 'thinking' ? 'thinking' : 'text'
    const deltas = kind === 'text'
      ? run.filter((event) => event.stage === 'text_delta').map((event) => event.text ?? '').join('')
      : ''
    const authoritativeEvent = kind === 'text'
      ? [...run].reverse().find((event) =>
          event.stage === 'text' && event.runtimeMetadata?.replacesStreamedText === true
        )
      : undefined
    const bodyEvents = kind === 'thinking'
      ? run.filter((event) => !!event.thinking)
      : authoritativeEvent
        ? [authoritativeEvent]
        : run.filter((event) => !(event.stage === 'text' && deltas && event.text === deltas) && !!event.text)
    const fullText = kind === 'thinking'
      ? bodyEvents.map((event) => event.thinking ?? '').join('')
      : bodyEvents.map((event) => event.text ?? '').join('')
    const contentRefs = bodyEvents
      .map((event) => event.modelContent?.contentRef)
      .filter((ref): ref is NonNullable<typeof ref> => !!ref)
    const hasCompleteRefs = bodyEvents.length > 0 && contentRefs.length === bodyEvents.length
    const text = hasCompleteRefs
      ? captureToolContent(fullText, { source: 'model_segment_preview', maxBytes: 32 * 1024 }).content ?? ''
      : fullText
    const providerItemId = typeof first.runtimeMetadata?.codexItemId === 'string'
      ? first.runtimeMetadata.codexItemId
      : undefined
    if (text) output.push({
      order: eventOrder.get(first) ?? 0,
      at: first.ts,
      kind,
      text,
      ...(hasCompleteRefs ? { contentRefs } : {}),
      ...(first.messageId ? { messageId: first.messageId } : {}),
      ...(providerItemId ? { providerItemId } : {}),
      ...(first.parentToolUseId ? { parentId: first.parentToolUseId } : {}),
      ...(first.agentId ? { agentId: first.agentId } : {})
    })
    run = []
    runKey = undefined
  }

  for (const event of events) {
    const isText = event.kind === 'model' && ['text', 'text_delta'].includes(event.stage) && event.text != null
    const isThinking = event.kind === 'model' && event.stage === 'thinking' && event.thinking != null
    if (!isText && !isThinking) {
      flush()
      continue
    }
    const key = JSON.stringify([
      isThinking ? 'thinking' : 'text',
      event.messageId ?? null,
      event.runtimeMetadata?.codexItemId ?? null,
      event.agentId ?? null,
      event.parentToolUseId ?? null
    ])
    if (runKey !== undefined && runKey !== key) flush()
    runKey = key
    run.push(event)
  }
  flush()
  return output
}

/** One code per cause the omission sentence already names, so a reader never parses that sentence. */
function patchOmissionCode(reason: string): DiffOmissionCode {
  if (reason === 'truncated') return 'patch_truncated'
  if (reason === 'budget') return 'patch_budget'
  if (reason === 'deadline') return 'patch_deadline'
  if (reason === 'policy') return 'patch_policy'
  if (reason === 'git_error') return 'patch_git_error'
  return 'patch_unavailable'
}

/**
 * Name what policy omitted, from the record's own manifest: the untracked files that exceeded the
 * manifest limit keep their path and line counts, so the count and their directories stay provable
 * without reading any body. Bodies are the only thing this reason has to explain.
 */
function policyOmissionReason(files: Array<{ path: string; change?: string }>): { reason: string; codes: DiffOmissionCode[] } {
  const untracked = files.filter((file) => file.change === 'added')
  const other = files.length - untracked.length
  const directories = new Map<string, number>()
  for (const file of untracked) {
    const segments = file.path.split('/').filter(Boolean)
    const top = segments.length > 1 ? segments[segments.length - 2] : '.'
    directories.set(top, (directories.get(top) ?? 0) + 1)
  }
  const distribution = [...directories]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([dir, count]) => `${dir} (${count})`)
    .join(', ')
  return {
    reason: [
      untracked.length > 0
        ? `${untracked.length} new untracked file(s) exceeded the manifest limit and keep only their path and line counts` +
          (distribution ? `; directories: ${distribution}` : '')
        : '',
      other > 0 ? `${other} file(s) excluded by capture.patchExcludeBasenames or capture.diffExclude` : ''
    ].filter(Boolean).join('; '),
    codes: [
      ...(untracked.length > 0 ? ['untracked_limit' as const] : []),
      ...(other > 0 ? ['patch_policy' as const] : [])
    ]
  }
}

export function aggregateTurnEvidence(args: {
  userText?: string
  events: TraceEvent[]
  source?: string
  toolContentPolicy?: ToolContentPolicy
  observable?: {
    assistant?: boolean
    tools?: boolean
    skills?: boolean
    mcps?: boolean
    hooks?: boolean
    usage?: boolean
    files?: boolean
    errors?: boolean
    diff?: boolean
    interventions?: boolean
  }
}): TurnEvidence {
  const source = args.source ?? 'trace_events'
  if (isFullToolContentPolicy(args.toolContentPolicy)) {
    args = { ...args, events: sanitizeToolEvents(args.events, args.toolContentPolicy, source) }
  }
  const providerEvent = args.events.find((event) => event.providerId || event.runtimeProvider)
  const dangerCoverage = providerDangerCoverage(providerEvent?.providerId, providerEvent?.runtimeProvider)
  const observable = {
    assistant: true,
    tools: true,
    skills: true,
    mcps: true,
    hooks: true,
    usage: true,
    files: true,
    errors: true,
    diff: true,
    // 介入证据只能由产物提供者证明存在；无证据的调用方不能把它读成“零次介入”。
    interventions: false,
    ...args.observable
  }
  const resultById = new Map<string, TraceEvent>()
  const eventOrder = new Map(args.events.map((event, index) => [event, index]))
  for (const event of args.events) {
    if (event.stage === 'tool_result' && event.toolUseId) resultById.set(event.toolUseId, event)
  }

  const { starts, tools, skills, mcps, omittedCallSections } = aggregateCallEvidence(
    args.events,
    resultById,
    eventOrder,
    args.toolContentPolicy
  )
  const hooks = aggregateHooks(args.events, eventOrder)
  // 只有带脚本身份的 hook 运行才能宣称 exact；纯投递证据只能证明事件触发过。
  const hookRunsObserved = args.events.some((event) =>
    event.kind === 'hook' && event.stage !== HOOK_DELIVERY_STAGE && !isRecorderHook(event)
  )
  // 覆盖率必须带分母：混合证据（部分 hook 有结果、部分只有投递）以前整段判 available，
  // 于是下游把派生的 failed=0 读成「Hook 成功率 100%」。未观测到结果的运行数单独算出来。
  const hookRunTotal = hooks.reduce((sum, hook) => sum + (hook.runs ?? 1), 0)
  const hookRunOutcomeUnknown = hooks.reduce(
    (sum, hook) => sum + (hook.status === 'unknown' ? hook.runs ?? 1 : 0),
    0
  )
  const modelSegments = modelSegmentsFrom(args.events)
  // Child Agent responses remain model-segment evidence, but are not the root turn's assistant answer.
  const assistantSegments = modelSegments.filter((segment) => segment.kind === 'text' && !segment.agentId && !segment.parentId)
  const assistantText = assistantSegments.map((segment) => segment.text).join('')
  const assistantContentRefs = assistantSegments.flatMap((segment) => segment.contentRefs ?? [])
  const fileMap = new Map<string, { path: string; operation: 'read' | 'write' | 'edit'; status: TurnFileStatus }>()
  for (const event of args.events) {
    if (event.stage === 'tool_result' || !event.filePath || !event.fileOp) continue
    const result = event.toolUseId ? resultById.get(event.toolUseId) : undefined
    const status = fileStatusOf(event, result)
    const key = `${event.filePath}\u0000${event.fileOp}`
    const previous = fileMap.get(key)
    // 同一路径同一种操作的多次尝试合并为一条：成功不会被另一次失败抹掉。
    fileMap.set(key, {
      path: event.filePath,
      operation: event.fileOp,
      status: previous ? strongerFileStatus(previous.status, status) : status
    })
  }
  const diffSnapshots = limitTurnDiffPatchBytes(args.events.flatMap((event) => event.turnDiff ? [event.turnDiff] : []))
  const locatedRepositories = new Set<string>()
  const diffs = diffSnapshots.map((diff) => {
    const { version: _version, repositoryLocation: rawLocation, ...record } = diff
    const repositoryLocation = normalizeTurnRepositoryLocation(rawLocation)
    if (!record.repoRoot || !repositoryLocation || locatedRepositories.has(record.repoRoot) ||
        locatedRepositories.size >= TURN_REPOSITORY_LOCATION_LIMITS.repositories) return record
    locatedRepositories.add(record.repoRoot)
    return { ...record, repositoryLocation }
  })
  const capturedDiffs = diffs.filter((diff) => diff.status === 'captured')
  const incompletePatchReasons = new Set(diffs.flatMap((diff) => diff.files.flatMap((file) =>
    file.patchStatus === 'truncated' && !file.patchContent?.contentRef
      ? ['truncated']
      : file.patchStatus === 'unavailable'
        ? [file.patchReason ?? 'unknown']
        : []
  )))
  // A policy omission has two causes the record can still name: the integrator's own exclusion list,
  // and a turn whose new untracked files exceeded the manifest limit. Both keep the file list.
  const policyOmitted = diffs.flatMap((diff) => diff.files.filter((file) =>
    file.patchStatus === 'unavailable' && file.patchReason === 'policy'))
  const policy = policyOmitted.length === 0 ? undefined : policyOmissionReason(policyOmitted)
  const policyReason = policy?.reason
  // 新建 worktree 拿不到可信基线时，记清楚是哪一种原因，不把「无法归因」退化成一句泛化文案。
  const worktreeBaselineReasons = new Set(diffs.flatMap((diff) => diff.baselineReason ? [diff.baselineReason] : []))
  const dangers = starts.flatMap((event) =>
    event.danger ? [{ ...event.danger, tool: event.tool, toolUseId: event.toolUseId }] : []
  )
  const errors = args.events.flatMap((event) =>
    (isOverviewToolErrorEvent(event) || (event.kind === 'harness' && event.stage === 'task_error' && event.isError === true))
      ? [{ message: outputSummary(event.output ?? event.text) ?? `${event.tool ?? event.stage} failed`, source: event.stage, toolUseId: event.toolUseId }]
      : []
  )
  const usage = usageFrom(args.events)
  const modelTiming = deriveModelTiming(args.events)
  const errorCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['error']))
  const assistantCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['assistant_response']))
  const callCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['tool_input', 'tool_response']))
  const modelSegmentCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['assistant_response', 'model_segments']))
  const interventions = args.events.flatMap((event) => event.intervention ? [event.intervention] : [])
  // 观测到提问/被拒但没有观测到答案或取消：这条介入不能补，只能标 partial 并写明原因。
  const interventionGaps = [
    ...new Set(args.events
      .map((event) => typeof event.runtimeMetadata?.interventionGap === 'string'
        ? event.runtimeMetadata.interventionGap as string
        : undefined)
      .filter((reason): reason is string => !!reason)),
    ...args.events
      .filter((event) => event.stage !== 'tool_result' && event.tool === 'AskUserQuestion' && !!event.toolUseId && !resultById.has(event.toolUseId))
      .map((event) => `a question (tool use ${event.toolUseId}) was never closed: neither an answer nor a cancellation was observed`)
  ]
  const compactions: TurnCompaction[] = args.events.flatMap((event) => {
    if (event.kind !== 'harness' || event.stage !== 'context_compaction') return []
    return [{
      eventId: event.id,
      at: event.ts,
      ...(event.compaction?.trigger ? { trigger: event.compaction.trigger } : {}),
      ...(event.compaction?.preTokens != null ? { preTokens: event.compaction.preTokens } : {}),
      ...(event.compaction?.postTokens != null ? { postTokens: event.compaction.postTokens } : {}),
      ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {})
    }]
  })

  // Admission lifecycle is one supplementary message, never an extra logical turn.
  const steerById = new Map<string, NonNullable<TraceEvent['steer']>>()
  for (const event of args.events) {
    if (event.kind === 'human' && event.stage === 'steer' && event.steer) steerById.set(event.steer.messageId, event.steer)
  }
  const steers = [...steerById.values()].map(({ attachments, ...steer }) => ({
    ...steer,
    attachments: attachments.map(attachment => {
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      return { name: attachment.name, mimeType: attachment.mimeType, size: bytes.byteLength, sha256: hash(bytes) }
    })
  }))

  return {
    user: args.userText != null
      ? available({ text: args.userText, textHash: hash(args.userText), ...(steers.length > 0 ? { steers } : {}) }, [source])
      : unavailable('top-level user prompt was not observable', [source]),
    assistant: !observable.assistant
      ? unavailable('provider does not expose assistant text to lifecycle hooks', [source])
      : assistantText
        ? assistantCaptureReason
          ? partial({
              text: assistantText,
              textHash: hash(assistantText),
              ...(assistantContentRefs.length > 0 ? { contentRefs: assistantContentRefs } : {})
            }, [source], assistantCaptureReason, 'exact')
          : available({
              text: assistantText,
              textHash: hash(assistantText),
              ...(assistantContentRefs.length > 0 ? { contentRefs: assistantContentRefs } : {})
            }, [source])
        : partial({}, [source], assistantCaptureReason ?? 'assistant text was not present in captured events'),
    modelSegments: !observable.assistant
      ? unavailable('provider does not expose model output to lifecycle hooks', [source])
      : modelSegmentCaptureReason
        ? partial(modelSegments, [source], modelSegmentCaptureReason, 'exact')
        : available(modelSegments, [source]),
    tools: !observable.tools
      ? unavailable('provider tool events were not observable', [source])
      : omittedCallSections.has('tools') || (!!callCaptureReason && tools.length > 0)
        ? partial(tools, [source], joinOmissionReasons([
            omittedCallSections.has('tools') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more tool call contents are missing, partial or limited; inspect content provenance' : 'one or more tool call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(tools, [source]),
    skills: !observable.skills
      ? unavailable('provider skill events were not observable', [source])
      : omittedCallSections.has('skills') || (!!callCaptureReason && skills.length > 0)
        ? partial(skills, [source], joinOmissionReasons([
            omittedCallSections.has('skills') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more skill call contents are missing, partial or limited; inspect content provenance' : 'one or more skill call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(skills, [source]),
    mcps: !observable.mcps
      ? unavailable('provider MCP events were not observable', [source])
      : omittedCallSections.has('mcps') || (!!callCaptureReason && mcps.length > 0)
        ? partial(mcps, [source], joinOmissionReasons([
            omittedCallSections.has('mcps') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more MCP call contents are missing, partial or limited; inspect content provenance' : 'one or more MCP call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(mcps, [source]),
    hooks: !observable.hooks
      ? unavailable('provider hook runtime events were not observable', [source])
      : hooks.length > 0 && !hookRunsObserved
        ? partial(
            hooks,
            [source],
            'provider only delivered hook lifecycle events; per-hook command, outcome and exit code were not observable',
            'inferred'
          )
        : hookRunOutcomeUnknown > 0
          ? partial(
              hooks,
              [source],
              `${hookRunOutcomeUnknown} of ${hookRunTotal} hook runs have no observed outcome; ` +
                'a zero failure count over this section is not proof that every hook succeeded',
              'inferred'
            )
          : available(hooks, [source]),
    usage: !observable.usage
      ? unavailable('provider usage was not observable', [source])
      : usage
        ? usage.credits || providerUsageResultEvents(args.events).some((event) => event.runtimeMetadata?.usageComplete === false)
          ? partial(usage, [source], 'one or more usage counters have partial coverage; inspect credits and context provenance', usage.contextTokens != null ? usage.contextUsageQuality ?? 'inferred' : 'exact')
          : available(usage, [source], usage.contextTokens != null ? usage.contextUsageQuality ?? 'inferred' : 'exact')
        : unavailable('no authoritative usage event was captured', [source]),
    compactions: available(compactions, [source]),
    ...(modelTiming
      ? {
          modelTiming:
            modelTiming.status === 'unavailable'
              ? { ...unavailable(modelTiming.omissionReason ?? 'model timing was unavailable', [source]), value: modelTiming.value }
              : modelTiming.status === 'available' && !modelSegmentCaptureReason
                ? available(modelTiming.value, [source], modelTiming.quality)
                : partial(
                  modelTiming.value,
                  [source],
                  joinOmissionReasons([
                    modelTiming.status === 'partial' ? modelTiming.omissionReason ?? 'model timing coverage was incomplete' : undefined,
                    modelSegmentCaptureReason
                  ]) ?? 'model timing coverage was incomplete',
                  modelTiming.quality
                )
        }
      : {}),
    files: observable.files
      ? available([...fileMap.values()], [source])
      : unavailable('provider file events were not observable', [source]),
    diff: !observable.diff
      ? unavailable('turn diff capture was disabled or unavailable', [source])
      : diffs.length === 0
        ? unavailable('turn diff snapshot was not captured', [source])
        : capturedDiffs.length === diffs.length && incompletePatchReasons.size === 0
          ? available(diffs, [source])
        : capturedDiffs.length > 0
            ? partial(
                diffs,
                [source],
                capturedDiffs.length < diffs.length
                  ? worktreeBaselineReasons.size > 0
                    ? `one or more repository snapshots were unavailable: new worktree baselines were untrustworthy (${[...worktreeBaselineReasons].join(', ')})`
                    : 'one or more repository snapshots were unavailable'
                  : `one or more file patches were omitted or truncated: ${[...incompletePatchReasons].join(', ')}` +
                    (policyReason ? `; ${policyReason}` : ''),
                'exact',
                capturedDiffs.length < diffs.length
                  ? ['snapshot_unavailable']
                  : [
                      ...[...incompletePatchReasons].map(patchOmissionCode),
                      ...(policy?.codes ?? [])
                    ]
              )
            : {
                status: 'unavailable',
                quality: 'unavailable',
                source: [source],
                value: diffs,
                omissionReason: 'no repository snapshot was captured'
              },
    dangerousOperations: !observable.tools
      ? unavailable('tool evidence was unavailable', [source])
      : dangerCoverage === 'unsupported'
        ? unavailable('danger classification is unsupported for this Provider', [source])
        : available(dangers, [source]),
    errors: !observable.errors
      ? unavailable('provider error events were not observable', [source])
      : errorCaptureReason ? partial(errors, [source], errorCaptureReason, 'exact') : available(errors, [source]),
    interventions: !observable.interventions
      ? unavailable('provider user-input events were not observable', [source])
      : interventionGaps.length > 0
        ? partial(interventions, [source], interventionGaps.join('; '), 'exact')
        : available(interventions, [source])
  }
}
