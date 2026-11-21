import type { ProviderId } from './provider.js'

/**
 * Providers gated behind `SCRY_EXPERIMENTAL_PROVIDERS` (comma-separated).
 * Unset means every experimental provider is enabled (maintainer 2026-11-21, trial
 * default on this branch). When set, only the listed ones are enabled, so an empty
 * value or `none` hides them all from registration, CLI detection and remote discovery.
 */
export const EXPERIMENTAL_PROVIDER_IDS = ['antigravity'] as const satisfies readonly ProviderId[]
export const EXPERIMENTAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(EXPERIMENTAL_PROVIDER_IDS)

export function parseExperimentalProviders(value: string | undefined): ReadonlySet<ProviderId> {
  return new Set(
    (value?.split(',') ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is ProviderId => EXPERIMENTAL_PROVIDERS.has(item as ProviderId))
  )
}

export function isExperimentalProviderEnabled(
  providerId: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!EXPERIMENTAL_PROVIDERS.has(providerId)) return true
  if (env.SCRY_EXPERIMENTAL_PROVIDERS === undefined) return true
  return parseExperimentalProviders(env.SCRY_EXPERIMENTAL_PROVIDERS).has(providerId)
}
