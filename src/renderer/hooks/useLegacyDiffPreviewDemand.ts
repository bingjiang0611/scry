import { useEffect } from 'react'

/** View demand is independent of focus, adoption, approval and run lifetime. */
export function useLegacyDiffPreviewDemand(runId: string | null, visible: boolean): void {
  useEffect(() => {
    if (!runId || !visible) return
    const send = (demanded: boolean) => {
      void window.scry.setLegacyDiffPreviewDemand(runId, demanded).catch(error => {
        console.warn('[diff-preview] legacy demand notification failed', error)
      })
    }
    const update = () => send(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      send(false)
    }
  }, [runId, visible])
}
