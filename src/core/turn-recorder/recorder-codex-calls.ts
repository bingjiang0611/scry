import type { TraceEvent } from '../../shared/trace.js'
import { stableHash } from './store.js'
import { type NormalizedCodexCall, type ParsedTranscriptTurn, stringsIn, summarize, stringAt } from './recorder-contracts.js'

export function finalizeCodexTurns(
  turns: ParsedTranscriptTurn[],
  current: ParsedTranscriptTurn | undefined,
  injectedSkill: string | undefined
): ParsedTranscriptTurn[] {
  for (const turn of turns) {
    const injection = turn.events.find((event) =>
      event.kind === 'skill' &&
      (event.input as Record<string, unknown> | undefined)?.source === 'skill_injection'
    )
    const skill = injection?.name ?? (turn === current ? injectedSkill : undefined)
    if (skill && turn.userText && !turn.userText.startsWith('/')) turn.userText = `/${skill} ${turn.userText}`
  }
  return turns
}


export function appendCodexPatchResult(
  current: ParsedTranscriptTurn,
  payload: Record<string, unknown>,
  runId: string,
  at: string,
  logicalIdsByOuterCall: Map<string, string[]>,
  toolById: Map<string, string>
): void {
  const outerId = stringAt(payload, 'call_id', 'callId')
  if (outerId) {
    const ids = logicalIdsByOuterCall.get(outerId) ?? [outerId]
    const output = outputText(payload.stdout ?? payload.stderr)
    for (const toolUseId of ids) {
      current.events.push({
        id: `codex-patch-result-${stableHash([toolUseId, at]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'tool',
        stage: 'tool_result',
        tool: toolById.get(toolUseId) ?? 'Edit',
        toolUseId,
        text: output,
        output,
        isError: payload.success === false
      })
    }
  }
  const rawChanges = payload.changes
  const changes: Array<[string, Record<string, unknown>]> = Array.isArray(rawChanges)
    ? rawChanges.flatMap((path) => typeof path === 'string' ? [[path, {}] as [string, Record<string, unknown>]] : [])
    : rawChanges && typeof rawChanges === 'object'
      ? Object.entries(rawChanges as Record<string, unknown>).map(([path, rawChange]) => [
          path,
          rawChange && typeof rawChange === 'object' && !Array.isArray(rawChange)
            ? rawChange as Record<string, unknown>
            : {}
        ])
      : []
  for (const [path] of changes) {
    current.events.push({
      id: `codex-file-${stableHash([path, at]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'harness',
      stage: 'file_op',
      filePath: path,
      fileOp: 'edit'
    })
  }
  current.observable.files = current.observable.files || changes.length > 0
}

export function callInput(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Custom Codex tools may persist their JavaScript source verbatim.
  }
  return { raw }
}

export function balancedCallArgument(source: string, openIndex: number): string | undefined {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '{' || char === '[') depth++
    else if (char === ')' || char === '}' || char === ']') {
      depth--
      if (depth === 0) return source.slice(openIndex + 1, index).trim()
    }
  }
  return undefined
}

export function literalArgument(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    if (typeof parsed === 'string') return { raw: parsed }
  } catch {
    // JavaScript variables/expressions are still useful as bounded evidence, but are not evaluated.
  }
  return { raw: value }
}

export function isCodexSpawnTool(name: string): boolean {
  // Only the native namespace is an alias; MCP and unknown namespaces retain their identity.
  return name === 'spawn_agent' || name === 'multi_agent_v1__spawn_agent'
}

export function codexToolName(name: string, input: Record<string, unknown>): NormalizedCodexCall | null {
  if (name === 'wait' || name === 'write_stdin') return null
  if (['list_agents', 'send_message', 'followup_task', 'interrupt_agent'].includes(name)) return null
  if (name === 'wait_agent') {
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined
    if (timeoutMs != null && timeoutMs < 5_000) return null
    return { tool: 'collaboration:wait', input }
  }
  if (name === 'exec_command') {
    const command = typeof input.cmd === 'string' ? input.cmd : typeof input.command === 'string' ? input.command : undefined
    return {
      tool: 'Bash',
      input: {
        ...(command ? { command } : {}),
        ...(typeof input.workdir === 'string' ? { cwd: input.workdir } : {}),
        ...(typeof input.yield_time_ms === 'number' ? { yieldTimeMs: input.yield_time_ms } : {})
      }
    }
  }
  if (name === 'apply_patch') {
    return { tool: 'Edit', input: { patch: input.raw ?? input.patch ?? input } }
  }
  if (isCodexSpawnTool(name)) {
    return {
      tool: 'Agent',
      input: {
        ...input,
        subagent_type: input.task_name ?? input.taskName,
        description: input.task_name ?? input.taskName
      }
    }
  }
  const collaboration = /^collaboration[._:-](.+)$/.exec(name)?.[1] ?? (
    name === 'wait_agent' ? name : undefined
  )
  if (collaboration) {
    const camel = collaboration.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase())
    return { tool: `collaboration:${camel}`, input }
  }
  if (name === 'update_plan') return { tool: 'update_plan', input }
  return { tool: name, input }
}

export function staticCommandMaps(source: string): Map<number, NormalizedCodexCall[]> {
  const arrays = new Map<string, string[]>()
  const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  for (const match of source.matchAll(arrayPattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const content = balancedCallArgument(source, openIndex)
    if (content == null) continue
    try {
      const values = JSON.parse(`[${content}]`) as unknown
      if (Array.isArray(values) && values.every((value) => typeof value === 'string')) arrays.set(match[1], values)
      else if (
        Array.isArray(values) &&
        values.every((value) => Array.isArray(value) && typeof value[0] === 'string')
      ) {
        arrays.set(match[1], values.map((value) => value[0] as string))
      }
    } catch {
      // Only literal string arrays are safe to expand without evaluating JavaScript.
    }
  }

  const expansions = new Map<number, NormalizedCodexCall[]>()
  const mapPattern = /\b([A-Za-z_$][\w$]*)\.map\(\s*(?:\(\s*\[\s*([A-Za-z_$][\w$]*)[^\]]*\]\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*tools\.exec_command\s*\(/g
  for (const match of source.matchAll(mapPattern)) {
    const commands = arrays.get(match[1])
    if (!commands) continue
    const commandVariable = match[2] ?? match[3]
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const argument = balancedCallArgument(source, openIndex)
    if (!argument || !commandVariable || !new RegExp(`(?:^|[{,]\\s*)${commandVariable}(?:\\s*[,}])`).test(argument)) continue
    const common: Record<string, unknown> = {}
    for (const key of ['workdir'] as const) {
      const value = new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(argument)?.[1]
      if (value) {
        try {
          common[key] = JSON.parse(value) as string
        } catch {
          // Ignore malformed optional metadata; the command remains authoritative.
        }
      }
    }
    for (const key of ['yield_time_ms', 'max_output_tokens'] as const) {
      const value = new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(argument)?.[1]
      if (value) common[key] = Number(value)
    }
    expansions.set(openIndex, commands.map((cmd) => codexToolName('exec_command', { cmd, ...common })!))
  }
  return expansions
}

export function nestedCodexCalls(source: string): NormalizedCodexCall[] {
  const calls: NormalizedCodexCall[] = []
  const mapped = staticCommandMaps(source)
  const pattern = /\btools\.([A-Za-z0-9_:.]+)\s*\(/g
  for (const match of source.matchAll(pattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const expanded = mapped.get(openIndex)
    if (expanded) {
      for (const call of expanded) calls.push({ ...call, suffix: String(calls.length + 1) })
      continue
    }
    const argument = balancedCallArgument(source, openIndex)
    if (argument == null) continue
    const normalized = codexToolName(match[1], literalArgument(argument))
    if (normalized) calls.push({ ...normalized, suffix: String(calls.length + 1) })
  }
  return calls
}

export function normalizedCodexCalls(payload: Record<string, unknown>): NormalizedCodexCall[] {
  const name = stringAt(payload, 'name') ?? ''
  const input = callInput(payload)
  if (name === 'exec' && typeof input.raw === 'string') return nestedCodexCalls(input.raw)
  const namespace = stringAt(payload, 'namespace')
  const qualifiedName = namespace && name ? `${namespace}__${name}` : name
  const normalized = codexToolName(qualifiedName || stringAt(payload, 'type') || 'unknown', input)
  return normalized ? [normalized] : []
}

export function textContent(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const candidate = row.text ?? row.content
    return typeof candidate === 'string' ? [candidate] : []
  }).join('')
  return text || undefined
}

export function outputText(value: unknown): string | undefined {
  const text = stringsIn(value).join('\n')
  return text || summarize(value)
}

interface IndexedToolOutput {
  output?: string
  failed: boolean
}

export function parsedToolOutput(value: unknown): IndexedToolOutput | undefined {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const exitCode = typeof record.exit_code === 'number'
    ? record.exit_code
    : typeof record.exitCode === 'number'
      ? record.exitCode
      : undefined
  const output = outputText(record.output ?? record.error ?? record.result)
  if (exitCode == null && output == null && record.error == null && record.success == null && record.ok == null) return undefined
  return {
    output,
    failed: (exitCode != null && exitCode !== 0) || record.success === false || record.ok === false || record.error != null
  }
}

export function indexedToolOutputs(value: unknown, count: number): Array<IndexedToolOutput | undefined> {
  const outputs = Array<IndexedToolOutput | undefined>(count)
  for (const candidate of stringsIn(value)) {
    const match = /^(?:RESULT\s+|R)(\d+)\s*\n([\s\S]*)$/i.exec(candidate.trim())
    if (!match) continue
    const index = Number(match[1]) - 1
    if (index >= 0 && index < count) {
      outputs[index] = parsedToolOutput(match[2]) ?? {
        output: match[2],
        failed: outputFailed({}, match[2]) || /^\s*jq:\s+error\b/im.test(match[2])
      }
    }
  }
  if (count === 1 && !outputs[0]) {
    for (const candidate of stringsIn(value).reverse()) {
      const parsed = parsedToolOutput(candidate)
      if (parsed) {
        outputs[0] = parsed
        break
      }
    }
  }
  return outputs
}

export function outputFailed(payload: Record<string, unknown>, output: string | undefined): boolean {
  return payload.error != null ||
    payload.status === 'failed' ||
    (
      /\b(?:Script failed|Script error|tool failed|exit(?: code)?\s*[=:]\s*[1-9]\d*)\b/i.test(output ?? '') ||
      /["']exit_code["']\s*:\s*[1-9]\d*/i.test(output ?? '')
    )
}

export function rejectedBeforeExecution(output: string | undefined): boolean {
  const header = (output ?? '').trimStart().slice(0, 1_024)
  if (/^Script completed\b/i.test(header)) return false
  return /^(?:Script (?:failed|rejected)[\s\S]{0,512}|(?:Error:\s*)?CreateProcess[\s\S]{0,512}Rejected|rejected:[\s\S]{0,512}(?:not permitted|permission|denied))/i.test(header)
}

export function runningCellId(output: string | undefined): string | undefined {
  return /\bScript running with (?:cell|session) ID\s+([A-Za-z0-9_-]+)/i.exec(output ?? '')?.[1]
}

export function skillInjection(text: string | undefined): string | undefined {
  if (!text) return undefined
  return /<skill>\s*<name>([A-Za-z0-9_-]+)<\/name>/i.exec(text)?.[1]
}

export function explicitSkillEvent(name: string, runId: string, at: string): TraceEvent {
  return {
    id: `skill-injection-${stableHash([name, at]).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'skill',
    stage: `skill:${name}`,
    tool: 'Skill',
    name,
    input: { source: 'skill_injection' }
  }
}

export function codexHookEvent(payload: Record<string, unknown>, runId: string, at: string): TraceEvent | null {
  const type = stringAt(payload, 'type')
  // Codex 的 hook 生命周期事件名是 hook_started / hook_completed；hook_response 等是 Claude / Qoder 侧的叫法。
  if (!type || !/^hook_(?:started|progress|response|completed|success|cancelled|additional_context)$/.test(type)) return null
  const completedStatus = stringAt(payload, 'status')
  const outcome = stringAt(payload, 'outcome')
    ?? (type === 'hook_started'
      ? 'started'
      : type === 'hook_progress' || type === 'hook_additional_context'
        ? 'progress'
        : type === 'hook_cancelled'
          ? 'cancelled'
          : type === 'hook_completed' && completedStatus
            ? completedStatus === 'completed' ? 'success' : completedStatus === 'stopped' ? 'cancelled' : 'error'
            : 'success')
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : typeof payload.exitCode === 'number' ? payload.exitCode : undefined
  const hookId = stringAt(payload, 'hook_id', 'hookId', 'tool_use_id', 'toolUseId')
  const hookName = stringAt(payload, 'hook_name', 'hookName', 'name') ?? 'hook'
  const hookEvent = stringAt(payload, 'hook_event', 'hookEvent', 'event') ?? 'Hook'
  return {
    id: `codex-hook-${stableHash([hookId, type, outcome, at]).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'hook',
    stage: type === 'hook_started' ? 'hook_started' : type === 'hook_progress' || type === 'hook_additional_context' ? 'hook_progress' : 'hook_response',
    tool: hookName,
    name: hookEvent,
    hookId,
    hookName,
    hookEvent,
    hookCommand: stringAt(payload, 'command', 'hook_command', 'hookCommand'),
    hookOutcome: outcome,
    hookExitCode: exitCode,
    isError: outcome === 'error' || (exitCode != null && exitCode !== 0)
  }
}
