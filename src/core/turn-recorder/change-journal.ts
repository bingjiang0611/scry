import { isAbsolute, relative, resolve } from 'node:path'
import type { TraceEvent } from '../../shared/trace.js'

export interface TurnChangeHints {
  structuredPaths: string[]
}

// 结构化工具路径用于交叉证据；候选完整性由隔离 index 上的 Git status 保证。
export class TurnChangeJournal {
  private readonly root: string
  private readonly paths = new Set<string>()

  constructor(cwd: string) {
    this.root = resolve(cwd)
  }

  record(event: TraceEvent): void {
    if (event.stage === 'tool_result' || (event.fileOp !== 'write' && event.fileOp !== 'edit') || !event.filePath) return
    const path = isAbsolute(event.filePath) ? resolve(event.filePath) : resolve(this.root, event.filePath)
    const fromRoot = relative(this.root, path)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || fromRoot === '.git' || fromRoot.startsWith('.git/')) return
    this.paths.add(path)
  }

  snapshot(): TurnChangeHints {
    return { structuredPaths: [...this.paths].sort() }
  }
}

export function turnChangeHints(cwd: string, events: TraceEvent[]): TurnChangeHints {
  const journal = new TurnChangeJournal(cwd)
  for (const event of events) journal.record(event)
  return journal.snapshot()
}
