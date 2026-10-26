import { useCallback, useEffect, useState } from 'react'
import { parseSessionModels, SESSION_MODELS_KEY, type SessionModelSelection } from './integration-derived'

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
