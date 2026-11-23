import type { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { AppHint, AuthoritySubscribeRuntimeDeps } from './orchestration-authority-subscribe'
import { createAuthoritySubscribeHandler, forwardAppHintToSubscribeHub } from './orchestration-authority-subscribe'

/** Small transport handlers kept out of `orchestration-authority.ts` to hold its 20 KB budget. */
export function createTransportHandlers(input: {
  sink: EventSink
  subscribeHub: SubscribeHub
  resolveCanonical: (runId: string) => string
}): {
  createSubscribeHandler: (deps: AuthoritySubscribeRuntimeDeps) => ReturnType<typeof createAuthoritySubscribeHandler>
  publishHint: (event: AppHint) => void
} {
  return {
    createSubscribeHandler: (deps) => createAuthoritySubscribeHandler(input.sink, input.subscribeHub, deps),
    publishHint: (event) => forwardAppHintToSubscribeHub(input.subscribeHub, event, input.resolveCanonical)
  }
}
