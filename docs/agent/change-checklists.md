# scry · change-checklists

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [AGENTS.md](../../.agents/AGENTS.md)。

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

## macOS / Linux 跨平台改动

- macOS/Linux 共用业务、UI、Provider 和 recorder，不建 Linux 专属业务分支。Linux 首批目标：Arch/Omarchy x86_64、Hyprland/Wayland、pacman 包。Ubuntu aarch64 容器与 headless wlroots 验证不等于目标机验收或 ARM64 支持承诺。
- 功能、修复和依赖变更均检查跨平台影响。共享路径不得默认 `.app/Contents`、`/bin/zsh`、`⌘`、macOS 标题栏或 Keychain；复用现有平台入口，见[跨平台检查清单](change-checklists.md#macos--linux-跨平台改动)。平台独有能力须显式降级，不用空结果伪装支持。

每次改动先判断是否涉及下面的边界；纯业务改动不机械增加平台分支。

| 边界 | 优先复用 | 检查项 |
| --- | --- | --- |
| 打包路径与私有 CLI | `scripts/packaged-app-layout.mjs`、`build/scry-cli` | macOS `.app/Contents` 与 Linux `scry` + `resources/`；不硬编码单端路径、不回退全局 CLI；含空格路径与软链接需保留 |
| Shell / Provider 发现 / 终端 | `src/main/shell.ts`、`src/main/claude-locate.ts` | 保留用户已有 SHELL；无值时使用平台默认；GUI 启动环境与 CLI 启动不同，不假定 zsh 或 macOS 工具存在 |
| 窗口 / 快捷键 | `src/main/window-chrome.ts`、`src/renderer/platform.ts` | macOS 集成标题栏与 Linux 窗口装饰分开；快捷键行为和提示一致；文案仍集中管理；共同布局断言不能因 Linux 失败而跳过 |
| 凭据 | `src/main/bootstrap/remote-connections.ts` | Linux `basic_text` 必须拒绝保存；`isEncryptionAvailable()` 为 true 不足以证明安全存储；不影响纯本地项目 |
| 原生依赖 / locale | `electron-builder.yml`、`scripts/check-packaged-app.mjs` | 按目标 OS/架构/Electron ABI 重建；检查 node-pty、SQLite、资源 allowlist 与 Linux 的 `en-US/zh-CN/zh-TW.pak` |
| pacman / 桌面入口 | `scripts/check-pacman-package.mjs` | 单行非空 `pkgdesc`、运行依赖、安装脚本；保留 `desktopName: scry.desktop` 与 `linux.syncDesktopName`，文件名、`StartupWMClass` 与运行时标识一致 |

新增 macOS 专用能力（如 Dock）时明确 Linux 的不可用行为；不要借平台适配弱化 sandbox、renderer 隔离或仓库 trust gate。平台结论分别记录；Xvfb/容器 smoke 不等于 Hyprland、输入法、缩放或真实密钥环验收。命令与已知限制见 [验证与交付](verification.md#linux-验证与交付)。

## 跨表面检查清单

### 代码合同

- 使用 strict TypeScript、discriminated union、typed envelope 和明确 domain state；避免 `any` 与字符串猜测。
- 保持 semicolonless、single quote、两空格的既有风格，不做无关格式清洗。
- 复杂度留在 adapter/trust/persistence 边界；renderer 保持展示导向，recorder core 保持纯净。
- 优先扩展现有 contract、registry、store 和 projection，不建立第二套同义状态。
- 注释解释证据来源、信任边界、失败模式和为何必须如此，不逐行翻译代码。
- fail-open 只用于不应阻断用户 Agent 的观测附加路径；权限、信任、路径和发布完整性必须 fail closed。
- 先做最小真实修复，再考虑抽象；不要保留复杂度只因为它已经存在。

### 性能护栏

用户每天在等：启动、打开会话、发送/停止、流式输出、轮次结束 diff、source-control 刷新、远程目录与终端。新代码默认按下面写；确实做不到时，在注释或提交说明里写明原因。

#### 写代码时的护栏

- **不阻塞用户路径**：新代码在 main 的 IPC handler、trace 投递和 renderer 交互路径中不用同步 I/O 或同步子进程（`*Sync`、`execSync`）。非必需工作（diff、用量、指纹、目录扫描）移出关键路径，但不能因此提前提交证据：结果到达前显示“刷新中/来源时间”，recorder 仍等证据收敛。
- **不重复做**：一次刷新内不重复调用同一 git/文件/SQLite 查询；能一条命令拿到的不拆成多条；相同的并发请求合并为一个进行中的请求；大对象只 parse/stringify 一次。
- **有上限**：列表、历史、日志、IPC payload、DOM 节点和内存缓存都分页或设上限。IPC 只传本次渲染需要的数据或增量，不传整份 transcript/归档。
- **事件优先于轮询**：确需轮询时要退避、窗口不可见时暂停、同一时刻只有一个请求。
- **缓存要诚实**：缓存键包含所有影响结果的输入（cwd、revision、provider/profile、mtime 等），能失效、有上限；可能过期的数据要标出来源时间，不能当作当前事实。
- **renderer**：长列表虚拟化；流式更新按帧合并；不交替读写布局造成强制 layout；卸载时清理 listener、timer、observer 和订阅。
- **可观测**：特权 IPC 用 `handleTrusted` 注册（自动记录 `ipc.<channel>` 耗时），并在 `scripts/performance-paths.json` 映射到用户路径或列入 `excludedChannels`；`scripts/performance-feedback.test.ts` 会拒绝未分类的 channel。多阶段操作用 `new PerformanceTrace('<name>')` 记录阶段。

### Provider 或 run-control 改动

Claude 是主要路径；Codex、Qoder、OpenCode、Pi 仍是实验性路径。不要为统一 UI 假装 capability parity。

- adapter 不支持的能力返回明确的 degraded/unavailable envelope。
- run controls、审批、session、fork、model、MCP、Hook、Skill、usage 和 resume 语义逐 Provider 决定。
- Pi 没有 MCP 状态 API，就不要探测或推断。
- OpenCode 不支持某种审批模式时，不要把另一个 Provider 的选项硬塞进去。
- 切换 Provider、模型、权限模式或恢复 session 后，不能沿用不属于当前 runtime 的陈旧能力/审批状态。
- MCP 配置值与 App 自己的凭据不进 Provider 命令行参数（`ps` 对本机其他用户可见）：Claude、Qoder 用 `private-mcp-config.ts` 的 0600 私有文件传 `--mcp-config`；Codex 的静态 header 走 app-server 环境变量与 `env_http_headers`。新增传参路径或升级 SDK 时用 `*-mcp-argv.test.ts` 的参数记录器核对；做不到的逐 Provider 记为已知问题，不静默删减服务。

- Claude、Codex、Qoder、OpenCode、Pi 分别支持什么？不支持时 UI/Envelope 如何表示？
- new/resume/fork/stop/permission/question/error 是否保持 provider-specific identity？
- model、effort、permission mode 是否在恢复后显式重设，避免沿用旧 session 状态？
- CLI/SDK wire fixture 是否覆盖重复、乱序、partial、cancelled 和 unknown 事件？

### Trace / usage / evidence 改动

- 真实没有工具调用可以是 `available + []`；Provider 不提供工具证据必须是 `unavailable`，不能也显示为空数组。
- 缺失 token、cost、duration、MCP、Hook、文件或风险证据时，不显示成 `0`、绿色或“无风险”。
- 原始 transcript、Provider result、hook lifecycle、trace archive、SQLite 聚合和 `.scry` turn record 有不同权威性；合并时保留 provenance 并避免双计。
- 一次逻辑调用的 started/progress/response 是生命周期，不是多次调用。
- Provider 明确给出的 canonical usage 优先于 transcript shadow；reasoning token 不得在 total 中重复相加。

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
- 首次/变化后是否重新校验指纹并记录自动授权？仓库脚本不得弹确认窗。
- auth 是否与运行 operation 互斥？
- Hook 记录失败是否 fail open，而执行授权失败是否 fail closed？
- Pi/OpenCode/Codex/Claude 的配置格式差异是否由 adapter 吸收？

### IPC / Workspace / Terminal 改动

- preload 类型、main handler、renderer 调用和测试是否一起更新？
- sender/frame/origin、cwd、relative path、symlink、protected name 是否都重验？
- 切换项目或会话只是展示上下文变化，不得关闭或接管仍在运行的 Shell；owner/epoch 必须拒绝旧 renderer 的写入，真正关闭标签、显式重启或 App 退出才结束对应进程。
- terminal backpressure/ack、resize、close、window crash/navigation 清理是否保持？
- Renderer 是否仍不能直接访问 Node、任意 fs 或 spawn？

### Recorder / CLI 改动

`src/core/turn-recorder/` 与 `scry-turn-recorder` 必须保持无 Electron、无 SQLite、无 Provider SDK、无原生依赖。CLI 在 macOS/Linux Node 20/22/24 上独立运行，并只写工作区 `.scry/`。

- `.scry/records` 是 recorder 的 canonical 一轮一文件事实源；runtime/state/health 是恢复或观测状态。
- managed recorder 两阶段提交需要等待 Provider result、hook、diff 等证据收敛，不能悄悄降级为 rollout 近似。
- Hook 通过明确的 private CLI 绝对路径运行；App 私有 CLI 与全局 npm CLI 是两个分发面。

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

