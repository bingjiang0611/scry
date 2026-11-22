import { billingChannelHandlers } from '../../main/bootstrap/billing-channels'
import { billingStateQuery, importBillingFixture, syncBillingAdmin } from '../../main/db'
import { warmShellEnv } from '../../main/claude-locate'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

export const billingLocalOps: DaemonLocalOpGroup = () =>
  billingChannelHandlers({ warmShellEnv, billingStateQuery, syncBillingAdmin, importBillingFixture }) as Record<string, LocalOpHandler>
