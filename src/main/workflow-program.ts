import { createHash } from 'node:crypto'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type {
  WorkflowBlock,
  WorkflowCallBlock,
  WorkflowCapabilityState,
  WorkflowPlanPreview,
  WorkflowProgram,
  WorkflowRole,
  WorkflowRoleBinding,
  WorkflowRoleCapability,
  WorkflowOutputRef,
  WorkflowValueSchema
} from '../shared/workflow'
import { WORKFLOW_MAX_BATCH, WORKFLOW_MAX_ATTEMPTS, WORKFLOW_SCHEMA_VERSION, providerCapabilityState, workflowChildBlocks } from '../shared/workflow'
import { validateWorkflowValueSchema } from './workflow-values'
import { inferWorkflowExpression, validateWorkflowExpression, workflowBooleanSchema } from './workflow-expressions'
import { workflowExpressionCopy, workflowFrameCopy, workflowValueCopy } from '../shared/constants/copy'
import { normalizeAgentStartRequest, type AgentRunControlCatalog, type AgentStartRequest } from '../shared/runtime'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/
const MAX_GOAL_LENGTH = 16_000
const MAX_PROMPT_LENGTH = 16_000
const MAX_DEPTH = 64
// The collection cap counts logical items, not their container/return nodes.
const MAX_BLOCKS = WORKFLOW_MAX_BATCH * 2 + 2
const MAX_PROGRAM_TEXT = 4 * 1024 * 1024
const ROLES: readonly WorkflowRole[] = ['orchestrator', 'worker', 'reviewer', 'summarizer']

export interface WorkflowCapabilityInput {
  descriptor?: ProviderDescriptor
  runControls?: AgentRunControlCatalog
  adapterRegistered: boolean
  hasIndependentRun: boolean
  canObserveOutput: boolean
  canConfirmStop: boolean
}

export function workflowPlanningPrompt(roles: readonly WorkflowRoleBinding[], goal: string): string {
  // Keep a typed, validator-tested example for every M0 node, including the
  // container field that models otherwise commonly guess as `children`.
  const example: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'parallel', blockId: 'parallel', blocks: [
      { kind: 'call', blockId: 'left', role: 'orchestrator', prompt: 'First task' },
      { kind: 'call', blockId: 'right', role: 'orchestrator', prompt: 'Second task' }
    ] },
    { kind: 'call', blockId: 'combine', role: 'orchestrator', prompt: 'Combine prior evidence', inputRefs: [{ nodeId: 'left' }, { nodeId: 'right' }] },
    { kind: 'return', blockId: 'result', ref: { nodeId: 'combine' } }
  ] }
  return [
    "Only author the plan. Do not perform the user's task, edit files, run checks, launch agents or invoke native Workflow tools while planning.",
    'You are the selected Scry workflow orchestrator. Produce only one JSON object with schemaVersion 1 and body. Allowed nodes are sequence, parallel, call, bind, branch, and exactly one final return. Every node must include kind and a unique blockId.',
    'A sequence is {kind:"sequence",blockId,blocks:[...]}. A parallel is {kind:"parallel",blockId,blocks:[...]}. Both containers use blocks, never children.',
    'A call is {kind:"call",blockId,role,prompt,inputRefs?,outputSchema?}; role must be one of the configured roles. inputRefs reference an earlier committed binding by {nodeId,path?:[field,...]}; path means JSON fields, not a filesystem path. Never reference a parallel sibling or future node.',
    'A bind is {kind:"bind",blockId,value:expression}; it binds its immutable result under blockId. A branch is {kind:"branch",blockId,when:expression,then:block,else:block,unknown:block|"blocked"}. when must be boolean; missing evidence is unknown, never false. Exactly one arm runs; private arm bindings do not escape. The branch binds {arm:"then"|"else"|"unknown",value:chosenOutput}.',
    'Finite expressions: {kind:"literal",value:JSON}, {kind:"ref",name:blockId}, {kind:"field",source:expression,path:[field,...]}, {kind:"compare",operator:"eq"|"ne"|"gt"|"gte"|"lt"|"lte",left:expression,right:expression}, {kind:"and"|"or"|"concat",values:[expression,...]}, {kind:"not"|"count",value:expression}, {kind:"group"|"unique",items:expression,key:[field,...]}, {kind:"filter"|"partition",items:expression,item:localName,when:expression}. No callbacks or user code. group/unique retain all members and original indexes; filter/partition return matched/rejected/unknown entries with indexes, values and reasons, not a flattened list.',
    'Optional outputSchema freezes a finite JSON data contract: {type:"string"|"number"|"boolean"|"null"}, {type:"enum",values:[scalar,...]}, {type:"array",items:schema,maxItems:0..4096}, {type:"object",properties:{field:schema,...},required:[field,...]}, or {type:"union",variants:[schema,...]}. No extra schema keywords or executable validators. Omitted required means all declared fields. Invalid Provider output fails the call, never becomes a successful dependency. Schema depth is at most 16 and total schema nodes at most 256.',
    'The final root return is {kind:"return",blockId,ref:{nodeId:"...",path?:[field,...]}} and must reference one committed binding. No JavaScript, eval, imports, shell execution, map, loops, or unsupported fields. Use literal prompts only; pass prior evidence through inputRefs. Bound data are at most 4 MiB UTF-8 JSON, depth 64 and 4096 collection members; expressions are at most depth 16 and 256 nodes.',
    `Never exceed ${WORKFLOW_MAX_ATTEMPTS} Agent calls. The following example illustrates grammar only; do not copy its tasks or role choices instead of planning the user's goal.`,
    `Grammar example: ${JSON.stringify({ schemaVersion: WORKFLOW_SCHEMA_VERSION, body: example })}`,
    `Configured roles: ${JSON.stringify(roles.map(({ role, providerId, agentProfileId, requestedModel, permissionMode }) => ({ role, providerId, agentProfileId, requestedModel, permissionMode })))}`,
    `Goal:\n${goal}`
  ].join('\n')
}

export function workflowRevision(program: Omit<WorkflowProgram, 'programRevision'>): string {
  const canonical = JSON.stringify(program)
  return createHash('sha256').update(canonical).digest('hex')
}

function assertText(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 无效`)
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} 无效`)
}

function validateRole(value: unknown): asserts value is WorkflowRole {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) throw new Error('工作流角色无效')
}

export function validateWorkflowRoleBinding(value: unknown, index = 0, frozen = false): WorkflowRoleBinding {
  if (!value || typeof value !== 'object') throw new Error(`角色 ${index + 1} 无效`)
  const input = value as Record<string, unknown>
  rejectUnknownFields(input, ['role', 'providerId', 'agentProfileId', 'requestedModel', 'permissionMode', ...(frozen ? ['runtimeIdentity'] : [])])
  if (input.runtimeIdentity !== undefined) assertText(input.runtimeIdentity, '运行身份', 256)
  validateRole(input.role)
  if (typeof input.providerId !== 'string' || !(['claude', 'codex', 'qoder', 'opencode', 'pi'] as string[]).includes(input.providerId)) {
    throw new Error(`角色 ${index + 1} Provider 无效`)
  }
  if (input.agentProfileId !== undefined) {
    assertText(input.agentProfileId, `角色 ${index + 1} profile`, 240)
    // Scry currently exposes independently configured CLI profiles only for Pi.
    // Never label another Provider's default runtime as a requested fake profile.
    if (input.providerId !== 'pi') throw new Error('此 Provider 尚未提供独立配置档，不能忽略请求的 profile')
  }
  if (input.requestedModel !== undefined) {
    if (!input.requestedModel || typeof input.requestedModel !== 'object') throw new Error(`角色 ${index + 1} 模型无效`)
    const model = input.requestedModel as Record<string, unknown>
    rejectUnknownFields(model, ['id', 'providerId'])
    assertText(model.id, `角色 ${index + 1} 模型`, 256)
    if (model.providerId !== undefined) {
      assertText(model.providerId, `角色 ${index + 1} 模型 Provider`, 240)
    }
  }
  if (input.permissionMode !== undefined && !['default', 'auto_accept_edits', 'auto_review', 'full_access'].includes(String(input.permissionMode))) {
    throw new Error(`角色 ${index + 1} 权限模式无效`)
  }
  const normalized = normalizeAgentStartRequest({
    prompt: 'workflow', providerId: input.providerId as ProviderId,
    agentProfileId: input.agentProfileId as string | undefined,
    model: input.requestedModel as AgentStartRequest['model'], permissionMode: input.permissionMode as AgentStartRequest['permissionMode']
  })
  if (input.requestedModel && !normalized.model) throw new Error('工作流模型无效')
  return { role: input.role, providerId: normalized.providerId,
    ...(normalized.agentProfileId ? { agentProfileId: normalized.agentProfileId } : {}),
    ...(normalized.model ? { requestedModel: normalized.model } : {}),
    permissionMode: normalized.permissionMode,
    ...(input.runtimeIdentity ? { runtimeIdentity: input.runtimeIdentity as string } : {}) }
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`程序块字段不受支持：${key}`)
}

function validateRefs(value: unknown, label: string): WorkflowOutputRef[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) throw new Error(`${label} 引用无效`)
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${label} 引用无效`)
    const input = entry as Record<string, unknown>
    rejectUnknownFields(input, ['nodeId', 'path'])
    assertId(input.nodeId, `${label} 引用节点`)
    if (input.path !== undefined && (!Array.isArray(input.path) || input.path.length > 16 || !input.path.every(part => typeof part === 'string' && part.length <= 256))) throw new Error(workflowFrameCopy.invalid)
    return { nodeId: input.nodeId, ...(input.path === undefined ? {} : { path: [...input.path] as string[] }) }
  })
}

function validateBlock(value: unknown, seen: Set<string>, depth: number, count: { value: number; textBytes: number }): WorkflowBlock {
  if (!value || typeof value !== 'object') throw new Error('程序块无效')
  if (depth > MAX_DEPTH) throw new Error('程序嵌套超过上限')
  const input = value as Record<string, unknown>
  const forbidden = ['eval', 'javascript', 'js', 'import', 'shell', 'command', 'path']
  if (forbidden.some((key) => key in input)) throw new Error('程序块包含不允许的宿主执行字段')
  assertId(input.blockId, '程序块 ID')
  if (seen.has(input.blockId)) throw new Error(`程序块 ID 重复：${input.blockId}`)
  seen.add(input.blockId)
  count.value += 1
  if (count.value > MAX_BLOCKS) throw new Error(`程序块数量不能超过 ${MAX_BLOCKS}`)
  if (input.kind === 'call') {
    rejectUnknownFields(input, ['kind', 'blockId', 'role', 'prompt', 'inputRefs', 'outputSchema'])
    validateRole(input.role)
    assertText(input.prompt, 'Agent 调用提示', MAX_PROMPT_LENGTH)
    const outputSchema = input.outputSchema === undefined ? undefined : validateWorkflowValueSchema(input.outputSchema)
    count.textBytes += Buffer.byteLength(input.prompt) + (outputSchema ? Buffer.byteLength(JSON.stringify(outputSchema)) : 0)
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    const inputRefs = input.inputRefs === undefined ? undefined : validateRefs(input.inputRefs, '输入')
    return { kind: 'call', blockId: input.blockId, role: input.role, prompt: input.prompt,
      ...(inputRefs ? { inputRefs } : {}), ...(outputSchema ? { outputSchema } : {}) }
  }
  if (input.kind === 'bind') {
    rejectUnknownFields(input, ['kind', 'blockId', 'value'])
    const expression = validateWorkflowExpression(input.value)
    count.textBytes += Buffer.byteLength(JSON.stringify(expression))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'bind', blockId: input.blockId, value: expression }
  }
  if (input.kind === 'branch') {
    rejectUnknownFields(input, ['kind', 'blockId', 'when', 'then', 'else', 'unknown'])
    if (input.unknown === undefined) throw new Error(workflowFrameCopy.unknownArm)
    const when = validateWorkflowExpression(input.when)
    count.textBytes += Buffer.byteLength(JSON.stringify(when))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'branch', blockId: input.blockId, when,
      then: validateBlock(input.then, seen, depth + 1, count),
      else: validateBlock(input.else, seen, depth + 1, count),
      unknown: input.unknown === 'blocked' ? 'blocked' : validateBlock(input.unknown, seen, depth + 1, count) }
  }
  if (input.kind === 'return') {
    rejectUnknownFields(input, ['kind', 'blockId', 'value', 'ref'])
    const ref = input.ref === undefined ? undefined : validateRefs([input.ref], '返回')[0]
    if (ref === undefined || input.value !== undefined) throw new Error('根 return 必须只引用一个已提交输出')
    return { kind: 'return', blockId: input.blockId, ref }
  }
  if (input.kind === 'sequence' || input.kind === 'parallel') {
    rejectUnknownFields(input, ['kind', 'blockId', 'blocks'])
    if (!Array.isArray(input.blocks) || input.blocks.length === 0) throw new Error(`${input.kind} 必须包含程序块`)
    if (input.blocks.length > WORKFLOW_MAX_BATCH) throw new Error(`批次不能超过 ${WORKFLOW_MAX_BATCH}`)
    return {
      kind: input.kind,
      blockId: input.blockId,
      blocks: input.blocks.map((child) => validateBlock(child, seen, depth + 1, count))
    }
  }
  throw new Error(workflowFrameCopy.unsupportedBlock)
}

function referencedRoles(body: WorkflowBlock, roles = new Set<WorkflowRole>()): Set<WorkflowRole> {
  if (body.kind === 'call') roles.add(body.role)
  else for (const child of workflowChildBlocks(body)) referencedRoles(child, roles)
  return roles
}

function validateReferenceDominance(body: WorkflowBlock): void {
  if (body.kind !== 'sequence' || body.blocks.at(-1)?.kind !== 'return') throw new Error('根 sequence 必须以 return 结束')
  const available = new Map<string, WorkflowValueSchema>()
  let returnCount = 0
  const referenceType = (ref: WorkflowOutputRef, scope: ReadonlyMap<string, WorkflowValueSchema>, label = '输入'): WorkflowValueSchema => {
    if (!scope.has(ref.nodeId)) throw new Error(`${label}引用不是已提交的前置输出：${ref.nodeId}`)
    return inferWorkflowExpression(ref.path?.length ? { kind: 'field', source: { kind: 'ref', name: ref.nodeId }, path: ref.path } : { kind: 'ref', name: ref.nodeId }, scope)
  }
  const bind = (scope: Map<string, WorkflowValueSchema>, name: string, schema: WorkflowValueSchema): WorkflowValueSchema => {
    if (scope.has(name)) throw new Error(workflowExpressionCopy.binding(name))
    scope.set(name, schema)
    return schema
  }
  const visit = (block: WorkflowBlock, scope: Map<string, WorkflowValueSchema>): WorkflowValueSchema => {
    if (block.kind === 'call') {
      for (const ref of block.inputRefs ?? []) referenceType(ref, scope)
      return bind(scope, block.blockId, block.outputSchema ?? { type: 'string' })
    }
    if (block.kind === 'bind') return bind(scope, block.blockId, inferWorkflowExpression(block.value, scope))
    if (block.kind === 'branch') {
      if (!workflowBooleanSchema(inferWorkflowExpression(block.when, scope))) throw new Error(workflowFrameCopy.expectedBoolean)
      const arms: Array<['then' | 'else' | 'unknown', WorkflowBlock]> = [['then', block.then], ['else', block.else]]
      if (block.unknown !== 'blocked') arms.push(['unknown', block.unknown])
      const variants: WorkflowValueSchema[] = arms.map(([arm, child]) => ({
        type: 'object', properties: { arm: { type: 'enum', values: [arm] }, value: visit(child, new Map(scope)) }, required: ['arm', 'value']
      }))
      return bind(scope, block.blockId, { type: 'union', variants })
    }
    if (block.kind === 'return') {
      if (block !== body.blocks.at(-1)) throw new Error('return 只能位于根 sequence 的末尾')
      returnCount++
      return referenceType(block.ref, scope, '返回')
    }
    if (block.kind === 'sequence') {
      let schema: WorkflowValueSchema = { type: 'null' }
      for (const child of block.blocks) schema = visit(child, scope)
      return bind(scope, block.blockId, schema)
    }
    const inherited = new Map(scope)
    const exported = new Map<string, WorkflowValueSchema>()
    const properties: Record<string, WorkflowValueSchema> = Object.create(null) as Record<string, WorkflowValueSchema>
    for (const child of block.blocks) {
      const branchScope = new Map(inherited)
      properties[child.blockId] = visit(child, branchScope)
      for (const [name, schema] of branchScope) if (!inherited.has(name)) {
        if (exported.has(name)) throw new Error(workflowExpressionCopy.binding(name))
        exported.set(name, schema)
      }
    }
    for (const [name, schema] of exported) bind(scope, name, schema)
    return bind(scope, block.blockId, { type: 'object', properties, required: Object.keys(properties) })
  }
  visit(body, available)
  if (returnCount !== 1) throw new Error('工作流程序必须包含且只能包含一个根 return')
}

export function validateWorkflowProgram(input: unknown): WorkflowProgram {
  if (!input || typeof input !== 'object') throw new Error('工作流程序无效')
  const value = input as Record<string, unknown>
  rejectUnknownFields(value, ['schemaVersion', 'workflowId', 'programRevision', 'userGoal', 'workspace', 'roles', 'body'])
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new Error('工作流程序版本不受支持')
  assertId(value.workflowId, 'workflowId')
  assertId(value.programRevision, 'programRevision')
  assertText(value.userGoal, '工作流目标', MAX_GOAL_LENGTH)
  assertText(value.workspace, '工作区', 4096)
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > ROLES.length) throw new Error('工作流角色配置无效')
  const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index, true))
  if (new Set(roles.map((role) => role.role)).size !== roles.length) throw new Error('工作流角色不能重复')
  const seen = new Set<string>()
  const body = validateBlock(value.body, seen, 0, { value: 0, textBytes: 0 })
  validateReferenceDominance(body)
  const configuredRoles = new Set(roles.map((role) => role.role))
  for (const role of referencedRoles(body)) if (!configuredRoles.has(role)) throw new Error(`程序引用了未配置角色：${role}`)
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflowId: value.workflowId, programRevision: value.programRevision,
    userGoal: value.userGoal.trim(), workspace: value.workspace, roles, body }
}

export function capabilityForRole(binding: WorkflowRoleBinding, input: WorkflowCapabilityInput): WorkflowRoleCapability {
  const descriptorState = providerCapabilityState(input.descriptor)
  const states: WorkflowCapabilityState[] = [
    descriptorState,
    input.adapterRegistered && input.hasIndependentRun ? 'available' : 'unavailable',
    input.canObserveOutput ? 'available' : 'unavailable',
    input.canConfirmStop ? 'available' : 'unavailable'
  ]
  const state = states.includes('unavailable') ? 'unavailable' : states.includes('unknown') ? 'unknown' : 'available'
  const reason = state === 'available' ? undefined : !input.adapterRegistered ? 'Provider 未注册 adapter' :
    !input.hasIndependentRun ? 'Provider 不支持独立新会话' : !input.canObserveOutput ? 'Provider 未提供终态与最终输出观测' :
      !input.canConfirmStop ? 'Provider 未提供可确认的停止收敛' : 'Provider 准入状态未知'
  return {
    role: binding.role, providerId: binding.providerId, ...(binding.agentProfileId ? { agentProfileId: binding.agentProfileId } : {}),
    ...(binding.requestedModel ? { requestedModel: binding.requestedModel } : {}),
    actualModelStatus: 'unknown', runtimeProvider: input.descriptor?.runtimeProvider,
    startIndependentSession: states[1], observeTerminalOutput: states[2], confirmStopConvergence: states[3], state, ...(reason ? { reason } : {})
  }
}

export function makePlanPreview(programInput: unknown, capabilities: WorkflowRoleCapability[], orchestrator: WorkflowRoleBinding, observedAt = Date.now()): WorkflowPlanPreview {
  const program = validateWorkflowProgram(programInput)
  const unavailableReasons = capabilities.filter((capability) => capability.state !== 'available')
    .map((capability) => `${capability.role}: ${capability.reason ?? '能力不可用'}`)
  const plannedCalls = workflowCallBudget(program.body)
  if (plannedCalls > WORKFLOW_MAX_ATTEMPTS) unavailableReasons.push(`程序包含 ${plannedCalls} 个 Agent 调用，超过单根 ${WORKFLOW_MAX_ATTEMPTS} 次上限`)
  return {
    workflowId: program.workflowId, programRevision: program.programRevision, userGoal: program.userGoal, workspace: program.workspace,
    orchestrator, roles: capabilities, program, plannedCalls, state: unavailableReasons.length ? 'unavailable' : 'ready', unavailableReasons, observedAt
  }
}

export function workflowCallBudget(block: WorkflowBlock): number {
  if (block.kind === 'call') return 1
  if (block.kind === 'branch') return Math.max(...workflowChildBlocks(block).map(workflowCallBudget))
  return workflowChildBlocks(block).reduce((sum, child) => sum + workflowCallBudget(child), 0)
}

export function callBlocks(block: WorkflowBlock): WorkflowCallBlock[] {
  if (block.kind === 'call') return [block]
  return workflowChildBlocks(block).flatMap(callBlocks)
}
