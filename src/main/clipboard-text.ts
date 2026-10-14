import type { Clipboard } from 'electron'

// A bounded text-only IPC operation: no clipboard reads or renderer permission changes.
export function writeClipboardText(text: unknown, clipboard: Pick<Clipboard, 'writeText'>): true {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1_000_000) {
    throw new Error('复制内容必须是非空文本，最多 1,000,000 个字符')
  }
  clipboard.writeText(text)
  return true
}
