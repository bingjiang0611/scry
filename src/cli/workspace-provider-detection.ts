import { delimiter, join, resolve } from 'node:path'
import { executable, exists, readOptional } from './workspace-files.js'
import { type InitProvider, CONFIG_PATHS, HANDLER_ID, providerHookSource } from './workspace-hook-sources.js'
import { readFile } from 'node:fs/promises'


export async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await executable(join(directory, command))) return true
  }
  return false
}

/** Non-throwing detection shared by `init` and `status`. */
export async function detectWorkspaceProviders(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<InitProvider[]> {
  const checks: Array<[InitProvider, boolean]> = [
    ['claude', await exists(join(workspace, '.claude')) || await commandExists('claude', env)],
    ['codex', await exists(join(workspace, '.codex')) || await commandExists('codex', env)],
    ['qoder', await exists(join(workspace, '.qoder')) || await commandExists('qodercli', env) || await commandExists('qoder', env)],
    ['opencode', await exists(join(workspace, '.opencode')) || await commandExists('opencode', env)]
  ]
  return checks.filter(([, found]) => found).map(([provider]) => provider)
}

/**
 * Identify managed hooks by handler id rather than by exact command equality, so a changed
 * command shape is still recognised as installed instead of silently appending a duplicate.
 */
export async function providerHookInstalled(workspace: string, provider: InitProvider): Promise<boolean> {
  const path = provider === 'opencode'
    ? join(workspace, '.opencode/plugins/scry-recorder.js')
    : join(workspace, CONFIG_PATHS[provider])
  const source = await readFile(path, 'utf8').catch(() => null)
  return source != null && source.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
}

/**
 * `scry upgrade` replaces the CLI, never the workspace files it once wrote, so a script from an
 * older release keeps running until `init` or `integrations repair` rewrites it. `outdated` is the
 * state nothing reported before; `unmanaged` means a hand-written bridge that Scry must not touch.
 */
export async function providerHookScriptState(
  workspace: string
): Promise<'current' | 'outdated' | 'unmanaged' | 'absent'> {
  const source = await readOptional(join(resolve(workspace), '.scry/provider-hook.sh'))
  if (source == null) return 'absent'
  if (!source.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)) return 'unmanaged'
  return source === providerHookSource() ? 'current' : 'outdated'
}
