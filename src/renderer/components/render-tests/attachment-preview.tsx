import * as shared from './shared'
const { describe, it, expect, attachmentSrc } = shared

describe('附件预览 data URL 复用', () => {
  it('同一附件对象只构造一次 data URL，不同对象各自构造', () => {
    const attachment = {
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png' as const,
      dataBase64: 'aGVsbG8=',
      size: 5
    }
    const first = attachmentSrc(attachment)
    expect(attachmentSrc(attachment)).toBe(first)
    expect(first).toBe('data:image/png;base64,aGVsbG8=')
    const other = attachmentSrc({ ...attachment, dataBase64: 'aGk=' })
    expect(other).toBe('data:image/png;base64,aGk=')
  })
})