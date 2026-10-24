export type JsonRecord = Record<string, unknown>

export const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : {}
export const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
export const serialized = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null)
export const bounded = (value: unknown, max = 200_000): string => {
  const text = serialized(value)
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated by Scry]`
}
