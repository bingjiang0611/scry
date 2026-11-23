import { useCallback, useState } from 'react'
import type { StopRequest } from '../run-stop-status'
import { actionErrorText } from './useAsyncAction'

export function useRunStopRequest(currentRunId: string | null) {
  const [stopRequest, setStopRequest] = useState<StopRequest>()
  const stopRun = useCallback(async (): Promise<void> => {
    if (!currentRunId) return
    const runId = currentRunId
    // Feedback from the press, not from main's first stop phase.
    setStopRequest({ runId, status: 'sending' })
    try {
      await window.scry.stop(runId)
    } catch (error) {
      const reason = actionErrorText(error, '停止请求失败')
      setStopRequest((current) => current?.runId === runId ? { runId, status: 'failed', reason } : current)
    }
  }, [currentRunId])
  return { stopRequest, stopRun }
}
