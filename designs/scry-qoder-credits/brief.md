# D-20260909-qoder-credits · Qoder 用量补充

- 范围 / 状态：用户先要求解决 Qoder「成本不可用」，后明确授权补齐 recorder / CLI 采集链路；成品目视验收待确认。
- 基线：用户截图中 Qoder 金额为 `—`、Token 为已知下界。沿用 `src/renderer/components/AnalyticsView.tsx` 与 `src/renderer/analytics-evidence.css`，不重设计页面、不修改其他 Provider。
- 硬约束：Credits 不是美元；缺失不作零，折前 Credits 不冒充实际扣量，会话累计值不逐轮累加。
- 方案：共享 `src/shared/credit-usage.ts` 与 `src/shared/qoder-credit-requests.ts` 提供计量合同、去重和原生身份关联。独立 recorder 从原生本轮读取，managed recorder 从 SDK 本轮消息聚合，写入 `usage.value.credits`；CLI summary 保留独立单位/来源/覆盖。App 的 `src/main/qoder-credits.ts` 优先读取同源已记录证据，旧 archive 缺字段时才沿 parent 链读取原生日志，绝不叠加同一轮的两份计量；按 Scry 轮次日期归集。
- 展示：Qoder 卡片及模型/日期明细显示独立 Credits；总览单列「另计」，不进入美元金额、占比与成本趋势。覆盖信息保留已知下界和 tooltip。
- 限制：用量查询只读，不读账户配额、不请求 Provider、不折算金额、不改写旧 records 或原生日志。新轮次才记录 Credits；SQLite 中独立 Credits 行不重复累计已有 Token 行。缺失身份、原生日志、冲突计量、超出读取预算及子代理用量均不猜测；因此不是完整账单。
- 复用：本机库检索 `Scry usage analytics` 无匹配；直接复用当前生产卡片和表格，无新增全局视觉偏好或独立组件资产。

## 验证入口

```sh
npx vitest run src/main/qoder-credits.test.ts src/renderer/components/AnalyticsView.credits.test.tsx src/renderer/components/render.test.tsx src/main/billing-ledger.test.ts src/main/span-ledger.test.ts src/main/db-outbox.test.ts
node scripts/analytics-credits-ui-smoke.mjs
npm run check:cli-release
npm run typecheck
npm run build
git diff --check
```

已通过 focused 单测、临时数据目录中的真实 SQLite / archive / 隐藏 Electron DOM fixture、类型和构建检查。fixture 覆盖日期/模型、Token/美元趋势、刷新和时间范围切换；不等同于正常用户数据下完整 App 的原问题目视验收。本机历史数据另做了只读统计核对，未将私人明细写入仓库。

### Recorder / CLI 0.2.40 验证

- `check:cli-release`：506 tests 与实际安装临时 tarball 的 hook → record → summary → verify 通过。
- 受影响 App/共享/recorder focused：124 tests 通过；SQLite / archive / Electron fixture 验证 recorded 覆盖 native、result-less 轮次可见且 Token 不双计。
- Node 22 全量最后一轮：1812 passed、3 个外部集成 skipped；无改动的 `git.test.ts` scope 用例触发 5 秒超时，原命令单例重跑 1.28 秒通过，未放宽 timeout 或修改 Git 代码。Shell gate 通过。
- `pack:artifact`：构建、资源 allowlist、包内私有 CLI 0.2.40、隔离与 preload/terminal Electron smoke 通过；仅开发签名，未公证、未安装。
- 未验证：新版本真实 Qoder 付费请求和正常数据目视验收、Node 20/Linux 矩阵；未发布 registry、未升级全局 CLI、未重写历史记录。
