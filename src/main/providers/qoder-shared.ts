let counter = 0

export const newId = (): string => `qoder-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function qoderRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function explainQoderSessionAccessError(error: unknown): never {
  const failure = error as NodeJS.ErrnoException | null
  if (failure?.code !== 'EPERM' && failure?.code !== 'EACCES') throw error
  throw new Error(
    `Qoder 会话文件访问被系统拒绝（${failure.code}）${failure.path ? `：${failure.path}` : ''}。` +
    '请检查该文件及父目录权限；macOS 下同时检查 Scry 的文件访问授权，确认后重试。' +
    'Scry 未自动更改权限或重试创建分支。',
    { cause: error }
  )
}
