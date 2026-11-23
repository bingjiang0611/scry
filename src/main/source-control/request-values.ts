// The request value checks every source-control channel applies, free of the service and
// its stores, so the App's forward of these channels binds requests the same way.

type Input = Record<string, unknown>
export function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('源代码管理请求必须是对象')
  return value as Input
}
export function text(value: unknown, limit = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || value.includes('\0'))
    throw new Error('请求字符串为空、过长或包含 NUL')
  return value
}
