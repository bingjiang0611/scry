import type { ChannelHandlers } from './startup-channels'


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
