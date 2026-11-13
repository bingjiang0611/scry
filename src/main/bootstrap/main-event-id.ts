import { randomUUID } from 'node:crypto'

export const mainEventId = (prefix: string, runId: string): string => `${prefix}-${runId}-${randomUUID()}`
