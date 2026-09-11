# scry · change-checklists

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 最容易伤到自己的做法

1. **把 Scry 描述成沙箱。** 即使有审批、workspace 选择和 trust gate，Agent 仍可能在获批后访问 cwd 外文件或执行任意命令。
2. **把 unavailable 显示成空/零。** 这会让观测 UI 给出错误安全感和错误账单结论。
3. **强行统一 Provider。** 可选 facet 与 capability unavailable 是架构设计，不是待删除的重复代码。
4. **信任仓库里的命令字符串。** MCP、Hook、plugin 和 executable 必须 canonicalize、snapshot、hash，并在执行前重验。
5. **复用变更前的授权。** cwd、配置内容、声明顺序、executable inode/size/hash 变化都可能使旧 grant 失效。
6. **删除启动环境清洗。** 主进程会移除继承的 `CLAUDECODE`、`AI_AGENT`、`CLAUDE_EFFORT`、`CLAUDE_CODE_*`，避免嵌套 Agent 会话污染授权和 runtime；不要随意恢复。
7. **让 packaged App 回退到 PATH 中的 CLI。** App 私有 recorder CLI 必须通过 Resources 绝对路径驱动；缺失时 fail open 并报告，不要执行未知全局版本。
8. **恢复 electron-builder 默认 files。** checkout 中被 Git ignore 的 `.claude`、`.local`、日志或会话元数据可能被打进 App；显式 allowlist 是隐私边界。
9. **忘记 native/ESM 打包约束。** sandbox preload 必须是单一 CJS；`better-sqlite3`、`node-pty` 和需要真实文件的 SDK 资源必须正确 unpack。
10. **同时做 auth 与普通 Provider operation。** 遵守 `ProviderOperationGate`；同一 provider/profile 的认证与运行操作不能交叉污染。
11. **按名称批量杀进程。** 只停止 Scry 自己登记并能证明 identity 的 run/terminal/server；不要使用模糊 `pkill -f` 或目录名匹配。
12. **写入真实 `.scry` fixture。** 自动化测试使用临时 workspace/userData，不修改用户项目的 canonical records、Provider transcript 或真实 Scry DB。
13. **把 release 产物混进源码。** `dist`、generated CLI `dist` 和本机审计/会话文件不是实现真相；构建前从源码生成并由脚本验收。

## 跨表面检查清单

### Provider 或 run-control 改动

- Claude、Codex、Qoder、OpenCode、Pi 分别支持什么？不支持时 UI/Envelope 如何表示？
- new/resume/fork/stop/permission/question/error 是否保持 provider-specific identity？
- model、effort、permission mode 是否在恢复后显式重设，避免沿用旧 session 状态？
- CLI/SDK wire fixture 是否覆盖重复、乱序、partial、cancelled 和 unknown 事件？

### Trace / usage / evidence 改动

- logical call 是否按稳定 ID 聚合，而不是按原始事件数计数？
- canonical result 与 transcript shadow 是否去重？
- exact/estimated/inferred/unavailable 是否从 main 一直保留到 renderer？
- 真实空值与不可观测是否区分？
- 字段缺失是否带上原因与来源？`provider.modelStatus`（observed / unobserved / incomplete / conflict）和 `turnRoleStatus` 是这类字段的基准：缺值必须有 `modelOmissionReason`，多个候选只能报 conflict，不得挑一个或反推请求模型。
- 覆盖率是否带分母？数组里只要还有 `status: 'unknown'` 的项，整段就不能宣称 available/exact（否则下游会把 `failed=0` 读成「全部成功」）。
- 身份与角色是否只来自定长的结构化入参？固定文案前缀、正则和 prompt 文本不是身份边界。
- live trace、history archive、turn record、SQLite projection 是否不会互相冒充权威？

### MCP / Hook / plugin / Skill 改动

- canonical cwd、配置内容、声明顺序、executable identity 和 hash 是否进入 fingerprint？
- 首次/变化后是否重新确认？
- auth 是否与运行 operation 互斥？
- Hook 记录失败是否 fail open，而执行授权失败是否 fail closed？
- Pi/OpenCode/Codex/Claude 的配置格式差异是否由 adapter 吸收？

### IPC / Workspace / Terminal 改动

- preload 类型、main handler、renderer 调用和测试是否一起更新？
- sender/frame/origin、cwd、relative path、symlink、protected name 是否都重验？
- terminal backpressure/ack、resize、close、window crash/navigation 清理是否保持？
- Renderer 是否仍不能直接访问 Node、任意 fs 或 spawn？

### Recorder / CLI 改动

- Core 是否仍可在无 Electron/native module 环境构建？
- Node 20/22/24、macOS/Linux 是否都在支持范围？
- open -> closing -> committed fencing、duplicate Stop、recovery、global sequence 和 corrupt record 是否有测试？
- `.scry` 无配置时 fail closed，不自动初始化/执行仓库 Hook？
- App 私有 CLI、全局 CLI、Pi integration 和 versioned docs 是否同步？

### UI 改动

- 对话、右侧 Overview、Analytics、Diagnostics、MCP Trust、workspace/terminal 表面是否使用同一证据语义？
- unavailable/partial/unknown 是否有明确视觉和说明，而不是被隐藏？
- dev preload/main/renderer 版本短暂不一致时是否可恢复而非黑屏？
- 高频 stream 是否有界，避免每 token 导致全树重绘或同步 Markdown 重算？

