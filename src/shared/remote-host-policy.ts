// Pure remote-host enablement rule shared by Electron main and plain-Node daemon/CLI
// modules (kept apart from daemon-channel-gate so login-start stays dependency-light).
export function remoteHostEnabled(value: string | undefined, isPackaged: boolean): boolean {
  if (value === '1') return true
  if (value === '0') return false
  return value === undefined && isPackaged
}
