# 总结

本轮在 macOS 本机执行了 A、D、E1、E3（部分）、E4、E5、C（部分）、F（部分），**B 被外部 Provider 阻塞**，因此 C 的运行态截图和 E2 文案核对也没有完成。所有已 push 的改动都是「待核验」，不是「已验收」。

## 每个包的结论

| 包 | 结论 | 关键证据 |
|---|---|---|
| A 环境与基线 | **完成，待核验** | `reports/A.md`：typecheck / build / build:cli / check:harness-bindings / test:workflow-ui 与 7 个相关测试文件全绿；记录本机 EDR 会 SIGKILL 直接拉起的 `claude`，B 需用 shim |
| B 真实事件核对 | **阻塞** | `reports/B.md`：唯一 Claude 通道（公司网关）对仅有的两个可用模型持续 429，3 小时 100+ 次请求无一次成功；本机无官方凭据、无历史真实 workflow 记录 |
| C 真实 App 验收 | **部分完成** | `reports/C.md` + `evidence/screens/`：完成态、真实退出再启动、渲染进程重启、面板最窄 / 窗口 900px / 1600px、Agents 标签页、切到无 workflow 的会话再切回、从聊天卡片进入，全部由 `npm run test:workflow-archive` 真实驱动；运行中 / 失败 / 停止缺真实运行 |
| D 归档回放与负对照 | **完成，待核验** | `reports/D.md`：`npm run test:workflow-archive` 通过且启动两次真实进程；负对照（去掉 workflow 去重键）失败；回放发现并修掉两个真实缺陷 |
| E1 聊天卡片入口 | **完成，待核验** | `reports/E.md`：新增入口 + 外部 store 选中运行，`ChatView` 漏传回调的根因修复有先失败后通过的测试 |
| E2 文案以实测为准 | **阻塞** | 依赖 Q8；同时依赖 B 的实测事件 |
| E3 脚本 / 阶段不可得 | **部分完成** | `reports/E.md`：脚本不可得的两种说明已有测试；阶段没有独立声明时原来把合成标题说成已声明，已修并改成正文可见提示 |
| E4 大规模运行 | **完成，待核验** | `reports/E.md`：1,000/3,000 agent 夹具；行数 / chip / 日志 / 上限都有断言；归一化 8–9ms、40 次重折叠 24–42ms，不需要增量折叠 |
| E5 用量诚实 | **完成，待核验** | `reports/E.md`：任务级 26,600 tokens 不进 `analyzeBilling`（只 1,200），面板单独展示并带说明 |
| F 门禁与总结 | **部分完成** | `reports/F.md`：`test:renderer:ui` 通过；`pack:artifact`（含 `check:packaged-app` 与 `smoke:electron`）通过；`pack` 整体因本机 5,000ms spawn 超时拿不到 0，已用未改动 `origin/main` 对照 + 放大超时后 11/11 通过证明与本次改动无关 |

## Q1–Q11 的一句话答案

**全部未回答**。需要真实 Claude Code workflow 事件，而 B 拿不到模型。`reports/B.md` 里已经准备好：探针、事件日志对照脚本（`scripts/workflow-wire-compare.mjs`，含两次负对照）、场景清单和落地顺序。模型可用后按那份清单即可补完。

## 本轮真正修掉的产品缺陷

| 缺陷 | 影响 | 发现方式 |
|---|---|---|
| 活动行先于 `tool_use` 到达时，面板出现第二个「状态未知」运行 | 用户看到两次运行，其中一次凭空出现 | 归档回放断言 DOM |
| 同一次运行被任务行先建出来时，面板仍写「已加载的历史里没有对应的 Workflow 工具调用」 | 界面与聊天卡片自相矛盾 | 归档回放截图 + 断言 `data-observed` |
| 阶段声明行没有标题时仍标记为「已声明」 | 把合成的 `phase N` 说成真实标题 | 新增夹具测试 |
| 聊天卡片入口按钮硬编码 `999px` 圆角 | 违反 renderer radius 契约（全量门禁失败） | `npm run pack` 的 `radius-system` 测试 |
| `ChatView` 丢掉了 `onOpenWorkflow` 回调 | 聊天卡片点击后不打开对应运行 | 写测试时先失败 |

## 仍未验证的项

- **所有真实 Provider 行为**：Q1–Q11、运行中/失败/停止截图、真实按名称运行、用量是否与真实账单一致、停止按钮对运行中 workflow 的真实效果。
- **其他 Provider 空态**（C7）：本机装了 pi/codex/opencode/qoder，但冒烟用的临时 userData 没有注册，未在测试实例里打开过。
- **`npm run pack` 整体退出码**：本机超时用例导致 1（串行也一样 5 个）；打包段单独通过，放大超时后这 5 个用例 11/11 通过。
- **`test:renderer:ui` 与 `pack` 的证据版本**是 `db5b07be`，之后 `ccb9ea40` 的 renderer 改动只跑了 typecheck / build / 受影响单测 / 归档回放。
- **真实重启恢复的真实运行版本**：归档回放证明了「从磁盘读回」，但真实运行中还涉及未收敛的运行时状态。

## 建议维护者决定

1. **给这台机器一个可用 Claude 通道**（官方 key / 网关容量 / 指定其他合规模型），B 与 C 的运行态、E2 就能收尾。这是唯一的外部阻塞。
2. **`npm run pack` 在本机的 5,000ms 超时**：这 5 个 spawn 型用例（`check-pacman-package` ×4、`concurrency-trace-launcher` ×1）在 load average 10–15 时稳定超时，放大到 60s 后 11/11 通过，未改动 `origin/main` 上同样超时。是否按机器能力显式调高这几个用例的超时（属于放宽门禁，需要你批准），还是接受本机只能拿到「单测段 5 个超时 + 打包段通过」的证据。
3. **`docs/cli-team-rollout-readme-drafts/`** 未跟踪文件不是本轮产物，按约定没有动。
