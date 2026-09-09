# D-20260909-qoder-credits · Qoder 用量补充

- 范围 / 状态：Scry 用量页局部修复；用户要求解决 Qoder「成本不可用」，已授权实现；成品目视验收待确认。
- 基线：用户截图中 Qoder 金额为 `—`、Token 为已知下界。沿用 `src/renderer/components/AnalyticsView.tsx` 与 `src/renderer/analytics-evidence.css`，不重设计页面、不修改其他 Provider。
- 硬约束：Credits 不是美元；缺失不作零，折前 Credits 不冒充实际扣量，会话累计值不逐轮累加。
- 方案：新增只读 `src/main/qoder-credits.ts`，仅将 SQLite 已记录轮次与 Scry archive / Qoder 原生用户身份精确关联，沿 parent 链读取主会话请求计量；按 request ID 去重，按 Scry 轮次日期归集。历史和新增日志走同一路径，刷新不受旧 SQLite 缓存短路。
- 展示：Qoder 卡片及模型/日期明细显示独立 Credits；总览单列「另计」，不进入美元金额、占比与成本趋势。覆盖信息保留已知下界和 tooltip。
- 限制：不读账户配额、不请求 Provider、不折算金额、不改写 SQLite/原生日志/recorder records。缺失身份、原生日志、冲突计量、超出读取预算及子代理用量均不猜测；因此不是完整账单。
- 复用：本机库检索 `Scry usage analytics` 无匹配；直接复用当前生产卡片和表格，无新增全局视觉偏好或独立组件资产。

## 验证入口

```sh
npx vitest run src/main/qoder-credits.test.ts src/renderer/components/AnalyticsView.credits.test.tsx src/renderer/components/render.test.tsx src/main/billing-ledger.test.ts src/main/span-ledger.test.ts src/main/db-outbox.test.ts
node scripts/analytics-credits-ui-smoke.mjs
npm run typecheck
npm run build
git diff --check
```

已通过 focused 单测、临时数据目录中的真实 SQLite / archive / 隐藏 Electron DOM fixture、类型和构建检查。fixture 覆盖日期/模型、Token/美元趋势、刷新和时间范围切换；不等同于正常用户数据下完整 App 的原问题目视验收。本机历史数据另做了只读统计核对，未将私人明细写入仓库。
