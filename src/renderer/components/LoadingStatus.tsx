import { useDelayedFlag } from '../hooks/useDelayedFlag'

type LoadingStatusProps = { title: string; detail?: string; className?: string }

export function DelayedLoadingStatus({ loading, ...props }: LoadingStatusProps & { loading: boolean }) {
  const visible = useDelayedFlag(loading)
  return visible ? <LoadingStatus {...props} /> : null
}

export function LoadingStatus({ title, detail, className = '' }: LoadingStatusProps) {
  return <div className={`loading-status ${className}`} role="status" data-status="loading">
    <span className="loading-status-bar" aria-hidden="true" />
    <div className="loading-status-copy">
      <b>{title}</b>
      {detail && <span>{detail}</span>}
    </div>
  </div>
}
