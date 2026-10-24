import { WORKFLOW_MAX_BATCH, type WorkflowRole } from '../shared/workflow'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/
export const MAX_GOAL_LENGTH = 16_000
export const MAX_PROMPT_LENGTH = 16_000
export const MAX_DEPTH = 64
// The collection cap counts logical items, not their container/return nodes.
export const MAX_BLOCKS = WORKFLOW_MAX_BATCH * 2 + 2
export const MAX_PROGRAM_TEXT = 4 * 1024 * 1024
export const ROLES: readonly WorkflowRole[] = ['orchestrator', 'worker', 'reviewer', 'summarizer']

export function assertText(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 无效`)
}

export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} 无效`)
}

export function validateRole(value: unknown): asserts value is WorkflowRole {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) throw new Error('工作流角色无效')
}

export function rejectUnknownFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`程序块字段不受支持：${key}`)
}
