# 待办（维护者 2026-11-23 记下，以后处理）

不在当前任务单里、但不能忘的事。处理完一条就删掉一条，或者标注完成日期。

## P6 会话与分支

- [x] **P6 暂停收尾**（2026-11-23 完成）：报告改名为 `reports/P6.md`，迁移点写进 `reports/P6-resume.md`，推到 `feat/p6-multi-agent-orchestration`（`8e074006`）；PR #178 已改为草稿，标题加了「暂停」。维护者把本地那个 P6 会话关掉即可。
- [ ] **冻结 `feat/p6-multi-agent-orchestration`。** P6-0 到 P6-6 已实现，还没合并。W20 做完之前不要合进 main，PR #178 保持草稿。注意：这个分支的 App 主进程模块数是 193，超过 192 的上限，恢复时要压回去。
- [ ] **W20 做完后恢复 P6。**
  1. 把 main 合进这个分支。
  2. 按 W20 的几项适配：C1 常驻 ProviderSession、D1 持久队列、D3 谱系入库、D4 元数据以事件为准。
  3. 按分支上的 `reports/P6-resume.md` 逐条迁移；把 [V2-alignment](../V2-alignment.md) §E 列的三条规则补进 P6 设计：提问只唤醒父会话一次、同级子任务的结果批量送达、DispatchModeLimit。
  4. 重新做独立评审，再走一遍 L3 验证。

## 合并与分支

- [ ] **把 `chore/v3-cleanup-timing-and-ledger-mirror` 合进 main。** 这个分支删掉了计时允许列表里 v2 的旧接口名，并把 `shadow-mirror` 改名为 `ledger-projection-mirror`、`shadow-routing` 改名为 `ledger-intent-routing`，共 17 个文件。合并后通知 W20 合一次 main，因为 W20 的 B1 也要改这两个模块。
- [ ] **统一 W20 的推送分支。** 它现在推到 `exec/W20`，任务单写的是 `claude/scry-performance-optimization-46ngcf`。二选一，核验时以选定的那个为准。

## 真机与部署

- [ ] **v3 的 iPhone 真机验收。** 按 W19 任务单的 C 组做：
  - 旧版手机连上来时的提示画面；
  - 新版手机的实时更新、分页和断线重连；
  - 临时会话撤回；
  - 手机离线期间的执行端通知；
  - 经手机转发到 mac2、mac3。
- [ ] **mac2 的签名打包。** 在 mac3 的图形界面里跑一次仓库的签名入口，钥匙串弹窗时选「始终允许」。之后再做 mac2 的冒烟。
- [ ] **三台 Mac 升级到最新 main。** 包含 #175 和 #177：外部会话不再列进侧栏，已经列出来的行会被清掉。三台必须是同一个签名包。

## 机器管理（#187 已合入 main，2026-11-24）

- [ ] mac2、mac3 各打开一次「机器」页，和「活动监视器」对照：CPU 差在 10 个百分点以内，内存压力级别一致。
- [ ] W20 完成后接上两项：排队数（读 `orch_p_run`）；Provider 根进程，按 run 链路暴露的根 PID 归属，替代现在按可执行名的识别。之后再做 P8 §8 的第二版。
- [ ] W20 合一次 main，main 里已经有 #187。

## W20 延后项（维护者 2026-11-25）

- [ ] **Claude 常驻会话**（V2 对齐 C1 的 Claude 部分，连同 C5 空闲压缩、C3(c) Claude 后台任务停止）：W20 期间执行机没有安装 claude，无法验证，所以先跳过。等有一台装了 claude 的机器再单独做：用流式输入的 `query()`，配合 `setModel`、`setPermissionMode` 和会话池；做完后用真实 Provider 测首 token，和改动前对比。
- [ ] **B1 遗留的两个 kind**：`conversation.writeback` 跟 D4 一起实现，由 worker 把事件写回会话文件。`catalog.*` 如果到时还没有生产者，就从 effect-policy 里删掉。

## W20 合入后（#204，2026-11-25）

- [ ] **Qoder 复用与记录器**：App 默认开着 managed recorder，记录器身份在启动 CLI 时以环境变量按轮注入（`SCRY_MANAGED_RUN_ID` / `SCRY_MANAGED_PROMPT_HASH`），所以 Qoder 每轮新起进程、不复用。要用上常驻会话的提速，需要让记录器能按会话拿身份，或者在同一进程内切换身份。
- [ ] **Qoder 第二轮首段文字重测**：当日额度用完，没测成。额度恢复后在同一个临时 HOME 重测，分别测记录器开和关两种情况。
- [ ] **C 组剩余项**：C3(a) Pi/Qoder 的轮次结算语义；C2 按 Provider 逐个验证原生 steer；C4 的「用户开启」目前只有环境变量，要补一个界面开关。

## 记录器移出 App（维护者 2026-11-25 定方向）

- [ ] **W23**：把轮次记录器移出 App，见 [P10](../P10-recorder-out-of-app.md) 和 [W23 任务单](tasks/W23-recorder-out-of-app.md)。等 PR #205（Qoder Stop 归属）合进 main 后开工。原计划的「记录器按会话取身份」取消，Qoder 进程复用并入 W23。
- [ ] **W23 的发布顺序**（P10 §6）：记录器发版（含遗留托管轮次的过期规则）→ CodeLens 发版（`SCRY_CLI_PATH` 不存在时退回自带记录器，并升级自带记录器）→ App 发版，发版说明写明两者的最低版本。
- [ ] **P10 §9 来源标记**：要不要给 App 启动的会话加 `client=scry-app`，维护者待定，推荐加。
- [ ] **W24**：CLI 迁到独立仓库，补上 `exports` 契约、深层路径的兼容别名和消费方测试（trade-telemetry 现在用的是 `dist/cli/*.js` 和 `dist/core/turn-recorder/commit-environment.js`），并解决记录器对 `src/main/normalize`、`src/main/danger` 的反向依赖。需要维护者先建好仓库。
- [ ] **W23 合并后**：三台 Mac 只在这时升级一次，和上面「真机与部署」里的升级、mac2 签名、机器页对照一起做。
