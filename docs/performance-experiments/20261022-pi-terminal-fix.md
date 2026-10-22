# Pi CLI 模型失败终态修复 · 2026-10-22

后续已获授权完成 [CLI 0.2.51 整合与本机安装](20261022-cli-051-delivery.md)。下文保留修复阶段的验证和当时未安装状态。

## 结果

代码提交：`bc45459cd1ceca3a0f05fbf79bcf73e337055749`。

- Pi 模型失败记录为 `failed`，取消记录为 `cancelled`，不再把 settled 当成成功。
- 保留 Provider 错误信息；超长错误按 64 KiB UTF-8 边界截断并标记 partial。正文与错误同时截断时，两份限制元数据都保留。
- 成功重试清除前一次失败状态；普通工具失败不等于整轮模型失败。
- 会话关闭时保留已经观测到的失败/取消；没有明确失败的未收敛轮仍为 interrupted。
- 已保存的两条真实 Pi API 失败事件离线重放后，都得到 `failed + errors.available`，错误文本与原始事件一致。
- 使用修复产物，Rotom 内置 Pi `1.3.0-rotom.2` / `openai-codex/gpt-6-astra` 完成真实三轮。没有替换 PATH Pi 或日常 Scry CLI。

这是[前次验收](20261022-cli-real-providers.md)的修复后续，不覆盖或改写前次失败证据。

## 修改范围

- `packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs`：从最后一条 assistant 的 `stopReason/errorMessage` 保留终态；settled 的 aborted 标记优先；复用原有 UTF-8 限制，并合并正文/错误的限制元数据。
- `src/core/turn-recorder/recorder.ts`：将 Pi Stop 的明确错误投影为已有 `task_error` trace，标明错误证据可观测。
- `src/core/turn-recorder/aggregate.ts`：保留明确的 Provider `task_error`，不把它计为工具调用；继续排除普通 hook/runtime 诊断。该投影也接受原有 Codex parser 已产生的明确 task_error，不改变工具调用计数。
- `src/cli/pi-integration.test.ts`、`src/core/turn-recorder/aggregate.test.ts`：新增 10 项合同/回归检查。扩展测试通过真实 direct 子进程接收载荷，再进入生产 recorder 和 canonical store；检查参数边界、唯一 Stop、终态、错误以及持久化结果。

未修改 Provider 权限、trust、ACK、上传策略、历史记录、日常 daemon 或 App。未升版本、安装、合入或 push。

## 验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 旧实现负对照 | 6 失败、3 通过、8 未选中 | 新终态用例；证明旧 completed/interrupted 状态错误 |
| focused 回归 | 204 通过 | Pi integration、aggregate、recorder、turns-summary |
| `npm run typecheck` | 通过 | Node/Web |
| `npm run build:cli` | 通过 | 当前修复源码 |
| `npm run check:cli-release` | 619 通过，临时包 smoke 通过 | 含类型检查、CLI 构建、临时打包安装，不是日常安装 |
| `npm run performance:measure -- --scenario source-control.diff` | ratchet 通过 | 5 个计数样本，Git/总子进程最大值均为 8；不是耗时比较 |
| 两条真实错误事件离线重放 | 2/2 正确失败 | 完整读取原始 JSONL，消息事件进入修复扩展和冻结 CLI；没有模型请求 |
| 真实 Pi 正常路径 | 3/3 通过 | 原始工具/assistant 事件、canonical records、文件内容和 Git diff 交叉核对 |
| `git diff --check` | 通过 | 本次 diff |

计数采样时源码标识为 `3fd8c22-dirty`，之后提交为 `bc45459`。没有修改 workload、计数器、门限或 ratchet。曾观测主机 load1 为 645.10、507.02；本次不宣称 L2/L3 耗时收益。

### 首次失败与修正

- 初始新夹具错误地把 `handleRecorderHook` 的返回合同写成 `{recorded: true}`，实际 start 返回 `{status: 'started'}`。改为核对最终 canonical record，保留参数边界与终态断言。
- 同次测试的 Node 捕获夹具出现超时；当时主机极高负载。改用项目已有的轻量 shell 捕获模式，以 NUL 分隔 argv，不用 `$*` 展平。业务用例、事件与原有超时不变。随后旧实现稳定呈现上述 6 项状态失败。
- 实现初稿的 partial 参数顺序错误被 canonical schema 拒绝；改正后超长错误用例通过。
- typecheck 发现错误事件引用了不存在的 `args.id/ts`；已改用实际 runId/错误内容的稳定哈希及现有时间戳。最终 619 项门禁在此修正后执行。

不以最终通过抹掉这些首次失败，也没有为变绿删除断言或增加 timeout。

## 真实 Pi 三轮

继续使用前次隔离的 `rate-pi` worktree。保留原来两条错误 completed 测试记录，另开 session；新记录序号为 3、4、5。

| 轮次 | 原始终态 | 工具数 | 轮次 diff | discovery 候选数 |
| --- | --- | ---: | --- | ---: |
| 只读 before | stop | 1 | 空 | 0 |
| 修改并读取 after | stop | 2 | 仅测试文件 +1/-1 | 1 |
| 再次只读 after | stop | 1 | 空 | 1 |

三轮 canonical 状态均 completed，工具均成功，errors 为 available + 空数组。每轮 verify 通过；独立会话 summary 为 3 轮、3 completed。只有测试文件相对 fixture 发生修改。

原始消息报告模型为 gpt-6-astra。选择它是因为内置 Pi 的本地模型列表包含该模型，且前次 Codex 已实际使用；没有重试已知不被账号支持的 gpt-5.4-mini。未核验账单金额，不把 SDK 的费用字段当作权威账单。

失败路径采用原始事件离线重放，不声称本次又向 Provider 发起了真实失败请求。成功路径是实际模型调用，不是 replay。

## 产物与现场

私有目录：

`/private/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-real-cli-ghlr5npw/terminal-fix`

- `manifest.json`：冻结源码、45 文件哈希、原两条记录哈希。
- `cli/`：本次实际测试的候选 CLI；版本标签仍为 0.2.50，不等于已安装的 ACK-only 同版本包。
- `replay-results.json`、`replay-1/`、`replay-2/`：失败重放与 canonical records。
- `happy/`：真实三轮 intent、原始事件、进程状态、verify、summary。
- 日志位于 `/tmp/scry-cli-multirepo.AVEdj0/pi-terminal-*.log`；计数报告为 `pi-terminal-performance/measure.json`。

修复扩展 SHA256：`05709b18a0042b484e1e7c8d959d9aa321dfb38ecd808637e6d6a67ee14c0c37`。

结束时 45 文件哈希与原两条记录哈希均未变，三个真实 Pi 启动 PID 均退出。临时依赖链接已移除，私有测试现场保留，不上传。

## 尚未交付到日常环境

- 已安装扩展仍是旧 SHA256 `5dc08cc80cf8ac2c3189d336868157f9759bd31160bd2b225c7885b792ea9bad`。**日常 CLI 尚未获得此修复**；整合、版本安排与安装需用户另行授权。
- 当前 PATH Pi 1.2.0 的主题启动问题未改；真实验收范围仅为内置 Pi 1.3.0-rotom.2。
- Qoder 的 EPERM 仍需用户恢复登录读取；Codex 默认 worktree Hook 自动发现仍待独立处理，不能把前次临时配置当产品修复。
- 未做历史记录回写、App 验收、完整业务工作流或全仓 unit。历史缺号调查继续暂停。
