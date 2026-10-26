## 手验记录

执行日期：2026-10-25（以下日志时间均为 UTC）。**本节只验证 A 基线，不包含 B 或 V3。** 真实 OpenCode / Qoder / Codex 均已完成 A-1～A-4 的请求；成功收敛后的证据满足记录、fail-open、missing_start orphan 和恢复要求，但 **OpenCode/Qoder 并非终态后立即落盘**，见宽限期说明。V3 仍交审查方核验。

### 身份、隔离与原始命令

- 独立 detached worktree：`/tmp/scry-A-manual.dx5bmD/source`，HEAD `a21110c4fdf5cb8e938eeda24c42c7c7e462f9ba`。
- 在该 worktree 执行 `npm run build:cli`，退出 0；构建日志 `/tmp/scry-A-manual.dx5bmD/build.log`。依赖复用现有 node_modules 链接，源码/编译产物均来自该 worktree；`git diff a21110c -- src packages` 为空。未调用主工作区含 B/V3 的 CLI。
- CLI 入口：`/tmp/scry-A-manual.dx5bmD/source/packages/turn-recorder-cli/dist/cli/scry.js`；`--version` 输出 `0.2.51`、退出 0；SHA-256 `5b467ffb79cfc6b2c2cf3dfaa8a442ba0618330eac519108bc51ea7e00b4836b`。
- Node v24.18.0、macOS arm64；Provider 实际版本 OpenCode 1.18.31、Qoder CLI 1.1.73、Codex CLI 0.164.0。没有安装分支 CLI 到日常环境。
- RUN=`/tmp/scry-A-manual.dx5bmD`，权限 0700。三个正式临时仓库分别为 `$RUN/opencode-authorized/workspace`、`$RUN/qoder/workspace`、`$RUN/codex/workspace`；每个有独立 HOME、TMPDIR、XDG config/data/state/cache。失败的首次 OpenCode 环境另保留在 `$RUN/opencode`，没有删除或覆盖其证据。
- 环境显式 allowlist：PATH、USER/LOGNAME/SHELL、LANG/LC_ALL、现有代理变量，以及隔离目录和 `SCRY_RECORDER_TRANSPORT=direct SCRY_AUTO_UPDATE=0 SCRY_NO_UPDATE_CHECK=1`。没有继承 managed recorder 状态；recorder status 均确认 running=false。
- Qoder 仅复制认证文件、模型和 region 配置；Codex 仅复制认证及选定模型，未复制日常项目 trust。OpenCode 最初配置依赖的两个环境变量缺失；用户随后批准使用 Scry 当前 Profile，按 Scry 的实际登录 shell 取环境路径，仅提取 `OPENCODE_ANTHROPIC_BASE_URL/API_KEY` 到临时环境，没有更换账号或输出密钥。
- 用户追加授权“你来帮我信任 hook”后，执行方通过 Codex 原生 TUI 的项目信任及 “Trust all and continue” 完成授权。`/hooks` 读回显示 UserPromptSubmit、PreToolUse、PostToolUse、Stop 的 Installed/Active 均为 2/2（包括原生 managed hook），已无待审项目 hook。没有使用 hook-trust bypass 或直接编辑信任记录。主机管理的原生 hook 策略仍存在，没有为隔离而关闭它。

每个临时仓库都执行了以下真实 CLI 命令；init/repair 均退出 0，首次 repair 的 rewritten=[]。下文用变量缩写绝对路径；请求正文通过本地变量/标准输入传递，不在报告中回传。

```sh
NODE=/Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node
CLI=/tmp/scry-A-manual.dx5bmD/source/packages/turn-recorder-cli/dist/cli/scry.js
# cwd 为各自临时 workspace；进程环境来自上述 allowlist
git init -q
"$NODE" "$CLI" init --providers "$PROVIDER"
"$NODE" "$CLI" integrations repair --yes

# OpenCode：每次 run 都是新会话，没有 --continue / --auto / --pure
/Users/baobingjiang/.opencode/bin/opencode run --format json "$SCRY_A_PROMPT"
# Qoder：每次新会话，未跳过权限
"$NODE" /Users/baobingjiang/.nvm/versions/node/v24.18.0/lib/node_modules/@qoder-ai/qodercli/bundle/qodercli.js \
  -p --output-format json --max-model-request-retries 0 "$SCRY_A_PROMPT"
# Codex：请求从 stdin 输入；使用已由原生 UI 信任的临时配置
/Users/baobingjiang/.local/bin/codex exec --json --sandbox read-only -

"$NODE" "$CLI" recorder recover
"$NODE" "$CLI" turns list
"$NODE" "$CLI" recorder status
"$NODE" "$CLI" doctor
# A-2，绝对路径不受损坏的 .scry/cli-path 影响：
"$NODE" "$CLI" support-bundle create --out "$PROVIDER_ROOT/logs/support-A.json"
```

A-2 实际将 cli-path 备份后写为 `/does-not-exist/scry-A`；A-3 使用前文只抑制 UserPromptSubmit 的包装器，恢复后 repair；A-4 备份配置并写入 `{invalid-json\n`，随后恢复并解析确认有效，再发新轮次。所有这些修改都只在临时仓库。

诊断采集脚本为 `$RUN/run-step.py`，实际调用为 `python3 "$RUN/run-step.py" <provider> <标签> snapshot`。它执行上述 CLI、保存每条 stdout/stderr/退出码，再提取指定字段。下面是这些**原始输出的指定字段投影**，不是完整文件阅读或记录正文；没有填猜测值。turnsList.count 是实际 list JSON 数组的长度；invalid_config 下 CLI stdout 为空、stderr 报错，计数为 unavailable/null，绝不当作 0。health 来自当时真实 health.json；缺省 lastError 用 null 表示未出现该字段。hookSkips 的 scope 一直是 retained_log_window、truncated=false；此旧版没有 recentCount。

### 逐项结论与运行偏差

| 场景 | OpenCode | Qoder | Codex |
|---|---|---|---|
| A-1 正常采集 | 最初 0/pending=1；宽限后生成 1 条，归属 A1 session | 最初 0/pending=1；宽限后 1 条 | 直接得到 1 条 |
| A-2 CLI 失效 | Provider 0 / stop；2 条 cli_not_executable | Provider 0 / success；2 条 cli_not_executable | Provider 0 / turn.completed；2 条 cli_not_executable |
| A-3 缺开始 | record 不新增，orphan/missingStartTerminals 各 +1 | 同左 | 同左 |
| A-3 同一 Stop 重放 | bridge 退出 0，计数保持 1/1 | 同左 | 同左 |
| A-4 无效配置 | Provider 0；doctor error/3 | 同左；驱动器误多发一轮，见下文 | 同左；驱动器误多发一轮，见下文 |
| A-4 真正恢复后 | 宽限后 record 从 1 增为 2 | 宽限后 record 从 1 增为 2 | record 从 1 增为 2 |
| 保存并移走历史 skip 日志后 | doctor healthy/0 | doctor healthy/0 | doctor healthy/0 |

- 所有正式 Provider 请求均正常终态：OpenCode 的 step_finish.reason=stop；Qoder result.subtype=success、is_error=false、num_turns=1；Codex turn.completed。不以进程退出码单独替代此证据。
- **宽限期**：该基线 `recorder.ts` 的 `DEFERRED_TERMINAL_GRACE_MS=180_000` 从 deferredTerminalAt 起算。OpenCode/Qoder 本次收到无可归属 provider turn ID/明确时间戳的 Stop，进入现有延迟终态路径。首次 recover/pending 是实际结果，没有隐藏。OpenCode 的 `A1-after-grace` 文件标签起得不准确：当时 startedAt 已过 180 秒，但 deferredTerminalAt 尚未过；它仍是 pending。后来 A-2 的 recover 才提交 A-1，已用 sessionId 对照证明那不是故障轮次生成的 record。A-4 最终也在真实终态宽限过后单独 recover 收敛，没有靠增加测试超时、改生产状态或伪造时间变绿。
- **首次 OpenCode 失败保留**：缺少认证环境时 Provider exit=1、UnknownError `fetch() URL is invalid`；turns list=0、pendingCount=1、hookSkips.count=0、doctor degraded/5。日志 `$RUN/opencode/logs/A1-*`。随后经用户指定认证来源，在全新 opencode-authorized 仓库验证，没有清除第一次失败。旧失败仓库的 pending 仍保留供审查，不能把它宣称为健康。
- **驱动器首次失败保留**：invalid_config 时 turns list 实际输出为空并退出 1，驱动器最初却直接 JSON.parse，出现 `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`。当时 shell 组合命令未 fail-fast，导致 Codex/Qoder 各额外执行一次仍处于 invalid_config 的请求，被误标为 `A4-restored-provider.*`。原日志完整保留；这两轮绝不作为恢复成功。修正的是临时采集脚本，读取已保存结果继续诊断，不重放已执行命令；后续组合命令启用 fail-fast，并在发出 `A4-restored-confirmed` 前解析确认恢复后的配置。正式恢复证据只取 confirmed 轮次。故这两个 Provider 的 skip 总数为 6（2 CLI 失效 + 4 无效配置），OpenCode 为 4。
- 总计 18 次 Provider CLI 调用：17 次正常终态（包括上述额外 2 次无效配置轮次），1 次首次认证配置失败。没有执行超时、自动重发或新增账号；费用以 Provider 账单为准，本次未独立核对结算金额。
- A-3 三份 orphan 均为 reason=missing_start。payload storage=complete、redaction=disabled、sourceCompleteness=unknown，savedBytes 分别为 OpenCode 383、Qoder 697、Codex 463。这里的完整只指已收到 payload 的保存，不是完整会话证据。重放使用保存的原 payload，三个 bridge 均退出 0，计数未增加；没有重建/伪造 record，也未输出 payload。
- 最终 turns list 的两条记录均按 sessionId 匹配到各 Provider 的 A1 和 A4-restored-confirmed 输出；A-2、A-3、无效配置轮次没有混成正常记录。对照结果保存在各自 `logs/final-record-attribution.json`。
