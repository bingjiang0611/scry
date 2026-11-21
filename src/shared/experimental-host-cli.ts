/**
 * Release-order isolation for P5 Step 2 (`scry-host` CLI pairing approval, App switch entry,
 * `host-admin.sock`, and writing `approvedVia` on grants).
 *
 * P5-5a (W3 read compatibility) must ship at least one release before P5-7 writes `approvedVia`.
 * Enabled by default (maintainer 2026-11-21, trial default on this branch); set the
 * variable to `0` to turn it off. While off, behavior stays identical to pre-P5-Step-2:
 * no `approvedVia` written, no `host-admin.sock` listening, no App switch entry shown,
 * and CLI approval commands refused. The approval switch itself still defaults to off
 * and is only turned on through the App's native confirmation.
 */
export const EXPERIMENTAL_HOST_CLI_ENV = 'SCRY_EXPERIMENTAL_HOST_CLI'

export function isHostCliExperimentalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXPERIMENTAL_HOST_CLI_ENV]?.trim() !== '0'
}
