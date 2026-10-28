import type { WorkflowCheckRequest } from './workflow-check'
import type { WorkflowExpression, WorkflowScalar, WorkflowValue, WorkflowValueSchema } from './workflow'
import type { WorkflowTemplateDefinition } from './workflow-template'
import { WORKFLOW_BATCH_MIGRATION_COPY as copy } from './constants/workflow-batch-migration-copy'

export const batchMigrationTemplateId = '7db2ac7f-b8c7-4dc4-9c94-2f2f3b8e4c01'
export const WORKFLOW_BATCH_MIGRATION_MAX_ITEMS = 200

type BatchMigrationItem = { key: WorkflowScalar; value: WorkflowValue }
export type WorkflowBatchMigrationInput = {
  items: readonly BatchMigrationItem[]
  goal: string
  instruction: string
  check: WorkflowCheckRequest
}

const scalarSchema: WorkflowValueSchema = { type: 'union', variants: [
  { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }
] }
const itemSchema: WorkflowValueSchema = { type: 'object', properties: { key: scalarSchema, payload: { type: 'string' } }, required: ['key', 'payload'] }
const item = (name: string): WorkflowExpression => ({ kind: 'ref', name })
const field = (name: string, path: string[]): WorkflowExpression => ({ kind: 'field', source: item(name), path })
const literal = (value: WorkflowValue): WorkflowExpression => ({ kind: 'literal', value })
const equal = (left: WorkflowExpression, right: WorkflowExpression): WorkflowExpression => ({ kind: 'compare', operator: 'eq', left, right })

function assertText(value: string, label: string): void {
  if (!value.trim() || value.length > 16_000) throw new Error(`${label} 无效`)
}
function assertCheck(check: WorkflowCheckRequest): void {
  if (!Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > 64 || check.argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096 || arg.includes('\0')) ||
    typeof check.cwd !== 'string' || check.cwd.length > 4096 || check.cwd.includes('\0') || check.cwd.split(/[\\/]/).includes('..') || check.cwd.startsWith('/') ||
    !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 2_147_483_647 || !['exit_code', 'typescript', 'node_test'].includes(check.parser)) throw new Error(copy.invalidCheck)
}
function encodeItem(value: BatchMigrationItem): WorkflowValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'key') || !Object.hasOwn(value, 'value')) throw new Error(copy.invalidItems)
  const key = value.key
  if (!(key === null || typeof key === 'string' || typeof key === 'boolean' || (typeof key === 'number' && Number.isFinite(key)))) throw new Error(copy.invalidItems)
  const payload = JSON.stringify(value.value)
  if (payload === undefined || payload.length > 4 * 1024 * 1024) throw new Error(copy.invalidItems)
  return { key, payload }
}

/** Generates only ordinary workflow blocks. Check authorization is intentionally
 * absent; Main freezes the literal check while preparing the project draft. */
export function workflowBatchMigrationTemplate(input: WorkflowBatchMigrationInput): WorkflowTemplateDefinition {
  if (!Array.isArray(input.items) || input.items.length > WORKFLOW_BATCH_MIGRATION_MAX_ITEMS) throw new Error(copy.invalidItems)
  assertText(input.goal, copy.goal); assertText(input.instruction, copy.instruction); assertCheck(input.check)
  const encoded = input.items.map(encodeItem), keys = new Set(encoded.map(value => JSON.stringify((value as { key: WorkflowScalar }).key)))
  if (keys.size !== encoded.length) throw new Error(copy.invalidItems)
  const request = { argv: [...input.check.argv], cwd: input.check.cwd, parser: input.check.parser, timeoutMs: input.check.timeoutMs }
  const accepted = { kind: 'project' as const, items: field('passedRows', ['matched']), item: 'row', value: field('row', ['value', 'value', 'value', 'value']) }
  const row: Extract<WorkflowExpression, { kind: 'project' }> = accepted
  const body: WorkflowTemplateDefinition['body'] = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'base' },
    { kind: 'map', blockId: 'mapped', items: item('items'), item: 'migrationItem', key: ['key'], maxItems: WORKFLOW_BATCH_MIGRATION_MAX_ITEMS,
      body: { kind: 'sequence', blockId: 'migrateOne', blocks: [
        { kind: 'bind', blockId: 'itemInput', value: item('migrationItem'), schema: itemSchema },
        { kind: 'replica', blockId: 'candidate', source: item('base') },
        { kind: 'call', blockId: 'migrate', role: 'worker', prompt: 'Apply the migration instruction to this item in the candidate replica. Do not modify the source workspace. Keep the candidate scoped to this item.', replica: item('candidate'), inputRefs: [{ nodeId: 'goal' }, { nodeId: 'instruction' }, { nodeId: 'itemInput' }] },
        { kind: 'check', blockId: 'itemCheck', replica: item('candidate'), check: request },
        { kind: 'branch', blockId: 'itemDecision', when: equal(field('itemCheck', ['passed']), literal(true)),
          then: { kind: 'bind', blockId: 'accepted', value: item('candidate') },
          else: { kind: 'bind', blockId: 'excluded', value: item('candidate') },
          unknown: 'blocked' }
      ] }
    },
    { kind: 'bind', blockId: 'passedRows', value: { kind: 'filter', items: item('mapped'), item: 'row', when: equal(field('row', ['value', 'arm']), literal('then')) } },
    { kind: 'bind', blockId: 'passedCandidates', value: row },
    { kind: 'collect', blockId: 'acceptedCandidates', items: item('passedCandidates') },
    { kind: 'branch', blockId: 'acceptedDecision', when: { kind: 'compare', operator: 'gt', left: { kind: 'count', value: item('acceptedCandidates') }, right: literal(0) },
      then: { kind: 'sequence', blockId: 'combineAndCheck', blocks: [
        { kind: 'combine', blockId: 'combined', base: item('base'), candidates: item('acceptedCandidates') },
        { kind: 'branch', blockId: 'integrationDecision', when: equal(field('combined', ['state']), literal('combined')),
          then: { kind: 'check', blockId: 'integrationCheck', replica: field('combined', ['integration']), check: request },
          else: { kind: 'bind', blockId: 'conflict', value: item('combined') }, unknown: 'blocked' }
      ] },
      else: { kind: 'bind', blockId: 'noAccepted', value: literal(null) }, unknown: 'blocked' },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'acceptedDecision' } }
  ] }
  return { schemaVersion: 1, templateId: batchMigrationTemplateId, name: copy.title, description: copy.description,
    parameters: {
      items: { schema: { type: 'array', items: itemSchema, maxItems: WORKFLOW_BATCH_MIGRATION_MAX_ITEMS }, default: encoded },
      goal: { schema: { type: 'string' }, default: input.goal },
      instruction: { schema: { type: 'string' }, default: input.instruction }
    }, roles: [{ role: 'worker' }], body }
}
