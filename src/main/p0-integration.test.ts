// P0 集成验证（goal：真实 app 驱动会话 + SQLite 查询为证）。默认跳过——只在显式跑时驱动真实
// claude（花真钱/真时间，反 dry_run）。手动：
//   P0_PROBE=1 CLAUDE_BIN=$HOME/.nvm/versions/node/v22.22.1/bin/claude \
//     NODE_OPTIONS=--experimental-sqlite npx vitest run src/main/p0-integration.test.ts
// 走 app 真实代码路径 runAgent→normalize→spanRowsFromItems→真实 SQLite，证 RFC §13 答得上。
// 用 Node 内置 node:sqlite（非 better-sqlite3）——后者为 electron ABI 编译，vitest 的 node 加载不了。
// SQL/schema 与 db.ts 走的 better-sqlite3 完全一致（同 span-ledger 常量），验证等价。
import { describe, it, expect } from 'vitest'
import { runAgent } from './agent-runner'
import { humanEvent } from './normalize'
import {
  DDL_V1,
  DDL_V2,
  DDL_V3,
  SPAN_COLS,
  MODEL_USAGE_COLS,
  FILE_OP_COLS,
  TOTALS_SQL,
  TOP_TOOLS_SQL,
  BY_MODEL_SQL,
  sqlInsert,
  spanRowsFromItems
} from './span-ledger'
import type { TraceEvent } from '../shared/trace'

const RUN = process.env.P0_PROBE === '1'
const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin/claude`

;(RUN ? describe : describe.skip)('P0 集成：真实会话 → span 落库 → §13 可答', () => {
  it(
    '驱动真实 claude，spans/model_usage/file_ops 落库且跨会话查询返回真实数据',
    async () => {
      const items: TraceEvent[] = []
      const runId = 'run-p0-probe'
      const cwd = process.cwd()
      items.push(
        humanEvent('真实集成验证任务', {
          runId,
          newId: () => `h-${items.length}`,
          now: () => new Date().toISOString()
        })
      )
      const handle = runAgent(
        '用 Bash 跑 `echo p0-integration-ok`；再用 Read 读本仓库的 package.json 头几行。然后只回一句「done」。',
        runId,
        (ev) => items.push(ev),
        { cwd, claudePath: CLAUDE, env: process.env as Record<string, string> }
      )
      const res = await handle.promise
      expect(res.sessionId).toBeTruthy()

      // 真实 SQLite（Node 内置 node:sqlite，临时内存库），走真实 schema + 真实行映射
      type Stmt = { run: (...p: unknown[]) => unknown; get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] }
      type Db = { prepare: (s: string) => Stmt; close: () => void }
      const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db }
      const db = new sqlite.DatabaseSync(':memory:')
      for (const stmt of DDL_V1) db.prepare(stmt).run()
      for (const stmt of DDL_V2) db.prepare(stmt).run()
      for (const stmt of DDL_V3) db.prepare(stmt).run()
      const rows = spanRowsFromItems({ runId, sessionId: res.sessionId, cwd, items, nowMs: Date.now() })
      const insSpan = db.prepare(sqlInsert('spans', SPAN_COLS))
      const insMu = db.prepare(sqlInsert('model_usage', MODEL_USAGE_COLS))
      const insFo = db.prepare(`INSERT INTO file_ops (${FILE_OP_COLS.join(', ')}) VALUES (${FILE_OP_COLS.map(() => '?').join(', ')})`)
      for (const r of rows.spans) insSpan.run(...(r as unknown[]))
      for (const r of rows.modelUsage) insMu.run(...(r as unknown[]))
      for (const r of rows.fileOps) insFo.run(...(r as unknown[]))

      // §13 成功标准查询
      const totals = db.prepare(TOTALS_SQL).get() as { cost: number; tin: number; tout: number; turns: number }
      const topTools = db.prepare(TOP_TOOLS_SQL).all() as { tool: string; n: number; mcp: number }[]
      const byModel = db.prepare(BY_MODEL_SQL).all() as { model: string; tin: number; tout: number; cost: number }[]
      const files = db.prepare(`SELECT op, path, source, confidence FROM file_ops`).all() as Record<string, unknown>[]

      // eslint-disable-next-line no-console
      console.log('\n===== P0 §13 真实数据证据 =====')
      // eslint-disable-next-line no-console
      console.log('totals:', totals)
      // eslint-disable-next-line no-console
      console.log('topTools:', topTools)
      // eslint-disable-next-line no-console
      console.log('byModel:', byModel)
      // eslint-disable-next-line no-console
      console.log('file_ops:', files)

      // 断言：真实花费/token、工具落库、按模型可分、文件足迹 exact
      expect(totals.turns).toBeGreaterThanOrEqual(1)
      expect(totals.cost).toBeGreaterThan(0)
      expect(totals.tin).toBeGreaterThan(0)
      expect(topTools.length).toBeGreaterThan(0)
      expect(byModel.length).toBeGreaterThan(0)
      expect(byModel[0].tin).toBeGreaterThan(0)
      // 读了 package.json → file_ops 有 read/exact
      expect(files.some((f) => f.op === 'read' && f.confidence === 'exact')).toBe(true)
      db.close()
    },
    240000
  )
})
