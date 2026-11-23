import { useCallback, useEffect, useState } from 'react'
import type { DelegationStateSnapshot } from '@shared/delegation'

const EMPTY_STATE: DelegationStateSnapshot = {
  projectDelegationEnabled: false,
  sessionFullAccessEnabled: false,
  tasks: [],
  usageBreakdown: { status: 'available', unavailableCount: 0, tokens: {}, usd: {}, credits: {} }
}

export function useDelegationState(cwd: string | null | undefined, parentSessionKey: string | null | undefined) {
  const [state, setState] = useState<DelegationStateSnapshot>(EMPTY_STATE)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const api = window.scry?.delegation
    if (!api || (!cwd && !parentSessionKey)) {
      setState(EMPTY_STATE)
      return
    }
    try {
      const next = await api.getState({ cwd: cwd ?? null, parentSessionKey: parentSessionKey ?? null })
      setState(next)
    } catch {
      // Daemon unavailable or disconnected; keep last known snapshot.
    }
  }, [cwd, parentSessionKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!window.scry?.onDataUpdated) return
    return window.scry.onDataUpdated(() => {
      void refresh()
    })
  }, [refresh])

  const toggleProject = useCallback(async (next: boolean) => {
    if (!cwd || !window.scry?.delegation) return
    setBusy(true)
    try {
      await window.scry.delegation.setProjectPolicy({ cwd, enabled: next })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [cwd, refresh])

  const toggleSessionFullAccess = useCallback(async (next: boolean) => {
    if (!parentSessionKey || !window.scry?.delegation) return
    setBusy(true)
    try {
      await window.scry.delegation.setSessionFullAccess({ sessionKey: parentSessionKey, enabled: next })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [parentSessionKey, refresh])

  const confirmTask = useCallback(async (taskId: string, questionId: string, approved: boolean) => {
    if (!window.scry?.delegation) return
    setBusy(true)
    try {
      await window.scry.delegation.confirmTask({ taskId, questionId, approved })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const confirmCancelTask = useCallback(async (taskId: string, questionId: string, approved: boolean) => {
    if (!window.scry?.delegation) return
    setBusy(true)
    try {
      await window.scry.delegation.confirmCancelTask({ taskId, questionId, approved })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const stopAllSubtasks = useCallback(async () => {
    if (!parentSessionKey || !window.scry?.delegation) return
    setBusy(true)
    try {
      await window.scry.delegation.stopSessionSubtasks({ parentSessionKey })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [parentSessionKey, refresh])

  return {
    state,
    busy,
    refresh,
    toggleProject,
    toggleSessionFullAccess,
    confirmTask,
    confirmCancelTask,
    stopAllSubtasks
  }
}
