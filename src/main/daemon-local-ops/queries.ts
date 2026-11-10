import type { DaemonForwardTable, DaemonLocalOpTable } from './types'

// Read-only queries: usage, LLM performance, git diff, recorder content, skills, commands.
export const QUERY_LOCAL_OPS: DaemonLocalOpTable = {}

export const QUERY_FORWARDS: DaemonForwardTable = {}
