import type { ProviderId } from './provider.js'

/**
 * Providers gated behind `SCRY_EXPERIMENTAL_PROVIDERS` (comma-separated).
 * Absent from the env var means hidden from registration, CLI detection, and remote discovery.
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
  return parseExperimentalProviders(env.SCRY_EXPERIMENTAL_PROVIDERS).has(providerId)
}
