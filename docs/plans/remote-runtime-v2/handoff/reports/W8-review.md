结论：需修改（2 项阻塞、12 项应修，其中 2 项需维护者决定）

# W8 核验（核验方，2026-11-20）

范围：`477fb398`（A0.5）至 `acb89e5d`（A9 脚本与报告）。复跑（Linux）：`tsc` node 与 web 通过；Provider、兼容性清单、错误分类、计费、用量、daemon、shared 共 83 个文件 899 个用例通过；`npm run check:cli-runtime` 通过（112 个文件 1222 个用例）。核验方在副本里分别破坏了独立进程组发信号、load 重放抑制、MCP 释放、工作区权限键拒绝、实验开关，对应测试都会失败，测试是真的。所有文件 < 20,000 字节；未碰 `host-process.ts`、`host-process-assembly.ts`、编排模块、协议版本与性能门限。

## 已核对、正确

- A0.5 拆分逐行比对零行为变化，6 个原模块导出集合完全相同；`turn-record.ts` 是纯搬移并重新导出。
- 实验开关覆盖注册、`KNOWN_AGENTS` 探测、远程 discovery、`listCommands`、登录时启动策略键。
- 不调用 OAuth `authenticate`；`BROWSER=/usr/bin/true`；argv 固定 `['acp']`，完全访问时加 `--dangerously-skip-permissions` 并有专属文案；`auto` 未映射。
- 环境：12 个变量与 `SSH_*` 被清洗；其余 5 家清洗 `GEMINI_`/`AGY_`/`ANTIGRAVITY_` 有测试。`maskSecrets` 仍只用于显示，原生流原样记录。MCP token 每次运行随机、在 `finally` 撤销并关服。
- 门禁对符号链接、越界 `plugins.json`、损坏 JSON、工作区权限键 fail closed。ACP 客户端 16 MiB 行上限、非 JSON 行只计数、按响应形状判定、停止时未决审批回 `cancelled`、resume 回落 load 并抑制重放。用量口径正确，`modelStatus` 为 `unobserved`，费用不记 0。

## 阻塞

- **B1 用户级权限检查可被 `GEMINI_HOME` 绕过**（核验方复现）：`antigravity-run.ts:134-135` 用未清洗的环境做检查，`antigravityGeminiRoot`（`antigravity-mcp-paths.ts:21-25`）会读 `GEMINI_HOME`；而 `GEMINI_HOME` 在传给 `agy` 时被清掉（未放行时）。于是 Scry 检查的是一个文件，`agy` 读的是 `~/.gemini/antigravity-cli/settings.json`。复现：真实设置写 `toolPermission: auto`，`GEMINI_HOME` 指向空目录，`default` 运行照常启动完成而没有被拒绝。用户级 MCP 路径、MCP 快照、Skill 列表也有同样的不一致；恢复会话标识用的却是清洗后的环境。修法：所有地方都从同一个清洗后的启动环境推出 `.gemini` 根目录。
- **B2 所有 Antigravity 运行被串行化**（核验方复现）：`enterRun`（`antigravity-catalog.ts:291-297`）拿的是整个适配器共用、给目录探测用的互斥锁，并在整次运行期间持有。两次不同工作区的运行分别在 1,563 ms 和 3,115 ms 结束，一个接一个。等待审批的运行没有超时，会无限期挡住其他运行和目录刷新；排队中的运行 `interrupt()` 无效，等到槽位后仍会启动 `agy` 并建会话（触发 SessionStart hook），之后才检查取消；权限检查、门禁与 MCP token 在排队前就已准备，检查与使用之间的时间被拉长，token 排队期间一直有效。D5 只要求目录探测不与同一 profile 的运行重叠。修法：运行与探测分开加锁；拿到槽位后再做门禁与 MCP 准备；启动前检查取消。

## 应修

1. **影响了其他 5 家的错误分类**：`error-classify.ts:18` 在共用的认证判断里加了 `'authentication required'`，例如「MCP server x: authentication required」原来归为 MCP，现在会显示 Claude 的登录提示。限定到 antigravity；另外 Antigravity 自己的「未登录…agy acp --login」没匹配 `'agy --login'`，被归为未知。
2. **审批选项被截断**：`antigravity-permissions.ts:208` 的 `.slice(0, 4)` 会悄悄丢掉第 5 个以后的选项，违反「按给出的选项原样渲染」。
3. **D4「账号未验证」标签缺失**：描述里报的是 `account: 'none'`（`antigravity-launch.ts:188`）。
4. **历史检索代理**：没有 Host/Origin 检查（`antigravity-history-mcp.ts:47-52`，Bearer 有缓解）；`NO_PROXY` 只从 `process.env` 构造并覆盖了 shell 里的值（98-110）；SSE 响应被整段缓冲（73）。
5. **设计要求的用户文案缺失**：Google 条款提示（D1）、一 run 一进程下后台子 Agent 与 `/goal` 会随进程结束被终止、检查与使用之间的残余风险。
6. **停止路径**：在主进程停止路径上同步执行 `execFileSync('/bin/ps')`（`antigravity-launch.ts:237`），违反性能护栏；`process.kill(-pgid)` 会把信号发给后代所在的整个进程组，包括身份未核实的成员（273-276）；根进程还活着时，已脱离进程树的后代永远不会被强杀（368-370）。
7. **缺测试场景**（夹具支持但没写测试）：取消后收到 `end_turn`、取消后收到 JSON-RPC 错误、尚无 `sessionId` 时停止、`-32603 No browser`、运行中出现登录提示行、ADC 认证、关 stdin 后的自然退出宽限、PromptResponse 之后的尾随更新、由 `RunStopLifecycle` 驱动的运行内升级；计费与用量修复对 Antigravity 空费用也没有测试（报告里计入的 `usage-ledger-repair.test.ts` 并不存在）。
8. **记录的有效权限可能偏低**：`run.ts:323/356/381` 只要设置的级别大于 0 就记设置的标签，即使所选档位更高（如完全访问加一条 `permissions.allow`，记成 `permissions.allow`）；取两者较高者。
9. **费用来源标错**：`billing-ledger.ts:147-157` 把缺失费用的行标为 `sdk_estimate`/`inferred`，实际没有估算；费用仍为 null，其他 Provider 不受影响。
10. **`partial`/`unobserved` 没人消费**：只存在 `runtimeMetadata`（`antigravity-usage.ts:151-162`）里，下游不读，界面把 token 数显示成完整的（Pi 也是这种模式）。
11. **Pi 行为变化未说明**：`mcp-config.ts:138` 的 `pi → []` 让 Pi 的实时与认证 MCP 检查不再扫描 `opencode.json`，大概率是修 bug，但无测试、未写进说明。
12. **需维护者决定**（见下）：hook 能绕过审批；用户级 `permissions.allow` 规则如何处理。

可选：两个新的导入环（`turn-record.ts` ↔ `turn-record-validate.ts`、`billing-ledger.ts` ↔ `billing-ledger-admin.ts`），把共用函数挪到叶子模块；`cachedShellPath` 未使用的导出；`acp-client.ts:167` 用 `close` 代替 `exit` 以免 stdout 未读完；登录提示的匹配太宽（"sign in"），一旦触发会把之后的错误都标成「未登录」；兜底的空浏览器脚本用可预测的 `/tmp` 路径；A9 的 launchd 脚本把可能含凭据的代理变量未转义写进 plist；CLI 的记录校验接受了 `antigravity`，对已有 Provider 无影响。

## 需要维护者决定

- **用户级 `permissions.allow` 规则**：维护者本机的 `~/.gemini/antigravity-cli/settings.json` 有 2 条 `permissions.allow`。按现在的 D3 实现，这台机器上只有「完全访问」能启动 Antigravity，与「终端能用、Scry 就能用」相冲突。
- **hook 放行**：工作区 `hooks.json` 的 PreToolUse 返回 `decision:"allow"` 可以不经询问放行工具（已进指纹、按 2026-09-21 策略自动授权）；用户级 `~/.gemini/config/hooks.json` 不在 D3 的考虑范围内。
