# 独立 CLI 真实 Provider 验收：2026-10-22

## 结论与范围

用户授权新建 rate-native worktree，调用真实 Pi、Codex、Qoder，执行独立 CLI 三轮验证。不是完整 rate-workflow，不包含 Aone、业务上传、Scry App 或发布验收。

| Provider | 实际结果 | 边界 |
| --- | --- | --- |
| Codex 0.163.0 / gpt-6-astra | 三轮功能验证通过 | 使用隔离用户级 Hook 注册；不证明原生 worktree Hook 自动发现正常 |
| PATH Pi 1.2.0 | 启动受阻 | 内置主题解析失败，未发送模型请求；显式指定 dark 后仍失败 |
| Rotom 内置 Pi 1.3.0-rotom.2 | 验证失败 | 两次模型请求被拒绝，Scry 却记录为 completed；第三轮未执行 |
| Qoder 1.1.73 | 登录读取受阻 | 首轮返回 authentication_failed / EPERM，无 canonical record；后两轮未执行 |

**不能把本次报告或核对脚本退出 0 当作三 Provider 全部通过。** Pi 的两条 completed 记录不是成功模型轮次。进程退出码、canonical verify 与真实任务完成是不同证据。

## 冻结身份与隔离

- 候选源码：`c1c2d245e96d2f63a253f952b625eeceb8d3f24b`，包含 ACK 隔离和三项性能优化。
- 候选 CLI 标记版本仍为 `0.2.50`，不是本机 ACK-only 同版本安装包。复制出的 45 个文件按 manifest 逐文件核对 SHA256，验收后保持一致。
- Node：`v24.18.0`。
- rate-native 基线：`106dc3f8e86b6dd1ee1404c695ca4944719b4edf`。
- 三个独立 worktree；测试配置提交后均 clean，再运行模型。各自只放一个测试文件 `scry-cli-probe.txt`。
- Pi / Codex / Qoder 的 fixture commit 分别为 `7337c538b4468dd9eb38a858f44a332124f06403`、`05d4e02a7a7397a73beb97fdfddfe93631dd68ba`、`79799e927844479561fc76e673189864c6346f8e`。
- `SCRY_RECORDER_TRANSPORT=direct`；未启动测试 daemon。测试配置无 commit callback，业务上传未启用。日常 App、daemon、records 和队列不作为测试目标。
- Codex 使用临时 `CODEX_HOME`；认证仅链接现有登录文件，未复制凭证到仓库。系统管理 Hook 保留，不使用 trust bypass。
- 本次未安装、合入、push 或发布；未修改产品代码或真实业务文件。

## Codex：真实三轮证据

原始 JSONL、canonical records、最终文件与 Git diff 独立交叉核对，不只检查进程退出码。

| 轮次 | 操作 | 真实工具调用数 | 轮次 diff | 候选路径数 | verify 记录数 |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | 只读 before | 1 | 空 | 0 | 1 |
| 2 | before → after，再读确认 | 2 | 仅测试文件，+1/-1 | 1 | 2 |
| 3 | 再次只读 after | 1 | 空 | 1 | 3 |

- 三轮共享同一真实 session；Provider 原始终态均为 `turn.completed`，工具成功，Scry 记录均为 completed。
- 第三轮保留上一轮未提交修改，因此 discovery 仍有一个候选；本轮 diff 为空。这覆盖了“工作区有改动，但本轮无新改动”的相邻路径。
- 三轮 Git capture 均为 `targeted`、`captured`、`cleanup: ok`，没有 fallback。
- Recorder 每轮 usage 等于 Codex 原始累计 usage 的增量，不重复累计 resume 历史。
- 会话累计 input 185046、其中 cached input 163584；output 334、其中 reasoning 11。reasoning 不再加到 output 上。未取得权威账单金额，不推断费用或免费。
- 最终只有 `scry-cli-probe.txt` 相对 fixture 发生修改，内容为 `SCRY_CLI_PROBE=after\n`。
- 对同三条真实记录，ACK-only 已安装 CLI 与候选 CLI 的 `turns verify`、会话 `turns summary` 输出逐字节相等；两版均退出 0，读取前后 canonical record 哈希不变。
- 已安装 baseline 的 store SHA256 仍为 `3cc4cca17b82613502600d462a1bf7ee65ca9ac92f3beeb312ed96c6590a1e7b`。比较调用导出的 `runScryCli`，未重新调用模型。

### Codex 配置限制

1. `config/read` 明确指出 worktree 的信任按主仓库路径匹配。在临时 home 配置信任后，`hooks/list` 发现的 project Hook 仍来自主仓库，而不是测试 worktree 的 `.codex/hooks.json`。
2. 未授权这些业务 Hook。改用临时 home 的 `hooks.json`，把官方 recorder Hook 绑定到本次 worktree 的绝对路径。
3. 使用和实际运行相同的 `hooks.state` 参数再次检查：4 个用户级 recorder Hook 为 trusted/enabled；7 个业务 Hook 为 untrusted/disabled；11 个系统管理 Hook 保持 managed/enabled。该配置只存在于临时 home。
4. 三轮原始输出都有 `features.codex_hooks` 弃用提示；当前版本仍接受并执行 Hook。它是配置诊断，不是模型终态失败。未来应按 Provider 合同迁移到新开关，不能把本次结果当作未来版本保证。

因此，本次证明了隔离配置下的独立 CLI 真实链路，不证明默认 `scry init` 对该 Codex 版本的 worktree 自动发现已正常。

## Pi：失败必须保留

### PATH 版本启动失败

Pi 1.2.0 在 `initTheme` 抛出 `Variable reference not found: okhsl(295 50% 67%)`。首次和显式 `--use-theme dark` 的启动均退出 1，stdout 为空，未生成 record。读取到该安装源码的 dark/light 主题均含 okhsl；本次未修改或重建这个 Pi 仓库。

### 内置版本暴露记录错误

改用本机已有的 Rotom 内置 Pi `1.3.0-rotom.2`，未替换日常入口。所选 `openai-codex/gpt-5.4-mini` 被账号端拒绝：

> The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.

两次原始 assistant 事件均有 `stopReason: error`，没有工具执行。测试文件仍为 before，但两条 canonical record 都是 `status: completed`、`errors.status: unavailable`。第三轮未执行。

本次 runner 最初的逐轮门禁检查了退出码、记录数和文件状态，第一轮没有独立证明“读操作确实执行”；第二轮因文件未修改而停止。随后增加独立原始事件核对，明确判定两轮均失败。保留了首轮误判的原始结果，不能用后来脚本核对成功抹掉它。

代码定位：`packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs` 的 `message_end` 没有保留 `stopReason/errorMessage`，`agent_settled` 固定发送 `status: 'completed'`。这是代码读取与本次原始事件一致的解释，未在本任务中修复。

候选与已安装 ACK-only 的该扩展 SHA256 相同：`5dc08cc80cf8ac2c3189d336868157f9759bd31160bd2b225c7885b792ea9bad`。这段硬编码不是本轮性能 diff 新增；没有为此重新运行旧包的付费模型场景。

## Qoder：登录读取受阻

首轮退出 1；原始 assistant 带 `authentication_failed`，最终 result 即使使用 `subtype: success`，仍明确 `is_error: true`。错误为保存登录读取 `EPERM`。

没有 canonical record，测试文件未改。未自动重试、修改账户权限或重新登录；需用户先在正常终端确认 Qoder 能读取登录态，再继续本隔离验收。

## 复核与保留现场

私有目录（权限 0700）：

`/private/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-real-cli-ghlr5npw`

关键文件：

- `manifest.json`：版本、fixture、45 文件哈希、各 Provider 状态。
- `verification.json`：独立核对结果；脱敏副本见同名日期的 [JSON 报告](20261022-cli-real-providers.json)。
- `codex-evidence/`：三轮原始事件、verify/summary、有效 Hook 配置、旧新 CLI 输出。
- `pi-evidence/`、`pi-evidence-attempt2/`：PATH Pi 的两次启动错误。
- `pi-bundled-evidence/`：两次 API 错误及错误 completed 的对照。
- `qoder-evidence/`：首轮认证失败。
- 三个 `rate-*` worktree：保留配置和原始 records，不删除失败记录。

只读核对（不再次发送模型请求）：

```sh
python3 /private/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-real-cli-ghlr5npw/check-results.py
```

核对脚本首次因报告字段名错误 `candidateSource` 在写报告时退出 1；改为 manifest 的实际字段 `sourceCommit` 后通过。此前断言已执行，未重放任何模型请求，未弱化断言。

结束检查：登记的启动 PID 均已退出；三个 worktree 均没有测试 daemon 文件。Pi/Qoder 工作树 clean；Codex 仅测试文件修改。临时 home 的认证链接和测试现场保留在私有目录，不能上传该目录。

## 下一步与未验证项

- **先征得修复授权**：在 Pi recorder 扩展保留模型错误终态，补能让旧实现失败的最小回归；修复后再选择账号支持的模型做三轮。当前 PATH Pi 的主题启动问题另行处理，不替用户更新它。
- **用户恢复 Qoder 登录读取**：成功后才继续三轮，不绕过 EPERM。
- **Codex 自动接入问题独立处理**：本次临时用户级 Hook 配置不是自动发现问题的产品修复；迁移新 feature 名也未实施。
- 不宣称三 Provider 全部通过，不宣称 App、完整业务工作流、上传、ACK 重放或发布验收通过。
- 这不是性能基准或 L3 日常测量；不把真实调用耗时当作 Git/summary/verify 的加速证据。此前 Git/summary 的可靠低负载 L2 仍未补齐。
- 历史缺号调查继续暂停。
