// Packaged builds, development builds (`npm run dev`), and `SCRY_TEST_APP=1` test
// instances all default to daemon mode unless `SCRY_HOST_DAEMON` is explicitly set
// (W15 / P3-s3-plan §1). Explicit `SCRY_HOST_DAEMON=0` remains the in-process escape
// hatch for one release cycle. This module is imported first by the main entry so every
// later reader of `daemonModeEnabled` sees the resolved value.
export function applyDaemonModeDefault(env: NodeJS.ProcessEnv, _input?: { isPackaged?: boolean }): void {
  if (env.SCRY_HOST_DAEMON !== undefined) return
  env.SCRY_HOST_DAEMON = '1'
}
