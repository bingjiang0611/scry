# Pi / Rotom 适配复查（2026-09-16）

## 范围与判断

检查了近期 Pi 修复、当前工作区的 adapter、Profile 发现/保存、IPC 调用点、历史 evidence enrichment、recorder 交接及停止编排。不是全仓库审计，也不是全部 Provider 功能验收。

最值得先收敛的是重复启动和生命周期，而不是把 `pi.ts` 机械拆成更多文件。Rotom 仍使用 `pi_rpc`，但 launcher 的 Node 合同应独立处理。

调用链：

- `index.ts` 的 installed/stored Profile 发现、添加 → `piRpcEnvironment` → 版本探测。
- `ProviderRegistry` → Pi skills / commands / runControls / 必要时 history enrichment → `probePiAgent` → 无会话、offline RPC。
- new/resume/fork → 相同环境解析 → 独立 RPC；run 在 prompt 前冻结 entry baseline 并建立 managed lifecycle，接受后取得 authoritative user entry，等待 `agent_settled`。
- interrupt / forceKill → adapter 持有的进程 → RPC close → main 的 run settlement。

## 本次优化

1. **统一异步 Node 解析**：删除同步/异步双实现；扫描、添加 Profile 和 RPC 启动复用同一入口。Node/version-manager 子进程也使用清洗后的环境，不再继承原始管理员凭证。
2. **保留 launcher 差异**：Pi 最低 23.6；Rotom 最低 24，优先尊重 `ROTOM_NODE`，不把旧 `PI_AGENT_NODE` 当作 Rotom 的显式选择。用户明确配置不被静默替换。
3. **只复用进行中的探测**：key 为 Profile id + executable + cwd。并发 skills/commands/runControls fixture 从 3 次启动降为 1 次；成功/失败后立即删除，下次刷新重新读取，避免缓存过期 trust 或模型状态。探测与 fork 首个命令使用冷启动期限。
4. **启动与停止边界**：Profile/Node 解析期间停止不再启动进程；创建 recorder 前和发送 prompt 前检查停止。已建立但确定尚未发送 prompt 的 provisional lifecycle 按精确身份撤销；已发送但 transport 结果未知的路径仍保留，不能冒充取消成功。
5. **关闭以进程证据收敛**：持有 close receipt，避免错过已退出进程后仍等固定超时；stdin 错误进入 transport failure。EOF、SIGTERM 各等待最多 750ms，仍不关闭则 SIGKILL，再等待最多 750ms；无法确认时明确报错，不返回成功。forceKill 也结束 pending RPC。

保留既有 `--approve/--no-approve` 不注入策略、full_access 显式门槛、`agent_settled`、authoritative entry cursor、历史 evidence 已足够时跳过探测，以及工作区已有的大消息/停止尾部查询改动。

## 验证

- 新增 `src/main/providers/pi-lifecycle.test.ts`、`pi-environment.test.ts`：覆盖并发复用、workspace/Profile/executable 隔离、失败后刷新、Profile/Node/初始化/recorder 打开期间停止、顽固进程真实退出、Node 门槛/覆盖项、环境清洗和事件循环让出。
- 工作区版本的 adapter、发现、Profile、registry、fork boundary、stop lifecycle 共 8 个测试文件、91 项测试通过，typecheck/build 通过。随后追加了 forceKill 立即 reject pending RPC 的一行修正，该修正在隔离快照的顽固进程用例通过，但最终工作区全套未重跑。执行命令：

  ```sh
  npx vitest run src/main/providers/pi-lifecycle.test.ts src/main/providers/pi-environment.test.ts src/main/providers/pi.test.ts src/main/claude-locate.test.ts src/main/pi-agent-profiles.test.ts src/main/providers/registry.test.ts src/main/providers/session-fork-boundary.test.ts src/main/run-stop-lifecycle.test.ts
  npm run typecheck
  npm run build
  git diff --check
  ```

- 本机只读启动：Pi 0.85.1、Rotom 0.1.7，Node 24.18.0；使用当前源码生成的环境，在临时 HOME/config/session/cwd 下运行 `--version` 及 `--mode rpc --no-session --offline`。两者 `get_state` / `get_commands` 均成功且退出码 0。未发送 prompt、未使用真实会话、未调用收费模型。
- 没有真实 App 多轮发送/停止重放；没有验证 15 秒以上的大型原生历史冷启动，也没有验证跨平台/其他 Pi 版本。构建与离线启动不等于这些场景通过。
- **独立提交快照未通过**：从 HEAD 中只投影本次改动、排除既有 WIP 后，86 项测试中 8 项失败（启动超时及 Node 探测超时后的断言），后续 typecheck/build 因 `&&` 未执行。当时主机 load average 为 412.46，且该快照保留 HEAD 的 Node 1.5 秒探测期限，工作区已有修复为 5 秒；不能据此判定唯一根因，也不能用工作区通过替代快照验证。相关测试进程已退出，未盲目重跑或扩大超时。
- 暂未提交：后续应先确认 Node 探测期限与本次异步迁移的必要依赖边界，再在低负载下验证精确提交快照；不能混入用户的其余 WIP。

## 明确保留的后续问题

- **usage 缺失被累计为零**：`addAssistantUsage` / result 仍有 `?? 0`；尚未收到 assistant usage 的停止可能输出零 token。下一次 evidence 修复应区分未观察、明确零及部分缺失，覆盖 result、model rows 和 recorder 聚合，不能只隐藏 UI 数字。
- **Profile 解析仍可能重复版本扫描**：RPC 并发合并不等于合并 `index.ts` 上游 discovery。若测量显示这里仍是瓶颈，应复用发现层的进行中任务；不要加永久 capability 缓存。
- 关闭验证针对 Scry 启动的 RPC 子进程及其管道；不承诺审计/约束脱离进程组的后代，Scry 不是安全沙箱。

本次没有引入依赖、长期缓存、权限降级或 renderer 特权；没有提交、升版本、安装或推送。工作区已有改动保持原位，临时提交索引没有应用到真实 Git index。
