import { workflowVerificationValueSchema } from '../shared/workflow-verification'
import { WORKFLOW_MAX_BATCH, workflowChildBlocks, type WorkflowBlock, type WorkflowOutputRef, type WorkflowValueSchema } from '../shared/workflow'
import { workflowCheckValueSchema, workflowCombineValueSchema, workflowReplicaValueSchema } from '../shared/workflow-system'
import { workflowCollectionCopy, workflowExpressionCopy, workflowFrameCopy, workflowLoopCopy, workflowValueCopy } from '../shared/constants/copy'
import { workflowSchemaAssignable } from './workflow-values'
import { workflowLoopOutcomeSchema } from './workflow-loops'
import { collectionItemSchema } from './workflow-collections'
import { inferWorkflowExpression, workflowBooleanSchema, workflowItemsSchema, workflowScalarSchema } from './workflow-expressions'

const loopStateTypes = new WeakMap<WorkflowBlock, Map<string, Record<string, WorkflowValueSchema>>>()

export function validateReferenceDominance(body: WorkflowBlock, inputs: ReadonlyMap<string, WorkflowValueSchema> = new Map()): Map<string, Record<string, WorkflowValueSchema>> {
  if (body.kind !== 'sequence' || body.blocks.at(-1)?.kind !== 'return') throw new Error('根 sequence 必须以 return 结束')
  let nodes: Map<string, WorkflowBlock> | undefined
  const available = new Map(inputs)
  const resolvedLoops = new Map<string, Record<string, WorkflowValueSchema>>()
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
      if (block.replica && !workflowSchemaAssignable(inferWorkflowExpression(block.replica, scope), workflowReplicaValueSchema)) throw new Error(workflowValueCopy.bindingContract)
      return bind(scope, block.blockId, block.outputSchema ?? { type: 'string' })
    }
    if (block.kind === 'verification') {
      if (!nodes) {
        nodes = new Map()
        const pending: WorkflowBlock[] = [body]
        while (pending.length) { const node = pending.pop()!; nodes.set(node.blockId, node); pending.push(...workflowChildBlocks(node)) }
      }
      for (const entry of Object.values(block.required)) {
        if (nodes.get(entry.check)?.kind !== 'check') throw new Error(workflowValueCopy.bindingContract)
        inferWorkflowExpression(entry.result, scope)
      }
      if (block.baseline) inferWorkflowExpression(block.baseline, scope)
      return bind(scope, block.blockId, workflowVerificationValueSchema)
    }
    if (block.kind === 'replica' || block.kind === 'check') {
      const expression = block.kind === 'replica' ? block.source : block.replica
      if (expression) {
        const actual = inferWorkflowExpression(expression, scope)
        const nullableReplica = actual.type === 'union' && actual.variants.some(variant => workflowSchemaAssignable(variant, workflowReplicaValueSchema))
        if (!workflowSchemaAssignable(actual, workflowReplicaValueSchema) && !(block.kind === 'check' && nullableReplica)) throw new Error(workflowValueCopy.bindingContract)
      }
      return bind(scope, block.blockId, block.kind === 'replica' ? workflowReplicaValueSchema : workflowCheckValueSchema)
    }
    if (block.kind === 'combine') {
      if (!workflowSchemaAssignable(inferWorkflowExpression(block.base, scope), workflowReplicaValueSchema)) throw new Error(workflowValueCopy.bindingContract)
      const candidates = inferWorkflowExpression(block.candidates, scope)
      if ((candidates.type !== 'array' && candidates.type !== 'collection') ||
        !workflowSchemaAssignable(candidates.items, workflowReplicaValueSchema) && !workflowSchemaAssignable(candidates.items, collectionItemSchema(workflowReplicaValueSchema))) throw new Error(workflowValueCopy.bindingContract)
      return bind(scope, block.blockId, workflowCombineValueSchema)
    }
    if (block.kind === 'bind') {
      const actual = inferWorkflowExpression(block.value, scope)
      if (block.schema && !workflowSchemaAssignable(actual, block.schema)) throw new Error(workflowValueCopy.bindingContract)
      return bind(scope, block.blockId, block.schema ?? actual)
    }
    if (block.kind === 'loop') {
      const invariantScope = new Map(scope)
      for (const [name, expression] of Object.entries(block.invariants)) bind(invariantScope, name, inferWorkflowExpression(expression, scope))
      const stateScope = new Map(invariantScope)
      for (const [name, expression] of Object.entries(block.initial)) {
        const actual = inferWorkflowExpression(expression, invariantScope)
        const expected = block.stateSchema[name] === 'inferred' ? actual : block.stateSchema[name] as WorkflowValueSchema
        if (!workflowSchemaAssignable(actual, expected)) throw new Error(workflowLoopCopy.schema)
        bind(stateScope, name, expected)
      }
      resolvedLoops.set(block.blockId, Object.fromEntries(Object.keys(block.initial).map(name => [name, stateScope.get(name)!])))
      if (block.iteration) bind(stateScope, block.iteration, { type: 'number' })
      const bodyScope = new Map(stateScope)
      visit(block.body, bodyScope)
      if (!workflowBooleanSchema(inferWorkflowExpression(block.until, bodyScope))) throw new Error(workflowLoopCopy.condition)
      for (const [name, expression] of Object.entries(block.carry)) if (!workflowSchemaAssignable(inferWorkflowExpression(expression, bodyScope), stateScope.get(name)!)) throw new Error(workflowLoopCopy.schema)
      if (block.progress !== 'bounded_only') {
        if (inferWorkflowExpression(block.progress.baseline, stateScope).type === 'collection' || inferWorkflowExpression(block.progress.key, bodyScope).type === 'collection') throw new Error(workflowLoopCopy.progress)
        if (!workflowBooleanSchema(inferWorkflowExpression(block.progress.improved, bodyScope))) throw new Error(workflowLoopCopy.condition)
      }
      const result = inferWorkflowExpression(block.result, stateScope)
      bind(scope, block.outcome, workflowLoopOutcomeSchema)
      return bind(scope, block.blockId, result)
    }
    if (block.kind === 'map' || block.kind === 'collect') {
      const source = inferWorkflowExpression(block.items, scope)
      if (block.kind === 'collect') {
        if (source.type !== 'collection') throw new Error(workflowCollectionCopy.source)
        return bind(scope, block.blockId, { type: 'array', items: source.items, maxItems: WORKFLOW_MAX_BATCH })
      }
      if (scope.has(block.item)) throw new Error(workflowExpressionCopy.binding(block.item))
      const itemSchema = workflowItemsSchema(source)
      if (source.type === 'collection' && (block.key.length !== 1 || block.key[0] !== 'key')) throw new Error(workflowCollectionCopy.collectionKey)
      const local = new Map(scope).set(block.item, itemSchema)
      const keySchema = inferWorkflowExpression({ kind: 'field', source: { kind: 'ref', name: block.item }, path: block.key }, local)
      if (!workflowScalarSchema(keySchema)) throw new Error(workflowCollectionCopy.key)
      return bind(scope, block.blockId, { type: 'collection', items: collectionItemSchema(visit(block.body, local)) })
    }
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
  loopStateTypes.set(body, resolvedLoops)
  return resolvedLoops
}

export function workflowLoopStateTypes(body: WorkflowBlock, nodeId: string): Record<string, WorkflowValueSchema> {
  const types = (loopStateTypes.get(body) ?? validateReferenceDominance(body)).get(nodeId)
  if (!types) throw new Error(workflowLoopCopy.schema)
  return types
}
