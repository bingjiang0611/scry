// 文件足迹：结构化读写计数 + Bash 只读命令推断出的读取，并回答「第一次写入前有没有读取证据」。
import type { TraceEvent } from '@shared/trace'
import { inferredReadPaths } from './file-evidence'

export interface FileRow {
  path: string
  read: number
  inferredRead: number
  write: number
  edit: number
}

// P2 Files（RFC §8.4）：写/改文件的「读覆盖」——第一次写入前有没有读取证据。
// tool_result 会继承 fileOp/filePath，必须排除；写后补读不反向洗掉盲改风险。
export interface FileCoverage {
  written: number // 写或改过的文件数
  readBefore: number // 第一次写或改之前已读过的文件数
  inferredReadBefore: number // readBefore 中仅由 Bash 只读命令推断的文件数
  blind: string[] // 第一次写或改之前没有读取证据的文件路径（仍可能存在未识别的间接读取）
}

export function fileWriteCoverage(items: TraceEvent[]): FileCoverage {
  const candidatePaths = [...new Set(items.flatMap((event) => event.filePath ? [event.filePath] : []))]
  const exactRead = new Set<string>()
  const inferredRead = new Set<string>()
  const written = new Set<string>()
  const covered = new Set<string>()
  const inferredCovered = new Set<string>()
  const pending = new Map<string, TraceEvent[]>()
  const applyCompleted = (event: TraceEvent): void => {
    if (event.fileOp && event.filePath) {
      if (event.fileOp === 'read') {
        exactRead.add(event.filePath)
      } else if (!written.has(event.filePath)) {
        written.add(event.filePath)
        if (exactRead.has(event.filePath) || inferredRead.has(event.filePath)) {
          covered.add(event.filePath)
          if (!exactRead.has(event.filePath)) inferredCovered.add(event.filePath)
        }
      }
    }
    for (const path of inferredReadPaths(event, candidatePaths)) inferredRead.add(path)
  }
  for (const event of items) {
    if (event.stage === 'tool_result') {
      if (!event.toolUseId) continue
      const completed = pending.get(event.toolUseId) ?? []
      pending.delete(event.toolUseId)
      if (event.isError) continue
      for (const started of completed) applyCompleted(started)
      continue
    }
    const hasFileEvidence =
      !!(event.fileOp && event.filePath) ||
      inferredReadPaths(event, candidatePaths).length > 0
    if (!hasFileEvidence) continue
    if (!event.toolUseId) {
      // CLI 的 file_op 是完成态事实，不另发 tool_result。
      applyCompleted(event)
      continue
    }
    const sameCall = pending.get(event.toolUseId) ?? []
    sameCall.push(event)
    pending.set(event.toolUseId, sameCall)
  }
  const blind = [...written].filter((path) => !covered.has(path))
  return {
    written: written.size,
    readBefore: covered.size,
    inferredReadBefore: inferredCovered.size,
    blind
  }
}

export function bashFiles(cmd: string): string[] {
  const out = new Set<string>()
  for (const raw of cmd.split(/[\s;|&><()]+/)) {
    const t = raw.replace(/['"`]/g, '')
    if (!t || t.startsWith('-')) continue
    if (t.startsWith('/dev/')) continue // /dev/null 等重定向目标不是文件足迹（basename 会显示成 "null"）
    const looksLikeFile = /\.[A-Za-z0-9]{1,6}$/.test(t) || (t.includes('/') && !/^https?:/.test(t))
    if (looksLikeFile && t.length > 1) out.add(t)
  }
  return [...out].slice(0, 12)
}

export function aggregateFiles(items: TraceEvent[]): { structured: FileRow[]; bash: string[] } {
  const m = new Map<string, FileRow>()
  const bash = new Set<string>()
  const failedToolUseIds = new Set(
    items
      .filter((event) => event.stage === 'tool_result' && event.isError && event.toolUseId)
      .map((event) => event.toolUseId as string)
  )
  for (const e of items) {
    if (e.stage === 'tool_result') continue
    if (e.fileOp && e.filePath) {
      let r = m.get(e.filePath)
      if (!r) {
        r = { path: e.filePath, read: 0, inferredRead: 0, write: 0, edit: 0 }
        m.set(e.filePath, r)
      }
      if (e.fileOp === 'read') r.read++
      else if (e.fileOp === 'write') r.write++
      else r.edit++
    }
    if (e.tool === 'Bash') {
      const inp = e.input as Record<string, unknown> | undefined
      if (typeof inp?.command === 'string') bashFiles(inp.command).forEach((f) => bash.add(f))
    }
  }
  const candidates = [...m.keys()]
  for (const event of items) {
    if (event.stage === 'tool_result' || failedToolUseIds.has(event.toolUseId ?? '') || event.isError) continue
    for (const path of inferredReadPaths(event, candidates)) {
      let row = m.get(path)
      if (!row) {
        row = { path, read: 0, inferredRead: 0, write: 0, edit: 0 }
        m.set(path, row)
      }
      row.read++
      row.inferredRead++
    }
  }
  for (const k of m.keys()) bash.delete(k)
  return { structured: [...m.values()], bash: [...bash] }
}

export function fileBadge(f: FileRow): string {
  return f.write > 0 ? 'W' : f.edit > 0 ? 'E' : 'R'
}
