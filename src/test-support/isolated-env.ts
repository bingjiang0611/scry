import { join } from 'node:path'

/**
 * Env for a fixture whose workspace already lives in a temporary directory.
 *
 * Grants (`commitHookGrantPath`), CLI update state (`cli/update.ts`) and Provider config discovery
 * all resolve their paths from `$HOME`, so an env built from `process.env` alone still writes into
 * the real user directories of whoever runs the suite. Passing the fixture root as `HOME` keeps
 * every one of those writes inside the fixture; `SCRY_GRANT_DIR` states the grant location
 * explicitly so a fixture cannot quietly fall back to `$HOME` either.
 */
export function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    SCRY_GRANT_DIR: join(home, 'grants'),
    ...extra
  }
}
