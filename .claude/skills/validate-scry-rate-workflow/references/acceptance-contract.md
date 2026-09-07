# Scry rate-workflow 验收契约

`contract.workflowProfiles.default=draft`。只有用户明确要求发送、三轮或“写完技术方案后停下”时启用 `three-turn`；它的发送、人工问题、完整 parity 和最终保留判据见 [three-turn-workflow.md](three-turn-workflow.md)。两个 profile 在第一条消息前共用本文件的冻结身份、treehouse、Provider/Profile、权限和清场判据。

## Provider 映射

| 用户选择 | Scry providerId | runtimeProvider | 权限模式 | 草稿消息 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude_sdk` | `full_access` | `/rate-workflow <id> 理解prd后停下` |
| Codex | `codex` | `codex_cli` | `full_access` | `/rate-workflow <id> 理解prd后停下` |
| Qoder | `qoder` | `qoder_cli` | `full_access` | `/rate-native-rate-workflow <id> 理解prd后停下` |
| OpenCode | `opencode` | `opencode_server` | `full_access` | `/rate-workflow <id> 理解prd后停下` |
| Pi (`pi:default`) | `pi` | `pi_rpc` | `full_access` | `/skill:rate-workflow <id> 理解prd后停下` |

`contract.providers.<id>.displayName` 是 renderer 中的 Provider 身份，必须精确匹配 `ProviderDescriptor.label`。Qoder 的固定显示名是 `Qoder`；CLI 发现层的可执行文件名 `qodercli` 以及旧探测文案 `Qoder CLI` 都不能用于权限证据或身份判定。

`command` 是放入 composer 的命令名。Qoder 的 `/rate-native-rate-workflow` 是命令 shim。Pi 的 `/skill:rate-workflow` 会由 Pi 展开，three-turn profile 必须用 command catalog 证明其来源为 skill，并以 prompt 前后的唯一 user entry id 绑定 authoritative turn ID，不能按展开后文本或 RPC request id 猜测。

固定 treehouse 槽位是运行身份的一部分：Codex=`1`、Claude Code=`2`、Qoder=`3`、OpenCode=`4`、Pi=`5`。Pi 还必须精确匹配 `agentProfileId=pi:default`，MCP 执行预检结果固定为 `not_applicable`。一个槽位同时只能有一个 `run_root`；环境恢复和 Scry build 分别使用互斥的 `environment`、`build` 跨槽位共享锁。正常验收不取得 `browser` 锁。固定 lease 跨运行保留；Provider `claim` 必须写 schema 2 owner identity、`ownerState/ownerStage/heartbeatAt`。当前运行的草稿/send intent 现场继续持锁供复盘；用户下一次启动同 Provider 验收即构成 supersession 授权，Step 0 只对严格终态 `RETAINED_DRAFT` 或完整 `RETAINED_FOR_REVIEW` 自动执行受控 stop/status/after/release。fresh、active、incomplete、legacy、owner 不可证及其他 Provider 的现场仍不得追溯清理。

草稿消息由命令、需求 ID 与固定后缀组成，精确为 `<command> <id> 理解prd后停下`；文本只从 `contract.json` 生成，只放进 composer 输入框，不点击发送。

权限模式对所有 provider 都是安全不变量：选择 provider 后、把第一条消息放进输入框前，必须在受控测试 renderer 中显式选择 `full_access`。Claude/Codex/Qoder/OpenCode 的选中文案为 `完全访问`，Pi 为 `本机完全访问`；必须按 Provider contract 回读，不得依赖默认值、历史选择、fallback、颜色或截图推断。

## 环境恢复与冻结

冻结之前允许且只允许以下有界恢复，最多两次；中间态为 `RECOVERING_ENVIRONMENT`，不得直接归类为 `BLOCKED`：

1. 以 Scry source package 与 `RECORDER_VERSION` 的一致值为目标。内部 registry 缺精确版本时，必须先通过 `check:cli-release`、重建 CLI、验证 artifact `--version`，并证明 release input 前后指纹不变，才能执行既有 publish；精确版本存在但 `latest` 落后时可推进 dist-tag。随后安装精确版本到契约 prefix，并证明 resolved binary 位于该 prefix 的 package root 且 package name/version 一致。禁止临时 worktree symlink、自动改 semver、覆盖同版本、`@latest` 或在 registry 新于源码时降级。
2. 从权威 rate-native 本地配置种子复制契约 allowlist env key，原子生成四端 `settings.local.json` 并设为 `0600`；ready 判据必须比较 allowlist 值与权威 seed 相等，而不只检查 key 存在。损坏目标必须先移到本次 `run_root` quarantine；证据不得包含值。
3. before 清场可隔离身份不符/损坏 manifest、脚本自有 partial attempt 和精确 warm-repository 路径下的非 Git 半成品；bootstrap 可从权威源的已提交 HEAD 本地 clone 重新生成。错误 origin 的 target 整仓 quarantine 后重 seed；clean stale target 在保存旧 HEAD recovery ref 后对齐 authority HEAD/branch；dirty target 硬失败。不得删除、`git clean` 或把用户 Scry 源码改动当残余。
4. Scry 依赖未物化（`node_modules` 缺失、不完整或缺契约要求的可执行入口）时，默认在与 environment 互斥的 `build` 锁内按 tracked lockfile 执行一次确定性安装，绝不解析、升级或改写 `package-lock.json`。安装前后 Scry `head/dirty/worktreeHash` 必须完全相等，安装后必须重新证明契约列出的 lockfile、模块目录与可执行入口都就绪，证据落在本次 `run_root` 的 `scry-dependencies.json` 与 `0600` 日志。symlink 化的 `node_modules`、缺 tracked lockfile、安装后仍不完整或任何 tracked 输入漂移仍是硬失败；缺依赖本身不构成 `BLOCKED`，也不得转为用户确认项。

只有 `environment-recovery.status == FROZEN_READY` 与唯一完整 preflight `ok == true` 同时成立，才建立 `contract/source/version/build` 基线。canonical launcher 先把本 skill 的 contract、references 与完整 scripts 依赖复制成只读 `run_root/workflow` 并写逐文件树指纹，随后 `exec` 冻结入口；后续验收禁止回到 canonical skill。`designs/` 是 audit-only 用户资产。Scry 源码本地改动不阻塞且不进入构建；构建身份只用启动时 HEAD/treeHash。冻结后 canonical Scry HEAD/treeHash/dirty 变化只作 audit，不再作废本轮；只有 run-local workflow/build、baseline contract、recorder 绝对身份或 fixed workspace HEAD 漂移才失败。源码身份不可证、symlink/越界、registry 不可证明或恢复不收敛仍是硬失败。

`bootstrap-status` 和 `build-status` 是状态探测：`repair_required`、`needsInit=true`、`needsBuild=true` 均不是失败。canonical cache hit 时在 build 锁内稳定复制 `scry/out` 到 `run_root/scry-build-out`；cache miss 则从逐 blob 校验的干净 HEAD 快照出发，在快照内按已提交 lockfile 单独 `npm ci`，禁止把 mutable canonical `node_modules` 链入构建源，再输出到同一路径。Test App 随后复制为 `run_root/scry-runtime`，形成 workflow/build/runtime 三层 run-local 身份。

## 人工克隆接管

Aone 克隆只能由用户完成。Agent 不得通过浏览器控制、CDP、Computer Use、Aone 写 API 或其他自动化打开克隆弹窗、点击“克隆/新建”或创建需求；执行本 skill 永远不构成这类写操作的授权。

人工接管发生在 Step 0 环境恢复/version/build 闸门通过之后、任何 Provider 运行锁和 Scry Test 启动之前。除非用户已明确选择 `--local-equality-only`，尚无用户提供的新需求 ID 时状态为 `WAITING_FOR_USER_CLONE`：输出固定源需求 canonical URL 和 `run_root` 后立即结束当前 turn，不持有 `environment`、`build`、`browser` 或 Provider 运行锁，也不保留测试 App。它不是 PASS、FAIL 或 BLOCKED。

恢复时只接受用户回复的纯数字 ID，或 project=`952011` 且路径为 `/req/<纯数字>` 的 canonical URL；新 ID 必须不同于 `85076624`。用户未给 ID 时继续等待，禁止 Agent 自行搜索或推断。收到合法值后先用 `verify_frozen_run.py --phase handoff` 定向复核 workflow/build/contract/recorder 冻结身份，再取得 Provider 槽位；随后只允许通过 rate-workflow P0 的受信 `source_intake.py aone-metadata --workitem-id <id>` 固定入口只读读取详情，核对 ID、project、标题和固定文档 URL。若返回的 `sourceWorkitemIds[]` 非空，每个值必须等于 `85076624`；接口不暴露来源时只记 `cloneProvenance=user_attested`。

## 单次运行身份

以下字段共同定义一次运行，不能跨会话拼接：

- `sourceWorkitemId`：固定为 `85076624`
- `contractFingerprint`：preflight 记录的 `contract.json` schema version 与完整文件 SHA-256；`baselinePreflightFingerprint` 另冻结整份 baseline 的 path/size/SHA-256，人工等待前后及最终复验都不得漂移
- `workitemId`：归一化自用户回复的纯数字 ID 或 canonical URL，必须不同于 `sourceWorkitemId`；`--local-equality-only` 时固定等于 `sourceWorkitemId`
- `cloneActor`：固定为 `user`，且 `uiClonePathObservedByAgent=false`；`--local-equality-only` 时为 `not_applicable`
- `scrySourceFingerprint`：唯一完整 preflight 冻结的 Scry HEAD、提交 tree hash、dirty 与 worktree hash；冻结后的 canonical 状态只作 audit
- `workflowSnapshot`：`run_root/workflow` 的只读完整文件树指纹、canonical source skill 路径与 Scry repo 路径；后续 contract 和 helper 全从该目录读取
- `scryBuildFingerprint`：`run_root/scry-build-out` 的完整文件树 hash；canonical cache 命中时稳定复制，miss 时由干净 HEAD 快照构建
- `rateNativeFingerprint`：preflight 冻结的 rate-native HEAD 与 worktree hash
- `scryBinFingerprint`：冻结绝对 recorder binary 的 resolved path、size 与文件 SHA-256；轻量 verifier 同时重验 package provenance 和 `--version`，同版本替换或 retarget 不得通过
- `recorderVersion`：Scry source package、源码常量、稳定 prefix 内已安装的 CLI，以及 rate-native 四端 `settings.local.json` 的 `SCRY_CLI_PATH` 所指同一绝对可执行文件完全一致。PATH 只用于 Step 0 发现，其他同名可执行只作 audit；doctor/verify/summary/bootstrap 必须传冻结绝对路径，**清理/归档路径例外**：统一由脚本解析当前 stable prefix 最新 CLI 操作（身份边界仍在：该 prefix 内同名 package root 的可执行文件，冻结版本只作披露），recorder 升级不阻塞旧现场清理。rate-native 已把 recorder CLI 的版本管理解耦，仓库里不再钉死版本号；Hook 默认值为空与 `init.sh` 使用 `@latest` 是预期状态，只有仍然存在的钉死值才必须等于源码版本。四端配置对 recorder binary 不一致时不构成单一可证身份，不得放行。归一化指纹只比较与仓库无关的 recorder 身份（`cliPath`、`cliVersion`、仍存在的钉死值）；per-settings 映射在源仓与已 bootstrap 的 treehouse 之间合法不同，只在 `rateNativeRecorder` 中审计。
- `testAppLaunchId`：独立 Scry 测试 App 的受控启动 ID
- `testAppStatePath`、`testAppPid`、`testAppCdpPort`：本次 run root 内的启动 state、PID 与专用 CDP 端口
- `testAppCommandIdentity`：Scry repo、隔离 userData、macOS appPath、端口及唯一 launchId 参数组成的 live command 身份
- `testAppBrowserIdentity`：隔离 userData 的 `DevToolsActivePort` browser path，必须与专用端口 `/json/version` 的 browser WebSocket path 相同
- `testAppRendererIdentity`：该 browser 下唯一最终 renderer 的 targetId、精确 file URL、规范化标题、布尔 marker 与 launchId marker
- `testAppBuildSnapshot`：`run_root/scry-runtime/out` 的文件数与 SHA-256 必须等于启动时 Scry `out/`；renderer URL 精确指向该快照而不是共享 source `out/`
- `scryUserData`：本次测试 App 的隔离 userData，位于本次 `run_root`
- `runRootParent`：固定为契约中的持久状态目录，不得使用 `/tmp` 或其他系统临时目录
- `workspace`：本次 treehouse 的绝对路径
- `treehouseSlot`：必须等于 Provider 的固定槽位，lease holder 必须等于契约值
- `providerId`：用户指定 provider
- `agentProfileId`：Pi 固定为 `pi:default`；其他 Provider 必须为空
- `permissionMode`：固定为 `full_access`，由草稿前的受控 renderer DOM 回读和 `permission-evidence.json` 证明
- `draftText`：严格为 `<command> <workitem_id> 理解prd后停下`，只放入输入框不发送

three-turn profile 以 `turn1-send-intent.json` 代替 `turn1-draft.json` 建立 lexical 边界，并要求最终恰好三轮、同一 session、每轮 authoritative `providerTurnId` 唯一，archive ↔ `.scry/records` ↔ `scry turns summary --json` 全字段一致。该 profile 的成功终态是 `RETAINED_FOR_REVIEW/PASS`，不是 `RETAINED_DRAFT`。

新需求 ID 由用户交接输入、`a1 project workitem get` 只读回读和草稿文本共同证明。若详情接口不返回克隆来源，只能证明“用户声明其为克隆 + 新 ID 对应详情符合契约”，不能伪造更强的 UI 操作证据。

## 草稿判据

必须同时满足：

1. 受控启动器在任何 runtime/spawn 写入前，必须验证必填 Provider、canonical Scry repo realpath、契约按 Provider slot 推导的唯一 fixed workspace realpath，以及对应普通 slot-lock 文件中的 schema 2 ACTIVE owner；slot lock 的 scope/provider/runRoot/ownerId/ownerState/带时区 heartbeat 必须满足当前 owner 契约，且 `ownerStage` 必须精确为 `BOOTSTRAP_READY`，其他 ACTIVE stage 也不得启动。任一错 repo、错 workspace、错 slot、错 runRoot、错 Provider、错阶段或 inactive/非法 owner 都必须零写入拒绝。启动状态及随后的只读 `status` 还要证明 state 位于本次 run root并记录同一 provider，App 为 `version=3/mode=test/status=running`，copy 前后 source `out/` 与 `scry-runtime/out` 指纹相等，实时 `runtimeSnapshotReady=true`；PID 存活、专用 CDP 可用、live command 与快照 app root/appPath/userData/port/launchId 参数一致；隔离 userData 的 `DevToolsActivePort` browser path 与 `/json/version` 精确相同，该 browser 下唯一 page target 精确命中快照 renderer URL，启动和实时 ownership 都是 `verified`，规范化标题、`data-scry-test-app=true` 与本次 launchId marker 均经延迟回读稳定。`scryUserData` 不是已安装 Scry 的默认目录。`status` 退出码本身不构成健康证明，必须逐字段检查 JSON；CDP 不可达必须输出 unknown，不能冒充 closed。
   启动必须由 `fixed_workspace.py start-test-app` 在同一个 lifecycle gate 内完成，禁止直接 Node start。wrapper 把已 flock 的同一 open-file-description 继承给 `start-locked`；Node 在任何写入前校验 fd 与契约 lifecycle lock 的 dev/ino，并持有到退出，所以 parent 崩溃也不能让 finalizer 越过正在启动的 child。Node 校验 gate/auth/ppid 后立即原子消费 authorization；state 只记录 consumed/path/wrapperPid，不得记录 token。wrapper 只有在 stdout JSON 与持久 state 完全相等且 running/provider/runRoot/launch owner 全匹配时才返回 `ok=true`。残留 regular authorization 只有在 wrapper PID+command、匹配 child 和全部 launch residue均证明不存在后才 quarantine；PID 被不同命令复用不算 live，malformed regular 文件走同一 child/residue 安全闸门，symlink/非普通文件硬拒绝。
2. 放入第一条消息前，启动器必须把唯一固定 workspace 写入隔离 userData 的最近目录和 `test-scry-state.json.expectedWorkspace`；`capture_permission.mjs capture` 必须确认受控 renderer 是全新空草稿，通过 renderer 自己的 workspace/Provider/Profile 选择器完成精确选择，等待 Provider 与运行控制健康，再回读 workspace 标签、精确 Provider/Profile 身份、健康状态和 `testLaunchId == state.launchId`。它还必须证明权限选择器未禁用、包含 `option[value="full_access"]`，设置后回读 `value == "full_access"` 与 contract 对应文案，再原子写入本次 run root。Pi 必须精确回读 `pi:default`。新草稿此时不暴露 active project 全路径，所以由启动 state、最近目录精确 path 与最终标签共同约束；draft 不产生 sessionId，three-turn 在第一轮后用 `bind` 补齐同一 session 证据。
3. `send_prompt.mjs draft` 在受控 renderer 内把契约文本精确放入 composer textarea，并回读 `input.value` 与契约文本逐字相等；`slash` 命令菜单必须已关闭。草稿前必须证明 `turnCount == 0`、无运行中会话（无 `button.stop`）、Provider 标签与权限回读不漂移、输入框为空或恰为该文本（重试幂等）。草稿不点击 send：不得出现新的 `.turn` 元素、不得产生 `app-sessions.json` 候选或任何 `trace-archive-turns-v1` 归档。
4. 打字验证成功后、写证据前，`fixed_workspace.py record-draft` 在同一 lifecycle gate 内原子落盘 `turn1-draft.json`：`schemaVersion == 1`、`status == "drafted"`、`turn == 1`、`workitemId` 为本次纯数字 ID、`text` 精确等于 `<command> <id> 理解prd后停下`、`localEqualityOnly` 为布尔、`launchId/pid/port` 与启动 state 一致；随后槽位 ownerStage 刷新为 `TURN1_DRAFT_PREPARED`。terminal lifecycle、已有 send intent 或已有草稿记录时拒绝落盘。草稿记录与 send intent 是互斥的 lexical 边界：草稿存在时不得再点击发送，点击即把草稿现场变成会话现场、本次运行作废。
5. 退出分流时，`finalize_pre_send.py` 从冻结 workflow 读取 contract 与 lexical 边界：草稿记录存在 → 原子写 `lifecycle.json=RETAINED_DRAFT`，不停测试 App、不做 after 清场、不释放槽位锁；草稿与 intent 都不存在 → 受控 stop/quarantine/after/release 并写 `PRE_SEND_ARCHIVED`。finalizer 与 `record-draft` 必须持同一个 lifecycle gate。
6. `RETAINED_DRAFT` 后做轻量最终复验：`verify_frozen_run.py` 校验 workflow bundle、run-local build、baseline contract、recorder 绝对身份和 fixed workspace HEAD；canonical Scry 漂移只进 audit。受控启动器 `status` 仍须证明 live ownership/runtime snapshot，并与 `turn1-draft.json` 的 launchId/pid/port 一致且时间更新更晚。
7. 本次运行持有的 `environment`、`build` 共享锁必须释放；Provider 槽位锁有意保留以保护当前现场。用户可显式提前清理；否则下一次同 Provider 验收由 Step 0 的 supersession helper 自动执行 stop、closed status、after 归档和 release，不额外确认。自动清理失败必须保留锁并阻断新运行。`run_root` 始终保留。

已安装 `/Applications/Scry.app` 中无论有多少运行中会话，都不属于候选集，也不构成阻塞。验收不得读取或操作它的窗口、会话和 userData。

`--local-equality-only` profile 只在用户明确把范围收窄为“只验收草稿入框本身”、且手工克隆被外部网络阻塞或用户明确决定不提供新需求 ID 时可用；等待用户回复本身不构成网络阻塞，不能自动降级。它允许固定源需求 `85076624` 作为草稿输入，避免伪造一个不存在的克隆 ID；草稿判据 1-7 保持不变，结果名为“草稿入框 PASS”，不代表用户完成了手工克隆。

## 失败分级

- `WAITING_FOR_USER_CLONE`：非最终状态；Step 0 已通过，但尚未收到用户提供的新需求 ID。不得持有 Provider/共享锁或启动测试 App，不得写成 `BLOCKED`。
- `WAITING_FOR_DRAFT_CLEANUP`：槽位锁指向可证明的 `RETAINED_DRAFT`。当前运行保持可查看；下一次同 Provider 验收把它作为可自动 supersede 的内部中间态，受控归档后继续。
- `WAITING_FOR_REVIEW_CLEANUP`：同 Provider 已有完整 `RETAINED_FOR_REVIEW`。当前运行保持可查看；下一次同 Provider 验收受控归档后继续。缺终态证据不得归入此类。
- `WAITING_FOR_LEGACY_CLEANUP`：槽位锁指向 schema<5 或无法证明 contract hash 的旧 `run_root`。旧协议可能已经发过消息却没有 send-intent 文件，因此禁止按文件缺失推断 pre-send；只能在用户授权后按 Step 6 收尾。
- `PRE_SEND_ACTIVE`：槽位锁指向当前 schema/hash、草稿记录与 lexical send intent 都不存在，但 run 是 fresh、owner active 或 owner identity 不可证；缺草稿不是 abandonment，Step 0 必须保留，不能 stop/sanitize/release。
- `PRE_SEND_RECOVERY_REQUIRED`：槽位锁指向当前 schema/hash、草稿记录与 send intent 都不存在，且 schema 2 owner/lifecycle 已明确交接为 inactive `FINALIZE_FAILED/PRE_SEND_ABANDONED`，或存在合法 prepared-archive journal；这是内部可恢复状态，`prepare_environment.py` 必须调用统一 finalizer 自动归档并释放，不能上报为最终 `BLOCKED`。
- `WAITING_FOR_ACTIVE_REVIEW_FINALIZATION`：send intent 已存在（旧版 post-send 现场）但严格静止终态未完成。继续完成/诊断当前 run，不能误判为 legacy、强清或启动会覆盖现场的新 run。若 watcher 已完成但 lifecycle 未落盘且 owned test App 已明确退出，只有用户针对该 run 授权放弃，并由五分钟内的固定 status 证明 launch 身份匹配、`processAlive=false`、`cdpClosed=true` 和 runtime snapshot 完整，才可转成带 `completedEvidenceDisposition=abandon_after_owned_app_exit` 的 `POST_SEND_ABANDONED` 后清理；不得用历史 status、CDP unknown 或强删锁代替。
- `BLOCKED`：有界恢复两次后版本/配置仍不一致，registry 状态或发布权限不可证明，Scry 源码身份不可证，用户提供的新需求无法只读核验，前置登录/权限/init 失败，发送前 MCP 预检报出同名 enabled server、项目级凭据绑定或父进程环境插值，或独立测试 App 无法获得唯一稳定 ownership。单纯缺 CLI、缺本地 settings、缺/残缺 warm repo、损坏 cleanup/marker、cache miss 不得在尝试契约恢复前写成 `BLOCKED`；Scry 源码存在本地未提交改动也不属于此类（只有“registry 缺精确 recorder 版本、必须从带改动的源码 publish”才算发布不可证）；尚未收到用户 ID 和其他已完成的审阅现场也不属于此类。
- `CLEANUP_FAIL`：适用于 schema 5+ pre-send 自动收尾或用户显式清理；本次测试 App 无法被精确停止、缺/损坏 state 下存在匹配 live PID、recorder 无法停止、运行残留在清场后重现、证据无法归档，或 Provider/共享锁无法安全释放。保留原数据层判定和现场，不得强删锁。
- `DRAFT_PASS`：草稿判据 1-7 全部通过，现场处于 `RETAINED_DRAFT`，共享锁已释放且 Provider 锁有意保留。它只证明第一条消息精确进入输入框且未发送，不代表任何会话或数据一致性结果。

## 最终报告骨架

| 项目 | 结果 | 核心证据 |
| --- | --- | --- |
| 前置与新需求 | PASS/FAIL | 环境恢复状态/动作；精确发布与安装版本；Scry 源码身份 `head/dirty/worktreeHash`；quarantine manifest；source ID → 用户提供的新 ID；treehouse；预检；发送前 MCP 执行预检 |
| 草稿入框 | PASS/FAIL | provider；`full_access / 完全访问` 的草稿前 DOM 回读；`turn1-draft-evidence.json` 的精确回读与 `turnCount==0`；`turn1-draft.json` 的 drafted 记录与 launch 身份；未点击发送 |
| 最终复验 | PASS/FAIL | 最终 status live ownership；launchId/pid/port 与草稿记录一致；终态晚于草稿记录 |
| 复盘保留 | PASS/FAIL | `RETAINED_DRAFT`；Scry Test live ownership；持久 run_root/workspace/userData；共享锁释放；Provider 锁与 lease 保留 |
| 业务改动与副作用 | PASS/FAIL | 无发送即无会话；若发现远端写操作或需求状态变化，只读列出且未经授权不回滚 |

报告失败时给出字段级 `expected / actual`，不要只写“数据不一致”。
