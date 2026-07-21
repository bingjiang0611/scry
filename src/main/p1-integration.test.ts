// P1 集成验证（goal：真实会话证 forwardSubagentText 后 subagent 挂父）。默认跳过。手动：
//   P1_PROBE=1 CLAUDE_BIN=$HOME/.nvm/versions/node/v22.22.1/bin/claude \
//     NODE_OPTIONS=--experimental-sqlite npx vitest run src/main/p1-integration.test.ts
// 走真实 runAgent（已开 forwardSubagentText:true）→ 驱动一个 subagent → 证 subagent 的
// 步骤经主流带 parent_tool_use_id 上来，spanRowsFromItems 落成挂在父 Task 下的 span。
import { describe, it, expect } from 'vitest'
import { runAgent } from './agent-runner'
import { humanEvent } from './normalize'
import { DDL_V1, DDL_V2, DDL_V3, SPAN_COLS, sqlInsert, spanRowsFromItems } from './span-ledger'
import type { TraceEvent } from '../shared/trace'

const RUN = process.env.P1_PROBE === '1'
const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin/claude`

;(RUN ? describe : describe.skip)('P1 集成：forwardSubagentText → subagent 挂父', () => {
  it(
    '真实会话驱动 subagent，子步骤带 parent_tool_use_id 并落成挂父 span',
    async () => {
      const items: TraceEvent[] = []
      const runId = 'run-p1-probe'
      const cwd = process.cwd()
      items.push(humanEvent('P1 subagent 验证', { runId, newId: () => `h-${items.length}`, now: () => new Date().toISOString() }))
      const handle = runAgent(
        '用 Task 工具启动一个 general-purpose 子 agent，让它用 Bash 跑 `echo from-subagent` 并回报。完成后只回「done」。',
        runId,
        (ev) => items.push(ev),
        { cwd, claudePath: CLAUDE, env: process.env as Record<string, string> }
      )
      const res = await handle.promise
      expect(res.sessionId).toBeTruthy()

      // 主流上应出现带 parentToolUseId 的 subagent 事件（forwardSubagentText 的效果）
      const subItems = items.filter((e) => e.parentToolUseId)
      // eslint-disable-next-line no-console
      console.log(`\n===== P1 证据 =====\nsubagent 事件(带 parentToolUseId): ${subItems.length}`)
      // eslint-disable-next-line no-console
      console.log('parent tool_use_ids:', [...new Set(subItems.map((e) => e.parentToolUseId))])
      expect(subItems.length).toBeGreaterThan(0)

      // 落库后，spans 表应有 parent_tool_use_id 非空的行（挂父）
      type Stmt = { run: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] }
      type Db = { prepare: (s: string) => Stmt; close: () => void }
      const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db }
      const db = new sqlite.DatabaseSync(':memory:')
      for (const stmt of [...DDL_V1, ...DDL_V2, ...DDL_V3]) db.prepare(stmt).run()
      const rows = spanRowsFromItems({ runId, sessionId: res.sessionId, cwd, items, nowMs: Date.now() })
      const insSpan = db.prepare(sqlInsert('spans', SPAN_COLS))
      for (const r of rows.spans) insSpan.run(...(r as unknown[]))
      const nested = db
        .prepare(`SELECT kind, tool, parent_tool_use_id FROM spans WHERE parent_tool_use_id IS NOT NULL`)
        .all() as Record<string, unknown>[]
      // eslint-disable-next-line no-console
      console.log('挂父 spans:', nested)
      expect(nested.length).toBeGreaterThan(0)
      db.close()
    },
    240000
  )
})
