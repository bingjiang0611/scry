import type { AgentTurnRecord, EvidenceQuality, EvidenceStatus } from '../../shared/turn-record.js'

export interface CompactModelTiming {
  status: EvidenceStatus
  quality: EvidenceQuality
  method: string | null
  cumulativeMs: number | null
  occupiedMs: number | null
  timedCalls: number | null
  totalCalls: number | null
  source: string[]
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function compactModelTiming(record: AgentTurnRecord): CompactModelTiming {
  const evidence = record.modelTiming
  return {
    status: evidence?.status ?? 'unavailable',
    quality: evidence?.quality ?? 'unavailable',
    method: evidence?.value?.method ?? null,
    cumulativeMs: finite(evidence?.value?.cumulativeMs) ? evidence.value.cumulativeMs : null,
    occupiedMs: finite(evidence?.value?.occupiedMs) ? evidence.value.occupiedMs : null,
    timedCalls: finite(evidence?.value?.timedCalls) ? evidence.value.timedCalls : null,
    totalCalls: finite(evidence?.value?.totalCalls) ? evidence.value.totalCalls : null,
    source: evidence?.source ?? []
  }
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function sumKnown(values: Array<number | undefined>): number | null {
  const known = values.filter((value): value is number => finite(value))
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null
}

export function summarizeTurnRecords(records: AgentTurnRecord[], sessionId?: string) {
  const selected = sessionId
    ? records.filter((record) => record.sessionId === sessionId)
    : records
  const qualityCounts: Record<string, number> = {}
  const methodCounts: Record<string, number> = {}
  const statusCounts: Record<string, number> = {}
  const sourceCounts: Record<string, number> = {}
  let knownTurns = 0
  let occupiedKnownTurns = 0
  let observedTimedCalls = 0
  let observedTotalCalls = 0
  let callCoverageTurns = 0

  for (const record of selected) {
    const evidence = record.modelTiming
    increment(statusCounts, evidence?.status ?? 'unavailable')
    increment(qualityCounts, evidence?.quality ?? 'unavailable')
    if (evidence?.value?.method) increment(methodCounts, evidence.value.method)
    for (const source of evidence?.source ?? []) increment(sourceCounts, source)
    if (finite(evidence?.value?.cumulativeMs)) knownTurns++
    if (finite(evidence?.value?.occupiedMs)) occupiedKnownTurns++
    if (
      finite(evidence?.value?.timedCalls) &&
      finite(evidence?.value?.totalCalls)
    ) {
      observedTimedCalls += evidence.value.timedCalls
      observedTotalCalls += evidence.value.totalCalls
      callCoverageTurns++
    }
  }

  return {
    sessionId: sessionId ?? null,
    turns: selected.length,
    wall: {
      cumulativeMs: sumKnown(selected.map((record) => record.durationMs)),
      knownTurns: selected.filter((record) => finite(record.durationMs)).length,
      totalTurns: selected.length
    },
    modelTiming: {
      cumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.cumulativeMs)),
      occupiedMs: sumKnown(selected.map((record) => record.modelTiming?.value?.occupiedMs)),
      rootCumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.root?.cumulativeMs)),
      subagentCumulativeMs: sumKnown(selected.map((record) => record.modelTiming?.value?.subagents?.cumulativeMs)),
      knownTurns,
      occupiedKnownTurns,
      totalTurns: selected.length,
      complete: selected.length > 0 && knownTurns === selected.length && selected.every((record) => record.modelTiming?.status === 'available'),
      responseCallCoverage: callCoverageTurns > 0
        ? { timedCalls: observedTimedCalls, totalCalls: observedTotalCalls, knownTurns: callCoverageTurns }
        : null,
      statusCounts,
      qualityCounts,
      methodCounts,
      sourceCounts
    }
  }
}
