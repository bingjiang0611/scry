/** A local catalog label, never a replacement for Provider transcript content. */
export const SESSION_TITLE_MAX_LENGTH = 120

export function normalizeSessionTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('会话名称必须是文本')
  const title = value.trim()
  if (!title) throw new Error('会话名称不能为空')
  if (title.length > SESSION_TITLE_MAX_LENGTH) throw new Error(`会话名称不能超过 ${SESSION_TITLE_MAX_LENGTH} 个字符`)
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new Error('会话名称不能包含换行或控制字符')
  return title
}
