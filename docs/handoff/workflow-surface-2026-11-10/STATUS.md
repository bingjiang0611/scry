# 第二轮已核验（审查方 2026-11-11）

第二轮（G1–G5，不用 Claude，改用 OpenCode / Codex / Qoder / Pi `rotom`）已在本机完成并 push，总结见 [reports/SUMMARY-R2.md](reports/SUMMARY-R2.md)。G1 的四个 Provider 里 Codex、Pi 原生、OpenCode 有真实运行证据，Qoder 与 Pi `rotom` 标为阻塞；G2、G3、G5 完成；G4 部分完成（缺一个带真实 workflow 行的会话）。第一轮的「全部待核验」结论保留在下方。

## 第一轮

执行方已在 macOS 本机完成本轮能做的部分并 push。**B 被外部 Provider 阻塞**（公司网关持续 429），因此 C 的运行态截图、E2 文案核对、Q1–Q11 未完成。下面的「待核验」表示执行方已做完并 push，等审查方核验；「阻塞」「部分完成」「未开始」都是未完成项，不要当成通过。总结见 [reports/SUMMARY.md](reports/SUMMARY.md)。

| 包 | 条目 | 状态 | 报告 | 备注 |
|---|---|---|---|---|
| A | macOS 环境与基线 | 已核验 | [reports/A.md](reports/A.md) | 全部命令退出码 0；`ef8d455d`。本机终端安全软件会拦截直接拉起的 claude；**不得用 shim 绕过**，见下方审查结论 |
| B | 真实事件核对，Q1 到 Q11 | 阻塞 | | 公司网关对 `claude-sonnet-4-6`/`claude-opus-4-6` 持续 429“模型提供方限流”（证据见 reports/B.md），其他模型名 400/404；等待网关恢复后立即开跑 |
| B | 真实夹具与回放测试 | 未开始 | | |
| C | 真实 App 验收与截图 | 部分完成 | [reports/C.md](reports/C.md) | 真实 App 已覆盖：完成态、真实退出再启动、窄宽/窄窗口/宽窗口、Agents 标签页、切到无 Workflow 行的会话再切回；运行中/失败/停止等真实运行态被 B 阻塞 |
| D | 归档回放冒烟与负对照 | 已核验 | [reports/D.md](reports/D.md) | `npm run test:workflow-archive` 正向通过，启动两次（含真实退出重启）；负对照（去掉 workflow 去重键）失败；回放发现并修掉“活动行先到 → 两个运行”“已观测到调用却说没有”两个缺陷 |
| E1 | 从聊天区打开面板 | 已核验（审查方补修一处） | [reports/E.md](reports/E.md) | 卡片入口 + focus store 选中本次运行；`ChatView` 漏传回调已补，负对照失败过 |
| E2 | 文案以实测为准 | 阻塞 | | 依赖 Q8 与 B 的实测事件；空态与“来自某事件”的措辞已按现有代码可证的部分核对过 |
| E3 | 脚本不可得时的说明 | 部分完成 | [reports/E.md](reports/E.md) | 脚本不可得两种说明有测试；阶段无独立声明时不再把合成 `phase N` 说成已声明，改成正文可见提示；真实“按名称运行”待 B |
| E4 | 大规模运行的上限与耗时 | 已核验 | [reports/E.md](reports/E.md) | 1,000/3,000 agent 夹具；128 行/事件、2,048 行、48 chip、300 日志均有断言；归一化 9ms、40 次重折叠 24–42ms，无需增量折叠 |
| E5 | 用量不重复计算 | 已核验（真实语义待 B） | [reports/E.md](reports/E.md) | 总量/分析/落盘只认 `harness/result`；面板任务级用量单独展示，测试用 26,600 vs 1,200 证明不双计 |
| F | macOS 全量门禁与总结 | 部分完成 | [reports/F.md](reports/F.md) | `test:renderer:ui` 通过；`pack:artifact`（打包+产物校验+Electron 冒烟）通过；`pack` 整体因本机 5,000ms 超时用例为 1，已用 `origin/main` 对照证明与本次改动无关；未安装到 /Applications |

## 第二轮（不用 Claude）

维护者决定先用 OpenCode、Codex、Qoder、Pi `rotom` 验证。做法见 [R2.md](R2.md)。这一轮不能回答 Q1 到 Q11，B 仍阻塞。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| G1 | 四个 Provider 的真实事件负对照，含与 main 的对照 | 完成（两处阻塞） | [G1](reports/G1.md) · [Qoder 部分](reports/G1-qoder.md) · [OpenCode 部分](reports/G1-opencode.md) | Codex 真实两个子 Agent，与 `origin/main` 逐项一致、`workflow_activity` 0；Pi 原生空态正确；OpenCode 换到支持范围内 1.18.31 后跑通真实一轮、空态正确。**阻塞**：Qoder 在分支与 main 上同样 exit 42（仓库外同 SDK 复现），本机 2.2.6 的 OpenCode 405，Pi rotom 安装缺 `model-catalog.mjs` |
| G2 | 运行选择被拉回的组件级回归与负对照 | 完成 | [G2](reports/G2.md) | `test:workflow-ui` 新增 `focus` 模式，两个宽度通过；删掉清空请求那一行后真的失败 |
| G3 | 在最新 HEAD 上重跑门禁 | 完成（两处环境失败） | [G3](reports/G3.md) | `typecheck`/`build`/`test:workflow-ui`/`test:workflow-archive`/`test:renderer:ui` 在 `1e41d87c` 上 EXIT=0；`pack:artifact` 失败但 `origin/main` 同样失败（共享 `node_modules` 被别的进程改动）；`test:unit --maxWorkers=1` 7 个失败全是压力下 spawn 超时，两个文件单独跑都通过 | |
| G4 | C7 与相邻路径收尾 | 部分完成 | [G4](reports/G4.md) | 一个实例里 Codex（2 子 Agent）与 OpenCode（0 工具）来回切，Workflow 标签一直开着：切到 B 空态无残留，Agents 按会话分开，切回 A 两个子 Agent 恢复。带真实 workflow 行的会话无法在同一实例里造出来（Claude 阻塞），运行态残留未验证 | |
| G5 | 其他 Provider 接入的设计说明（不实现） | 完成（仅设计） | [G5](reports/G5.md) | Pi `kind: workflow` 能撑「运行 + 步骤 + 终态」，撑不起「阶段 + 每 agent 用量」；Qoder 缺真实事件不能开工；列出三条不许做的事与成本估计，未改代码 | |

## 审查方对第二轮的核验（2026-11-11，Linux x64 容器，Xvfb，非 root，Chromium 沙箱开启）

核验对象：`0425137a..e77c8ee8`（6 个提交，身份符合 CLAUDE.md）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 个错误 |
| 本轮新增的两条用例与 focus store 测试 | 26 项通过 |
| 既有 Qoder 适配器测试 5 个文件 | 148 项通过 |
| `scripts/workflow-surface-ui-smoke.mjs`，含新的 focus 模式 | 通过 |
| focus 模式负对照：保留未消费的请求 | 失败，报“流式更新把选择拉回”，恢复后通过 |
| 报告与证据中的内部地址、账号、个人路径 | 未发现 |

审查方更正：

- **G1 结论过度**：Codex、Pi、OpenCode 不经过本分支改动的归一化代码，只有 Claude 和 Qoder 经过。共享入口的回归只有合成证据，真实 Qoder 事件仍缺。已在 G1 与 SUMMARY-R2 加注。
- **G5 能力矩阵**：后台任务卡片只有 Qoder 和 Pi，原表写成五个 Provider 都有。已改。
- **证据目录**：两轮的截图和事件统计都提交到了仓库根目录 `evidence/`。已移到本交接目录下，报告里的相对路径因此变为正确。

结论：G2、G3 已核验。G1 对 Codex、Pi 原生、OpenCode 1.18.31 的空态结论成立，对共享入口的结论按上面更正。G4 部分完成，G5 设计说明可用。Qoder、Pi `rotom`、OpenCode 2.2.6 的阻塞都有归因，不是本分支引入的。

## 审查方核验结论（2026-11-10，Linux x64 容器，Xvfb，非 root，Chromium 沙箱开启）

核验对象：执行方推送的 `c8e47425..aad84eff`（13 个提交，身份均符合 CLAUDE.md）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 个错误 |
| 执行方新增与相邻的 17 个测试文件 | 458 项全部通过 |
| `scripts/workflow-archive-smoke.mjs`（真实 App，含真实退出再启动） | 通过，两次启动的阶段、agent、终态一致 |
| 上项负对照：去掉 workflow 去重键 | 失败（面板无阶段），恢复后再通过，与 D 报告一致 |
| 本次改动的文件大小 | 均不超过 20,000 字节 |

审查方补修：

- **E1 选择被拉回**：从聊天卡片打开面板后，请求一直留在共享 store 里。面板在每次流式更新时重跑选择逻辑，用户在运行选择器里手动换一次，下一次更新就被拉回卡片对应的运行。改为请求生效一次即清空，未加载的运行仍保持等待。测试在 `src/renderer/workflow-focus.test.ts`。这两个用例测的是 store 的消费语义，组件层没有 DOM 测试工具，未做组件级回归。
- **公开仓库里的内部信息**：仓库是公开的。B 报告写了公司内部网关地址和错误码，A 报告写了终端安全软件的产品名。已从分支头移除，历史提交 `c8e47425`、`a9ace643` 里仍有，是否改写已推送历史需要维护者决定。另：`main` 上原有的两份发布记录也写了公司内部 npm registry 地址，不属于本分支，另列待办。

不采用的做法：

- **用 shim 绕过终端安全软件**（A 报告）。这是绕过公司安全控制。B 恢复前须先向公司 IT / 安全确认 Claude CLI 是否获准在这台机器上运行，并使用获准的启动方式。
- **每 90 秒轮询公司网关数小时**。网关明确返回资源紧张，持续轮询只会加重共享资源压力。等维护者确认通道可用后再跑，不做自动轮询。

仍未验证：Q1 到 Q11 全部、真实运行中 / 失败 / 停止截图、按名称运行、真实用量语义、停止按钮对 workflow 的效果、其他 Provider 空态、macOS 上 `npm run pack` 的整体退出码。

## 已由审查方完成（Linux 容器）

| 条目 | 结果 |
|---|---|
| 数据层、投影、面板、冒烟脚本 | 提交 `09304e7b` |
| 历史恢复去重修复与回归测试 | 提交 `09304e7b`，拆分在 `3a015367` |
| 真实 workflow 运行 | 未做，交给包 B |
| macOS、打包产物 | 未做，交给包 A、F |
