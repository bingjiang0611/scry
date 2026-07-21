import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId, SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'

export interface UsageResultEvent {
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  ts: string
}

export interface UsageStats {
  cost: number | null
  tin: number | null
  tout: number | null
  turns: number
}

export const usageJsonlPath = (userDataDir: string): string => join(userDataDir, 'usage.jsonl')

export function appendUsage(
  userDataDir: string,
  context: {
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    cwd?: string
    externalSessionId?: string
    source?: string
  },
  ev: UsageResultEvent
): void {
  try {
    const row = {
      providerId: context.providerId,
      runtimeProvider: context.runtimeProvider,
      cwd: context.cwd ?? '',
      externalSessionId: context.externalSessionId ?? null,
      source: context.source ?? null,
      cost: ev.costUsd ?? null,
      tin: ev.tokensIn ?? null,
      tout: ev.tokensOut ?? null,
      ts: ev.ts
    }
    appendFileSync(usageJsonlPath(userDataDir), JSON.stringify(row) + '\n')
  } catch {
    /* usage.jsonl is best-effort; sqlite remains the structured source */
  }
}

export function readUsageStats(
  userDataDir: string,
  filter: { providerId?: SessionProviderId; cwd?: string } = {}
): UsageStats {
  let cost = 0
  let tin = 0
  let tout = 0
  let costRows = 0
  let tinRows = 0
  let toutRows = 0
  let turns = 0
  try {
    for (const line of readFileSync(usageJsonlPath(userDataDir), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line) as {
          providerId?: SessionProviderId
          cwd?: string
          cost?: number | null
          tin?: number | null
          tout?: number | null
        }
        const providerId = o.providerId ?? 'legacy_unknown'
        if (filter.providerId && providerId !== filter.providerId) continue
        if (filter.cwd && o.cwd !== filter.cwd) continue
        if (typeof o.cost === 'number') {
          cost += o.cost
          costRows++
        }
        if (typeof o.tin === 'number') {
          tin += o.tin
          tinRows++
        }
        if (typeof o.tout === 'number') {
          tout += o.tout
          toutRows++
        }
        turns++
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* no usage file yet */
  }
  return { cost: costRows ? cost : null, tin: tinRows ? tin : null, tout: toutRows ? tout : null, turns }
}
