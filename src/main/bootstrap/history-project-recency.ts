import type { ProviderId } from '../../shared/provider'
import { PerformanceTrace } from '../performance-timing'

export function rememberSessionProjectAfterLoad(
  providerId: ProviderId,
  cwd: string,
  rememberProject: (cwd: string) => void
): void {
  setImmediate(() => {
    const perf = new PerformanceTrace('session_history.remember_project', { provider: providerId })
    try {
      rememberProject(cwd)
      perf.finish()
    } catch {
      perf.finish(undefined, 'error')
    }
  })
}
