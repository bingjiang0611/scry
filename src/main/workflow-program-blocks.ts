import { validateWorkflowProtectedPaths } from './workflow-verification-surface'
import { WORKFLOW_MAX_REQUIRED_CHECKS } from '../shared/workflow-verification'
import { WORKFLOW_MAX_BATCH, type WorkflowBlock, type WorkflowOutputRef, type WorkflowParallelFailurePolicy } from '../shared/workflow'
import type { WorkflowClassifierKind } from '../shared/workflow-classifier'
import { workflowCollectionCopy, workflowFrameCopy, workflowValueCopy } from '../shared/constants/copy'
import { validateWorkflowCheck, validateWorkflowFrozenCheck } from './workflow-check'
import { validateWorkflowValueSchema } from './workflow-values'
import { validateWorkflowExpression } from './workflow-expressions'
import { validateWorkflowLoop } from './workflow-loops'
import { assertId, assertText, validateRole, rejectUnknownFields, MAX_BLOCKS, MAX_DEPTH, MAX_PROGRAM_TEXT, MAX_PROMPT_LENGTH } from './workflow-program-fields'

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

export function validateBlock(value: unknown, seen: Set<string>, depth: number, count: { value: number; textBytes: number }): WorkflowBlock {
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
  if (input.kind === 'classifier') {
    rejectUnknownFields(input, ['kind', 'blockId', 'classifierId', 'classifier', 'prompt', 'criteria', 'model', 'threshold', 'choices', 'score', 'inputRefs'])
    assertId(input.classifierId, '分类器 ID')
    if (!['bool', 'choice', 'score'].includes(input.classifier as string)) throw new Error('分类器类型无效')
    assertText(input.prompt, '分类器提示', MAX_PROMPT_LENGTH)
    assertText(input.criteria, '分类器判据', MAX_PROMPT_LENGTH)
    if (input.model !== undefined) assertText(input.model, '分类器模型', 512)
    const threshold = input.threshold === undefined ? undefined : (() => {
      if (!input.threshold || typeof input.threshold !== 'object' || Array.isArray(input.threshold)) throw new Error('分类器阈值无效')
      const value = input.threshold as Record<string, unknown>
      rejectUnknownFields(value, ['min', 'max'])
      for (const key of ['min', 'max']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) throw new Error('分类器阈值无效')
      const min = typeof value.min === 'number' ? value.min : undefined
      const max = typeof value.max === 'number' ? value.max : undefined
      if (min !== undefined && max !== undefined && min > max) throw new Error('分类器阈值无效')
      return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
    })()
    const choices = input.choices === undefined ? undefined : (() => {
      if (input.classifier !== 'choice' || !Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 256 || !input.choices.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) throw new Error('分类器选项无效')
      return [...new Set(input.choices)]
    })()
    const score = input.score === undefined ? undefined : (() => {
      if (input.classifier !== 'score' || !input.score || typeof input.score !== 'object' || Array.isArray(input.score)) throw new Error('分类器分数范围无效')
      const value = input.score as Record<string, unknown>
      if (typeof value.min !== 'number' || typeof value.max !== 'number' || !Number.isFinite(value.min) || !Number.isFinite(value.max) || value.min > value.max) throw new Error('分类器分数范围无效')
      return { min: value.min, max: value.max }
    })()
    if (input.classifier === 'choice' && !choices || input.classifier === 'score' && !score || input.classifier === 'bool' && (choices || score)) throw new Error('分类器合同无效')
    const inputRefs = input.inputRefs === undefined ? undefined : validateRefs(input.inputRefs, '分类器输入')
    count.textBytes += Buffer.byteLength(JSON.stringify({ prompt: input.prompt, criteria: input.criteria, model: input.model, threshold, choices, score, inputRefs }))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'classifier', blockId: input.blockId, classifierId: input.classifierId, classifier: input.classifier as WorkflowClassifierKind,
      prompt: input.prompt, criteria: input.criteria, ...(input.model === undefined ? {} : { model: input.model }), ...(threshold ? { threshold } : {}), ...(choices ? { choices } : {}), ...(score ? { score } : {}), ...(inputRefs ? { inputRefs } : {}) }
  }
  if (input.kind === 'call') {
    rejectUnknownFields(input, ['kind', 'blockId', 'role', 'prompt', 'inputRefs', 'outputSchema', 'replica'])
    validateRole(input.role)
    assertText(input.prompt, 'Agent 调用提示', MAX_PROMPT_LENGTH)
    const outputSchema = input.outputSchema === undefined ? undefined : validateWorkflowValueSchema(input.outputSchema)
    const replica = input.replica === undefined ? undefined : validateWorkflowExpression(input.replica)
    count.textBytes += Buffer.byteLength(JSON.stringify(replica) ?? '') + Buffer.byteLength(input.prompt) + (outputSchema ? Buffer.byteLength(JSON.stringify(outputSchema)) : 0)
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    const inputRefs = input.inputRefs === undefined ? undefined : validateRefs(input.inputRefs, '输入')
    return { kind: 'call', blockId: input.blockId, role: input.role, prompt: input.prompt,
      ...(inputRefs ? { inputRefs } : {}), ...(replica ? { replica } : {}), ...(outputSchema ? { outputSchema } : {}) }
  }
  if (input.kind === 'verification') {
    rejectUnknownFields(input, ['kind', 'blockId', 'required', 'baseline', 'protectedPaths'])
    if (!input.required || typeof input.required !== 'object' || Array.isArray(input.required)) throw new Error(workflowValueCopy.bindingContract)
    const entries = Object.entries(input.required)
    if (!entries.length || entries.length > WORKFLOW_MAX_REQUIRED_CHECKS) throw new Error(workflowValueCopy.bindingContract)
    const required = Object.fromEntries(entries.map(([key, raw]) => {
      assertId(key, 'verification key')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(workflowValueCopy.bindingContract)
      const entry = raw as Record<string, unknown>
      rejectUnknownFields(entry, ['check', 'result'])
      assertId(entry.check, 'check')
      return [key, { check: entry.check, result: validateWorkflowExpression(entry.result) }]
    }))
    const baseline = input.baseline === undefined ? undefined : validateWorkflowExpression(input.baseline)
    const protectedPaths = input.protectedPaths === undefined ? undefined : validateWorkflowProtectedPaths(input.protectedPaths)
    count.textBytes += Buffer.byteLength(JSON.stringify({ required, baseline, protectedPaths }))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'verification', blockId: input.blockId, required, ...(baseline ? { baseline } : {}), ...(protectedPaths ? { protectedPaths } : {}) }
  }
  if (input.kind === 'combine') {
    rejectUnknownFields(input, ['kind', 'blockId', 'base', 'candidates'])
    const base = validateWorkflowExpression(input.base), candidates = validateWorkflowExpression(input.candidates)
    count.textBytes += Buffer.byteLength(JSON.stringify({ base, candidates }))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'combine', blockId: input.blockId, base, candidates }
  }
  if (input.kind === 'replica' || input.kind === 'check') {
    rejectUnknownFields(input, input.kind === 'replica' ? ['kind', 'blockId', 'source'] : ['kind', 'blockId', 'replica', 'check', 'authorization'])
    const expression = input.kind === 'replica' ? input.source === undefined ? undefined : validateWorkflowExpression(input.source) : validateWorkflowExpression(input.replica)
    count.textBytes += Buffer.byteLength(JSON.stringify(expression) ?? '')
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    if (input.kind === 'replica') return { kind: 'replica', blockId: input.blockId, ...(expression ? { source: expression } : {}) }
    const check = validateWorkflowCheck(input.check), authorization = input.authorization === undefined ? undefined : validateWorkflowFrozenCheck(input.authorization)
    if (authorization && JSON.stringify(check) !== JSON.stringify(validateWorkflowCheck({ argv: authorization.argv, cwd: authorization.cwd, timeoutMs: authorization.timeoutMs, parser: authorization.parser }))) throw new Error(workflowValueCopy.bindingContract)
    count.textBytes += Buffer.byteLength(JSON.stringify({ check, authorization }))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'check', blockId: input.blockId, replica: expression!, check, ...(authorization ? { authorization } : {}) }
  }
  if (input.kind === 'bind') {
    rejectUnknownFields(input, ['kind', 'blockId', 'value', 'schema'])
    const expression = validateWorkflowExpression(input.value)
    const schema = input.schema === undefined ? undefined : validateWorkflowValueSchema(input.schema)
    count.textBytes += Buffer.byteLength(JSON.stringify(expression)) + (schema ? Buffer.byteLength(JSON.stringify(schema)) : 0)
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { kind: 'bind', blockId: input.blockId, value: expression, ...(schema ? { schema } : {}) }
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
  if (input.kind === 'loop') {
    rejectUnknownFields(input, ['kind', 'blockId', 'initial', 'stateSchema', 'invariants', 'iteration', 'best', 'outcome', 'maxIterations', 'body', 'until', 'carry', 'result', 'progress', 'policy'])
    const loop = validateWorkflowLoop(input)
    count.textBytes += Buffer.byteLength(JSON.stringify(loop))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    return { ...loop, body: validateBlock(input.body, seen, depth + 1, count) }
  }
  if (input.kind === 'map' || input.kind === 'collect') {
    rejectUnknownFields(input, input.kind === 'map' ? ['kind', 'blockId', 'items', 'item', 'key', 'maxItems', 'body'] : ['kind', 'blockId', 'items'])
    const items = validateWorkflowExpression(input.items)
    count.textBytes += Buffer.byteLength(JSON.stringify(items))
    if (count.textBytes > MAX_PROGRAM_TEXT) throw new Error(workflowValueCopy.programLimit)
    if (input.kind === 'collect') return { kind: 'collect', blockId: input.blockId, items }
    assertId(input.item, 'map item')
    if (!Array.isArray(input.key) || input.key.length > 16 || !input.key.every(part => typeof part === 'string' && part.length <= 256)) throw new Error(workflowCollectionCopy.key)
    const maxItems = input.maxItems ?? WORKFLOW_MAX_BATCH
    if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > WORKFLOW_MAX_BATCH) throw new Error(workflowCollectionCopy.limit)
    return { kind: 'map', blockId: input.blockId, items, item: input.item, key: [...input.key] as string[], maxItems, body: validateBlock(input.body, seen, depth + 1, count) }
  }
  if (input.kind === 'return') {
    rejectUnknownFields(input, ['kind', 'blockId', 'value', 'ref'])
    const ref = input.ref === undefined ? undefined : validateRefs([input.ref], '返回')[0]
    if (ref === undefined || input.value !== undefined) throw new Error('根 return 必须只引用一个已提交输出')
    return { kind: 'return', blockId: input.blockId, ref }
  }
  if (input.kind === 'sequence' || input.kind === 'parallel') {
    rejectUnknownFields(input, input.kind === 'parallel' ? ['kind', 'blockId', 'blocks', 'failurePolicy'] : ['kind', 'blockId', 'blocks'])
    if (!Array.isArray(input.blocks) || input.blocks.length === 0) throw new Error(`${input.kind} 必须包含程序块`)
    if (input.blocks.length > WORKFLOW_MAX_BATCH) throw new Error(`批次不能超过 ${WORKFLOW_MAX_BATCH}`)
    if (input.kind === 'parallel' && input.failurePolicy !== undefined && input.failurePolicy !== 'all_settled' && input.failurePolicy !== 'fail_fast') throw new Error(workflowFrameCopy.invalid)
    const blocks = input.blocks.map((child) => validateBlock(child, seen, depth + 1, count))
    if (input.kind === 'parallel') return { kind: 'parallel', blockId: input.blockId, blocks, ...(input.failurePolicy === undefined ? {} : { failurePolicy: input.failurePolicy as WorkflowParallelFailurePolicy }) }
    return { kind: 'sequence', blockId: input.blockId, blocks }
  }
  throw new Error(workflowFrameCopy.unsupportedBlock)
}
