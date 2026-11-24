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
