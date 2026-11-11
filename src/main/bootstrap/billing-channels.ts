import type { ChannelHandlers } from './startup-channels'

// The three billing channels as main has always answered them, shared with the daemon,
// which owns scry.db (B4-L4). The shell environment is warmed first because the admin
// keys a sync uses come from it. The functions are injected so a test never reaches a
// real billing API: a sync with real keys costs money and needs explicit authorization.

export interface BillingChannelDependencies<State, Sync, Fixture> {
  warmShellEnv: () => Promise<unknown>
  billingStateQuery: () => State
  syncBillingAdmin: () => Promise<Sync>
  importBillingFixture: () => Fixture
}

export function billingChannelHandlers<State, Sync, Fixture>(deps: BillingChannelDependencies<State, Sync, Fixture>) {
  return {
    'agent:billingState': async () => {
      await deps.warmShellEnv()
      return deps.billingStateQuery()
    },
    'agent:syncBillingAdmin': async () => {
      await deps.warmShellEnv()
      return deps.syncBillingAdmin()
    },
    'agent:importBillingFixture': async () => {
      await deps.warmShellEnv()
      return deps.importBillingFixture()
    }
  } satisfies ChannelHandlers
}
