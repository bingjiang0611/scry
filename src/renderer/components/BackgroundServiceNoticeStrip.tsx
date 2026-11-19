import { LOGIN_START_COPY } from '../constants/background-service-copy'
import { useBackgroundServiceNotice } from '../hooks/useBackgroundServiceNotice'
import { Button } from './primitives/Button'
import { Notice } from './primitives/Notice'

export function BackgroundServiceNoticeStrip({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element | null {
  const { messages, dismiss } = useBackgroundServiceNotice()
  if (messages.length === 0) return null
  return (
    <Notice
      tone="warn"
      layout="strip"
      size="sm"
      role="status"
      action={(
        <>
          <Button size="sm" onClick={onOpenSettings}>{LOGIN_START_COPY.openSettingsButton}</Button>
          <Button size="sm" onClick={dismiss}>{LOGIN_START_COPY.dismissButton}</Button>
        </>
      )}
    >
      {messages.join(' ')}
    </Notice>
  )
}
