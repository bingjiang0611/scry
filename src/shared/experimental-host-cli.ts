export const EXPERIMENTAL_HOST_CLI_ENV = 'SCRY_EXPERIMENTAL_HOST_CLI'

export function isHostCliExperimentalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXPERIMENTAL_HOST_CLI_ENV]?.trim() !== '0'
}
