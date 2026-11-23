import { join } from 'node:path'

export function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    SCRY_GRANT_DIR: join(home, 'grants'),
    ...extra
  }
}
