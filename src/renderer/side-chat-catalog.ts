import type { CapabilityEnvelope, ProviderContext } from '@shared/provider'
import type { AgentRunControlCatalog } from '@shared/runtime'
import { contextKey } from './hooks/integration-model'

export type CatalogReadOutcome =
  | { status: 'ready'; data: AgentRunControlCatalog }
  | { status: 'refused'; reason: string }

/**
 * One coalesced capability read per explicit picker interaction and Provider context.
 *
 * Model and effort live in the same picker, so opening it must not read twice: a request
 * for the context already in flight, or already loaded for this context, is dropped.
 * Every request bumps a generation, so a late answer for another Provider, profile or
 * cwd can never relabel the current controls. Nothing here reads on mount.
 */
export function createRunControlCatalogReader({ read, settle }: {
  read: (context: ProviderContext) => Promise<CapabilityEnvelope<AgentRunControlCatalog>>
  settle: (outcome: { key: string; result: CatalogReadOutcome }) => void
}) {
  let generation = 0
  let inflight: string | undefined
  let loaded: string | undefined
  /** Starts one read and answers whether it did; a coalesced request never reports. */
  const request = (context: ProviderContext): boolean => {
    const key = contextKey(context)
    if (inflight === key || loaded === key) return false
    const mine = ++generation
    inflight = key
    void read(context).then(result => {
      if (mine !== generation) return
      inflight = undefined
      const outcome: CatalogReadOutcome = result.data
        ? { status: 'ready', data: result.data }
        : { status: 'refused', reason: result.reason ?? '' }
      if (outcome.status === 'ready') loaded = key
      settle({ key, result: outcome })
    }).catch((failure: unknown) => {
      if (mine !== generation) return
      inflight = undefined
      settle({ key, result: { status: 'refused', reason: failure instanceof Error ? failure.message : String(failure) } })
    })
    return true
  }
  /** A catalog already shown from the local cache needs no read when the picker opens. */
  const markLoaded = (key: string): void => { loaded = key }
  const cancel = (): void => { generation += 1; inflight = undefined }
  return { request, markLoaded, cancel }
}
