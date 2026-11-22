export function remoteHostEnabled(value: string | undefined, isPackaged: boolean): boolean {
  if (value === '1') return true
  if (value === '0') return false
  return value === undefined && isPackaged
}
