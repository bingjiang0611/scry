import { assertId, assertText, validateRole, rejectUnknownFields, MAX_GOAL_LENGTH, ROLES } from './workflow-program-fields'
import { validateBlock } from './workflow-program-blocks'
import { validateReferenceDominance } from './workflow-program-types'
export { workflowLoopStateTypes } from './workflow-program-types'
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
  WorkflowValueSchema,
  WorkflowSequenceBlock
} from '../shared/workflow'
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_SCHEMA_VERSION, providerCapabilityState, workflowChildBlocks } from '../shared/workflow'
import { workflowSizePlanningAdvice, type WorkflowSizeGuideline } from '../shared/workflow-size'
import { templateInstance } from './workflow-template-identity'
import { workflowCollectionCopy, workflowExpressionCopy } from '../shared/constants/copy'
import { normalizeAgentStartRequest, type AgentRunControlCatalog, type AgentStartRequest } from '../shared/runtime'

export { workflowSystemSourceBody } from '../shared/workflow-source'

export interface WorkflowCapabilityInput {
  descriptor?: ProviderDescriptor
  runControls?: AgentRunControlCatalog
  adapterRegistered: boolean
  hasIndependentRun: boolean
  canObserveOutput: boolean
  canConfirmStop: boolean
}

export function workflowPlanningPrompt(roles: readonly WorkflowRoleBinding[], goal: string, sizeGuideline: WorkflowSizeGuideline = 'medium'): string {
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
    'A verification is {kind:"verification",blockId,required:{key:{check:existingCheckBlockId,result:expression},...},baseline?:expression,protectedPaths?:string[]}. Every required key names an actual check block; results/baseline select same-root main stepId handles, never self-reported pass/fail. Main verifies immutable input versions and command identities. protectedPaths freezes 1-256 non-overlapping relative file/directory paths; main compares complete before/after manifests to the baseline (or first required check), not model claims. This is declared input preservation, not test coverage. Comparison reports check/diagnostic deltas; progress remains unavailable without coverage evidence. It launches no checks or Provider calls itself.',
    "Only author the plan. Do not perform the user's task, edit files, run checks, launch agents or invoke native Workflow tools while planning.",
    'You are the selected Scry workflow orchestrator. Produce only one JSON object with schemaVersion 1 and body. Allowed nodes are sequence, parallel, call, bind, branch, map, collect, loop, replica, combine, check, and exactly one final return. Every node must include kind and a unique blockId.',
    'A sequence is {kind:"sequence",blockId,blocks:[...]}. A parallel is {kind:"parallel",blockId,blocks:[...]}. Both containers use blocks, never children.',
    'A call is {kind:"call",blockId,role,prompt,inputRefs?,outputSchema?}; role must be one of the configured roles. inputRefs reference an earlier committed binding by {nodeId,path?:[field,...]}; path means JSON fields, not a filesystem path. Never reference a parallel sibling or future node.',
    'A replica is {kind:"replica",blockId,source?:replicaExpression}; it creates a main-owned lease-protected copy. A combine is {kind:"combine",blockId,base:replicaExpression,candidates:collectionExpression}; every candidate must descend from the same durable base, and main compares complete manifests/bytes in stable order. It returns typed combined or conflict evidence and never applies to the source workspace. A check may consume a successful combine.integration; failed, rejected, timed-out or unknown checks are not applicable evidence.',
    'A bind is {kind:"bind",blockId,value:expression}; it binds its immutable result under blockId. A branch is {kind:"branch",blockId,when:expression,then:block,else:block,unknown:block|"blocked"}. when must be boolean; missing evidence is unknown, never false. Exactly one arm runs; private arm bindings do not escape. The branch binds {arm:"then"|"else"|"unknown",value:chosenOutput}.',
    'A map is {kind:"map",blockId,items:expression,item:localName,key:[field,...],maxItems:0..4096,body:block}. It evaluates a real collection dynamically; do not unroll it. Validate the complete input bound and unique scalar keys before dispatch. maxItems is a visible whole-batch refusal boundary, never truncation. Worst-case calls are maxItems times body calls. Source collection references must retain key:["key"]. A collect is {kind:"collect",blockId,items:expression}; it reads a sealed host collection into bounded outcome rows with key/index/state/settled/value?/error?, retaining failed slots. Explicit collect is required to consume a known settled failed map summary; unknown never advances.',
    'A loop is {kind:"loop",blockId,initial:{name:expression,...},stateSchema:{name:schema|"inferred",...},invariants:{name:expression,...},iteration?:localName,best?:stateName,outcome:outputName,maxIterations:1..1000,body:block,until:booleanExpression,carry:{name:expression,...},result:expression,progress:"bounded_only"|{baseline:expression,key:expression,improved:booleanExpression},policy:{error:"fail_closed",unknown:"block",stop:"cancel",logicalExit:"report_partial"}}. initial and carry must have identical state keys. Nonempty invariants bind once; state is immutable inside each round. result reads only committed state/invariants, not private body bindings. Native/contract errors or unknown do not create another iteration. Logical exhaustion/no-progress/oscillation permit the approved partial report but never make the root successful. best names a preserved state reference, not independent quality proof. Compare actual diagnosis/rubric content, never per-round artifact IDs. Loop calls are maxIterations times body calls; budgets never reset.',
    'Finite expressions: {kind:"literal",value:JSON}, {kind:"ref",name:blockId}, {kind:"field",source:expression,path:[field,...]}, {kind:"compare",operator:"eq"|"ne"|"gt"|"gte"|"lt"|"lte",left:expression,right:expression}, {kind:"and"|"or"|"concat",values:[expression,...]}, {kind:"not"|"count",value:expression}, {kind:"group"|"unique",items:expression,key:[field,...]}, {kind:"filter"|"partition",items:expression,item:localName,when:expression}. No callbacks or user code. group/unique retain all members and original indexes; filter/partition return matched/rejected/unknown entries with indexes, values and reasons, not a flattened list.',
    'Optional outputSchema freezes a finite JSON data contract: {type:"string"|"number"|"boolean"|"null"}, {type:"enum",values:[scalar,...]}, {type:"array",items:schema,maxItems:0..4096}, {type:"object",properties:{field:schema,...},required:[field,...]}, or {type:"union",variants:[schema,...]}. No extra schema keywords or executable validators. Omitted required means all declared fields. Invalid Provider output fails the call, never becomes a successful dependency. Schema depth is at most 16 and total schema nodes at most 256.',
    'The final root return is {kind:"return",blockId,ref:{nodeId:"...",path?:[field,...]}} and must reference one committed binding. No JavaScript, eval, imports, shell execution, unbounded loops, or unsupported fields. Use literal prompts only; pass prior evidence through inputRefs. Bound data are at most 4 MiB UTF-8 JSON, depth 64 and 4096 collection members; expressions are at most depth 16 and 256 nodes.',
    `Never exceed ${WORKFLOW_MAX_ATTEMPTS} Agent calls. The following example illustrates grammar only; do not copy its tasks or role choices instead of planning the user's goal.`,
    `Grammar example: ${JSON.stringify({ schemaVersion: WORKFLOW_SCHEMA_VERSION, body: example })}`,
    ...workflowSizePlanningAdvice(sizeGuideline),
    `Configured roles: ${JSON.stringify(roles.map(({ role, providerId, agentProfileId, requestedModel, permissionMode }) => ({ role, providerId, agentProfileId, requestedModel, permissionMode })))}`,
    `Goal:\n${goal}`
  ].join('\n')
}

export function workflowRevision(program: Omit<WorkflowProgram, 'programRevision'>): string {
  const canonical = JSON.stringify(program)
  return createHash('sha256').update(canonical).digest('hex')
}

export function validateWorkflowRolePreference(value: unknown, index = 0): Pick<WorkflowRoleBinding, 'role' | 'providerId' | 'requestedModel'> {
  if (!value || typeof value !== 'object') throw new Error(`角色 ${index + 1} 无效`)
  const input = value as Record<string, unknown>
  rejectUnknownFields(input, ['role', 'providerId', 'requestedModel'])
  validateRole(input.role)
  if (typeof input.providerId !== 'string' || !(['claude', 'codex', 'qoder', 'opencode', 'pi'] as string[]).includes(input.providerId)) throw new Error(`角色 ${index + 1} Provider 无效`)
  if (input.requestedModel !== undefined) {
    if (!input.requestedModel || typeof input.requestedModel !== 'object') throw new Error(`角色 ${index + 1} 模型无效`)
    const model = input.requestedModel as Record<string, unknown>
    rejectUnknownFields(model, ['id', 'providerId'])
    assertText(model.id, `角色 ${index + 1} 模型`, 256)
    if (model.providerId !== undefined) assertText(model.providerId, `角色 ${index + 1} 模型 Provider`, 240)
  }
  return { role: input.role, providerId: input.providerId as ProviderId, ...(input.requestedModel ? { requestedModel: structuredClone(input.requestedModel) as WorkflowRoleBinding['requestedModel'] } : {}) }
}

export function validateWorkflowRoleBinding(value: unknown, index = 0, frozen = false): WorkflowRoleBinding {
  if (!value || typeof value !== 'object') throw new Error(`角色 ${index + 1} 无效`)
  const input = value as Record<string, unknown>
  rejectUnknownFields(input, ['role', 'providerId', 'agentProfileId', 'requestedModel', 'permissionMode', ...(frozen ? ['runtimeIdentity'] : [])])
  if (input.runtimeIdentity !== undefined) assertText(input.runtimeIdentity, '运行身份', 256)
  const preference = validateWorkflowRolePreference({ role: input.role, providerId: input.providerId, ...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }) }, index)
  if (input.agentProfileId !== undefined) {
    assertText(input.agentProfileId, `角色 ${index + 1} profile`, 240)
    // Scry currently exposes independently configured CLI profiles only for Pi.
    // Never label another Provider's default runtime as a requested fake profile.
    if (input.providerId !== 'pi') throw new Error('此 Provider 尚未提供独立配置档，不能忽略请求的 profile')
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
  return { role: preference.role, providerId: normalized.providerId,
    ...(normalized.agentProfileId ? { agentProfileId: normalized.agentProfileId } : {}),
    ...(normalized.model ? { requestedModel: normalized.model } : {}),
    permissionMode: normalized.permissionMode,
    ...(input.runtimeIdentity ? { runtimeIdentity: input.runtimeIdentity as string } : {}) }
}

function referencedRoles(body: WorkflowBlock, roles = new Set<WorkflowRole>()): Set<WorkflowRole> {
  if (body.kind === 'call') roles.add(body.role)
  else for (const child of workflowChildBlocks(body)) referencedRoles(child, roles)
  return roles
}

export { ROLES as WORKFLOW_ROLES }

/** Definition validation shares the runtime compiler, without inventing Provider bindings or input values. */
export function validateWorkflowBody(input: unknown, roles: ReadonlySet<WorkflowRole>, inputs: ReadonlyMap<string, WorkflowValueSchema> = new Map()): WorkflowSequenceBlock {
  const body = validateBlock(input, new Set(inputs.keys()), 0, { value: 0, textBytes: 0 })
  validateReferenceDominance(body, inputs)
  for (const role of referencedRoles(body)) if (!roles.has(role)) throw new Error(workflowExpressionCopy.role(role))
  // validateReferenceDominance establishes the root sequence/return contract.
  return body as WorkflowSequenceBlock
}

export function validateWorkflowProgram(input: unknown): WorkflowProgram {
  if (!input || typeof input !== 'object') throw new Error('工作流程序无效')
  const value = input as Record<string, unknown>
  rejectUnknownFields(value, ['schemaVersion', 'workflowId', 'programRevision', 'userGoal', 'workspace', 'roles', 'body', 'template'])
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new Error('工作流程序版本不受支持')
  assertId(value.workflowId, 'workflowId')
  assertId(value.programRevision, 'programRevision')
  assertText(value.userGoal, '工作流目标', MAX_GOAL_LENGTH)
  assertText(value.workspace, '工作区', 4096)
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > ROLES.length) throw new Error('工作流角色配置无效')
  const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index, true))
  if (new Set(roles.map((role) => role.role)).size !== roles.length) throw new Error('工作流角色不能重复')
  const body = validateWorkflowBody(value.body, new Set(roles.map(role => role.role)))
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflowId: value.workflowId, programRevision: value.programRevision,
    userGoal: value.userGoal.trim(), workspace: value.workspace, roles, body,
    ...(value.template === undefined ? {} : { template: templateInstance(value.template) }) }
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
  let budget: number
  if (block.kind === 'call') budget = 1
  else if (block.kind === 'loop') budget = block.maxIterations * workflowCallBudget(block.body)
  else if (block.kind === 'map') budget = block.maxItems === 0 ? 0 : block.maxItems * workflowCallBudget(block.body)
  else if (block.kind === 'branch') budget = Math.max(...workflowChildBlocks(block).map(workflowCallBudget))
  else budget = workflowChildBlocks(block).reduce((sum, child) => sum + workflowCallBudget(child), 0)
  if (!Number.isSafeInteger(budget)) throw new Error(workflowCollectionCopy.budget)
  return budget
}

export function callBlocks(block: WorkflowBlock): WorkflowCallBlock[] {
  if (block.kind === 'call') return [block]
  return workflowChildBlocks(block).flatMap(callBlocks)
}
