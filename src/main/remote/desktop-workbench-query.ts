import { DESKTOP_WORKBENCH_METHODS } from '../../shared/desktop-workbench'

// The device-facing workbench query: its shape and validation only, free of the
// workspace, terminal and source-control hosts that answer it (desktop-workbench.ts), so
// the App's client to other hosts can validate a query without them.

export interface DesktopWorkbenchQuery {
  surface: keyof typeof DESKTOP_WORKBENCH_METHODS
  cwd: string
  method: string
  args: unknown[]
}
export function workbenchObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_workbench_request')
  return value as Record<string, unknown>
}
export function workbenchText(value: unknown, max = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || value.includes('\0')) throw new Error('invalid_workbench_request')
  return value
}
export function parseDesktopWorkbenchQuery(value: unknown): DesktopWorkbenchQuery {
  const input = workbenchObject(value)
  const cwd = workbenchText(input.cwd)
  const surface = input.surface
  if (surface !== 'workspace' && surface !== 'sourceControl' && surface !== 'terminal') throw new Error('invalid_workbench_surface')
  const method = workbenchText(input.method, 64)
  if (!(DESKTOP_WORKBENCH_METHODS[surface] as readonly string[]).includes(method) || !Array.isArray(input.args) || input.args.length > 4) throw new Error('invalid_workbench_method')
  return { surface, cwd, method, args: input.args }
}
