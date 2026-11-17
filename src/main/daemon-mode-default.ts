// Packaged builds run with the daemon owning runs unless SCRY_HOST_DAEMON says otherwise
// (`SCRY_HOST_DAEMON=0` switches back to the in-process path). Owned test instances
// (SCRY_TEST_APP=1) and development builds keep their explicit choice, so CI smokes and
// unit tests behave as before. This module is imported first by the main entry: every
// later reader of the switch (daemonModeEnabled) sees the resolved value.
export function applyDaemonModeDefault(env: NodeJS.ProcessEnv, input: { isPackaged: boolean }): void {
  if (!input.isPackaged || env.SCRY_TEST_APP === '1' || env.SCRY_HOST_DAEMON !== undefined) return
  env.SCRY_HOST_DAEMON = '1'
}
