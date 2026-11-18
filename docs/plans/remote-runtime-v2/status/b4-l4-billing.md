# B4-L4 · 计费（daemon 模式）

`agent:billingState`、`agent:syncBillingAdmin`、`agent:importBillingFixture` 三个通道由 daemon 回答（本机 op `billing`）。

## 做法

- **一份实现。** main 的三个处理抽到 `billing-channels.ts`，main 和 daemon 共用，行为不变。每次调用都先加载 shell 环境，因为同步用的 admin key 来自那里。daemon 用自己持有的 `scry.db` 和自己的 shell 环境。
- **lane。**
  - 同步分页读取，每页最多 20 秒，可能超过 30 秒，所以走 `long` lane（5 分钟）。这条 lane 原名 `mcp`，现在 MCP 与计费同步共用，改成通用名。
  - 状态查询与 fixture 导入很快，留在 bulk。
  - 同步与导入都会写行，不重放。
- **op 文档更正。** 原文写「fixture 导入额外要求开发开关」，但进程内并没有这个开关。daemon 与进程内保持一致，文档已改正。

## 测试（均先失败）

- 单测：三个通道都先加载 shell 环境、再调用；计费函数是注入的假实现，测试碰不到真实 admin 接口。
- 真实 daemon：状态由 daemon 回答；fixture 导入写进 daemon 的临时 `scry.db`，本次实测导入 2 行。
- **同步不在真实 daemon 测试里调用。** 如果 shell 环境里有真实 key，会调用付费接口；真实探针需要维护者另行授权（`BILLING_ADMIN_REAL` 默认关闭）。
- 对照实验，全部失败后恢复：
  - 去掉 daemon 的计费组；
  - 不先加载环境；
  - 同步不走 long lane。

## 门禁（Linux 容器，root）

- 全量 vitest：5920 通过，5 失败，都是已知的环境问题；
- `performance:measure`：Ratchet 通过。

## 未验证

- 未在 macOS 与真实 App 中验证。
- 未用真实 admin key 做同步；需要授权后另行验证。

## c860e7f 本机验证

- 状态、fixture 导入、无 key 同步，两种模式完全一致。导入写入 2 行（`usage_ledger`、`provider_raw_usage`），回答来自 daemon 持有的 `scry.db`。无 key 时同步返回 `missing Anthropic/OpenAI/Qoder Admin configuration`，没有堆栈或 HTTP 细节。
- 本提交没有计费面板（渲染端只有 hook，没有组件使用）。分析面板按会话取数，看不到 gateway 账单行。这些都是迁移之前就有的状态，不在本次范围。
- 未执行（需要授权）：用真实 admin key 同步。
