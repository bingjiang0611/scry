import { useCallback, useEffect, useState } from 'react'
import type { AgentRunControls } from '@shared/runtime'
import type { TraceEvent } from '@shared/trace'
import { parseStoredRunControls } from './integration-model'

export type SessionModelSelection = Pick<AgentRunControls, 'model' | 'effort'>

export function recordedSessionModel(turns: { items: TraceEvent[] }[]): SessionModelSelection | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex].items
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const event = items[index]
      if (event.kind !== 'harness' || event.stage !== 'runtime:controls') continue
      const controls = parseStoredRunControls(event.input)
      return controls ? { model: controls.model, effort: controls.effort } : undefined
    }
  }
  return undefined
}
export const SESSION_MODELS_KEY = 'scry:session-models:v1'

export function parseSessionModels(raw: string | null): Map<string, SessionModelSelection> {
  if (!raw) return new Map()
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) return new Map()
    return new Map(rows.flatMap((row) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string') return []
      const controls = parseStoredRunControls(row[1])
      return controls ? [[row[0], { model: controls.model, effort: controls.effort }]] : []
    }))
  } catch {
    return new Map()
  }
}

export function useSessionModels() {
  const [sessionModels, setSessionModels] = useState(() => {
    try {
      return parseSessionModels(window.localStorage.getItem(SESSION_MODELS_KEY))
    } catch {
      return new Map<string, SessionModelSelection>()
    }
  })
  const rememberSessionModel = useCallback((key: string, selection: SessionModelSelection): void => {
    setSessionModels((current) => new Map(current).set(key, { model: selection.model, effort: selection.effort }))
  }, [])
  const restoreSessionModel = useCallback((key: string, selection: SessionModelSelection): void => {
    setSessionModels((current) => current.has(key) ? current : new Map(current).set(key, selection))
  }, [])
  const migrateSessionModel = useCallback((fromKey: string, toKey: string): void => {
    setSessionModels((current) => {
      if (fromKey === toKey || !current.has(fromKey)) return current
      const next = new Map(current)
      next.set(toKey, current.get(fromKey)!)
      next.delete(fromKey)
      return next
    })
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify([...sessionModels]))
    } catch {
      // Like run-control preferences, storage failure keeps the live window's selection.
    }
  }, [sessionModels])

  return { sessionModels, rememberSessionModel, restoreSessionModel, migrateSessionModel }
}
