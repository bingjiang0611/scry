export interface DiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context'
  text: string
  oldLine?: number
  newLine?: number
}

export function parseUnifiedDiff(patch: string): DiffLine[] {
  let oldLine: number | undefined
  let newLine: number | undefined
  return patch.split('\n').map((text) => {
    if (text.startsWith('diff --git ')) { oldLine = undefined; newLine = undefined }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'hunk', text }
    }
    if (text.startsWith('+') && newLine != null) {
      const line = { kind: 'add' as const, text, newLine }
      if (newLine != null) newLine += 1
      return line
    }
    if (text.startsWith('-') && oldLine != null) {
      const line = { kind: 'del' as const, text, oldLine }
      if (oldLine != null) oldLine += 1
      return line
    }
    if (text.startsWith(' ') && oldLine != null && newLine != null) {
      const line = { kind: 'context' as const, text, oldLine, newLine }
      oldLine += 1
      newLine += 1
      return line
    }
    return { kind: 'meta', text }
  })
}
