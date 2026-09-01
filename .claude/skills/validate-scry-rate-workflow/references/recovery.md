# 恢复与保留规则

## 原则

- 先判定失败层级，再决定是否重跑；Agent 永远不重做 Aone 克隆。已有用户提供且只读核验通过的新需求 ID 时直接复用，确需新克隆时再次停下等待用户操作。
- `run_root` 固定位于契约指定的持久状态目录；保留 JSON、日志、archive、records 和隔离 userData，禁止使用 `/tmp` 或在验收结束后删除。
- 当前执行者在 schema 5+ 且草稿记录尚未形成时，必须直接调用统一 finalizer：草稿记录已落盘 → 原子写 `RETAINED_DRAFT` 并保留现场；草稿记录与 send intent 都不存在 → 受控 stop/quarantine、after 清场并释放 Provider 槽位锁，生命周期为 `PRE_SEND_ARCHIVED`。跨 run 的 Step 0 只接管 explicit inactive `FINALIZE_FAILED/PRE_SEND_ABANDONED` lifecycle 或合法 prepared journal；fresh、active、owner unknown、legacy/未知 contract 都不能仅因缺草稿自动清。send intent 已形成的旧运行保持受控 `Scry Test`、workspace 数据和 Provider 锁，严格终态为 `RETAINED_FOR_REVIEW`。
- 任何源码、构建产物或 recorder 版本变化都会使已有会话失去新版验收资格；旧运行只作为失败证据。
- 同一 Provider 不并发。槽位运行锁分类由 frozen contract 与 lexical 边界共同决定：草稿记录已存在（无 send intent）归类 `WAITING_FOR_DRAFT_CLEANUP`，现场按保留处理；旧版 post-send 现场只有在 frozen contract、send intent、watcher 三轮完成且 idle、完整终态和实时 v3 runtime snapshot 均成立时才归类 `WAITING_FOR_REVIEW_CLEANUP`；local parity 的布尔结果单独决定 `PASS/LOCAL_DATA_FAIL`，不决定是否仍有 writer。legacy/未知旧现场报告 `WAITING_FOR_LEGACY_CLEANUP`；当前 schema 契约既无草稿记录也无 intent 时，fresh/active/owner unknown 报 `PRE_SEND_ACTIVE` 并保留，只有 explicit inactive handoff 或 prepared journal 才报 `PRE_SEND_RECOVERY_REQUIRED`；已有 intent 但严格静止终态未完成报 `WAITING_FOR_ACTIVE_REVIEW_FINALIZATION`。不得强删锁或覆盖现场。
- `sanitize_workspace.py` 用于运行前 `before`、schema 5+ pre-send 自动收尾和用户显式授权后的 `after`：先停 recorder，再移动 allowlist 状态和 Git 改动到本次 `run_root`，最后证明状态没有重现。manifest 只有 schema/phase/provider/workspace/archiveRoot 全匹配才幂等；损坏/身份不符 manifest、partial attempt 和 exact warm-repository 半成品均在 run root 内隔离续跑。不要手工 `rm -rf .scry`、`git clean` 或清理用户源码/ignored 缓存。
- `WAITING_FOR_USER_CLONE` 必须发生在 Provider `claim` 和 Scry Test 启动之前。等待期间不持有 Provider、`browser`、`environment` 或 `build` 锁，不保留测试 App 或会话草稿；用户回复 ID 后必须重新 preflight 并要求 `ok == true`。
- 仅 Step 0 用 `PATH` 发现/修复 CLI；冻结后 doctor/verify/summary/bootstrap，以及 workspace 存在 `.scry` 时的 recorder 清场，全部使用 baseline preflight 的绝对 `versions.rateNative.cliPath`。pre-send workspace 尚无 `.scry` 时 finalizer 不调用 recorder，也不因冻结 CLI 正在等待修复而制造循环阻塞。其他 PATH candidate 只作审计，不得在跨 turn/新 shell 后重新决定可执行身份。

## 环境与前置故障的修复路径

先区分 `recoverable` 和 `fatal`。前者在同一 `run_root` 内最多恢复两次，只有耗尽后才转为 `RECOVERY_FAILED/BLOCKED`；后者不自动改语义输入。

`environment`/`build` 锁只能由 `prepare_environment.py` 单进程事务持有；任一步异常都在 `finally` 释放。Provider `claim` 生成 schema 2 durable owner identity，阶段动作刷新 `ownerStage/heartbeatAt`；不使用短命 claim CLI PID 或超时猜测 abandonment。取得 mutation lock 前，Step 0 扫描 Provider 锁，并只对 explicit inactive lifecycle 或 prepared journal 分类出的 `PRE_SEND_RECOVERY_REQUIRED` run 调用统一 finalizer；fresh/active/unknown owner 一律为 `PRE_SEND_ACTIVE`。若该 pre-send workspace 已有 `.scry` 而冻结 CLI 缺失，journal 后以当前 Scry source 版本（最新）为目标恢复 cleanup CLI（frozen 版本只披露，不要求 frozen/source 相等），再重试 finalizer；这次全局 publish/install 仍须持有 `environment` 锁，clearance 只额外豁免当场重新分类仍为 `PRE_SEND_RECOVERY_REQUIRED` 的 exact Provider + old run slot；其他 slot 仍须满足正常 mutation gate 的严格 finalized v3 review 隔离，否则 active、legacy 或未完成 review 都继续阻止；无 `.scry` 则不调用 recorder。环境已经一致时只在序列化 environment 锁中重新 inspect 并冻结；唯一失败若只是权威 source rate-native 四端 settings/`SCRY_CLI_PATH`，走不会调用 registry/npm 的 settings-only 恢复，因为它不改旧 fixed workspace；registry、全局 CLI 或其他差异仍进入会被 active/legacy 现场保护的 mutation gate。共享 mutation 锁另记录 owner PID 与命令 hash，只有该身份已消失/复用时才 quarantine 后重放；没有 owner 身份的 legacy 锁不自动删。

Scry canonical build cache miss 不再要求清理 legacy review App：`prepare_environment.py` 仍取得与 environment 互斥的 process-owned `build` 锁，但只写本次 `run_root/scry-build-out`，不写共享 `scry/out` 或全局 marker。构建源是干净 HEAD 快照（`scry-build-src`：git archive + 逐文件 git blob 校验 + 复用主仓 `node_modules` 符号链接），工作区未提交改动不会进入产物；若 build-out 已有非 symlink 半成品，先原子移到 `build-recovery/partial-*` 并写 manifest；symlink 直接拒绝。只有同一 run 的 `isolated-build.json`（schema 2）、post-build preflight、Scry HEAD/treeHash、入口和产物 hash 全部匹配才复用（dirty/worktreeHash 不参与构建与复用判据）。canonical 缓存判定只看 `scry-build.json` marker 的 schema 2 提交身份（HEAD/treeHash/artifacts），工作区改动不再造成 cache miss。启动器只允许 canonical `scry/out` 或本 run 这个精确 child 作为 `--build-out`，随后仍复制成独立 version 3 `scry-runtime`。

测试 App 启动与 finalizer 共用 lifecycle flock。公开 wrapper 把同一个 gate fd 继承给 Node，并且 parent 只 close、不显式 unlock；parent 崩溃时锁由 child 延续到退出。Node 原子消费一次性 authorization 后才允许 runtime 写入。若双重崩溃留下 authorization，普通且可解析的文件用 wrapper PID+command hash 区分真正 live 与 PID reuse，再检查匹配 child 和 launch residue；普通但 malformed/截断的文件也只有在 child/residue 全空时 quarantine。symlink、非普通文件、live wrapper、live child 或任何 launch residue 都保留并拒绝自动恢复。

- **recorder 缺失、断链或版本落后**：以 Scry source 精确版本为目标。registry 缺版本时先跑 release tests/build、验证实际 artifact 版本并复核发布输入不漂移，再 publish；随后精确安装到 `~/.local`，校验 resolved binary 位于该 prefix 的 package root，package name/version/执行版本一致。临时 worktree symlink 即使当前版本相同也重装。禁止 `@latest`、自动 bump、覆盖同版本或 registry 新于源码时降级。源码带本地未提交改动不影响验收也不影响安装；只有 registry 缺精确版本、因而需要向共享 registry publish 时，才要求干净 release input，并把它作为单一可行动原因报告。
- **Scry 依赖未物化**：`node_modules` 缺失、不完整或缺 `electron-vite`/`electron` 入口时默认自恢复：在 process-owned `build` 锁内按 tracked `package-lock.json` 跑一次 `npm ci`，不解析、不升级、不写 lockfile。安装前后必须证明 Scry `head/dirty/worktreeHash` 不变，安装后重新探测依赖完整，证据为 `scry-dependencies.json` 与 `0600` 的 `scry-dependencies.log`。symlink 化 `node_modules`、缺 tracked lockfile、安装弄脏 tracked 输入或安装后仍不完整才硬失败；不询问用户，也不因此报 `BLOCKED`。
- **四端本地配置缺失、损坏或漂移**：从契约指定的权威 rate-native seed 复制 allowlist env key，保留目标 JSON 的其他字段，原子写入并 `chmod 0600`；ready 必须比较 allowlist 值而非只看 key。损坏目标先移到 `preflight-recovery/quarantine`；日志和 manifest 只列 key，不列值。权威 seed 本身缺失/缺 key 才硬失败。
- **warm repo/cleanup/marker/启动半成品**：只处理契约精确拥有的路径。非 Git warm-repository、错误 origin target、clean stale HEAD、损坏 bootstrap/build marker、损坏/错身份 cleanup manifest/partial attempt，以及无匹配 live PID 的 runtime/userData/App/log/损坏 state（包括残缺成非 symlink 目录）移入本次 run root 或保存 recovery ref 后重建/续跑，不删除。dirty warm repo、symlink、越界、活跃 writer/PID，以及需要碰用户 Scry 源码改动才能继续的情形仍硬失败（Scry 源码自带本地改动本身不阻塞验收）。`.mcp.json` 必须清除 skip-worktree 后从 HEAD 恢复，并校验除 materialized credential 外的 server/URL/结构；`designs/` 只作 audit-only，不清理。
- **固定池被外部删除、Git worktree 注册表陈旧**：`treehouse` 池为空但权威源仓仍注册着已删除的槽位路径时，`git worktree add` 报 `missing but already registered worktree`，属于自愈范围，不得停手问用户。`lease-all` 在 lease 前先扫描、失败后再试一次，每次调用总共只用一次预算（`recoveryPolicy.treehousePool`）。prune 是仓库级操作，所以先读 `git worktree prune --dry-run --verbose` 计划：计划中每一项的 gitdir 目标都必须已不存在，且至少一项在固定池 root 内，才允许执行；任何一项的工作树仍存在、admin `gitdir` 不可读、池内陈旧项在 prune 后仍在，都硬失败。只有池外陈旧注册项时不动作。不得改用 `add -f`、`worktree remove --force` 或手删 `.git/worktrees`，也不得因重建后的冷预热较慢而中断。
- **MCP 执行语义冲突**：`duplicate_enabled_server`、`parent_env_interpolation`、`execution_shaping_env` 在第一条消息前硬失败；`credential_env_outside_user_scope` 也默认硬失败，只有 `contract.json` 的 `mcpExecutionPolicy.credentialScopeExceptions` 明确列出的 server/rule，且项目级 `bearer_token_env_var` / `env_http_headers` 仅引用对应 Provider 的项目本地 `settings.local.json` 中已有 env key 时，才视为已由本机权威 seed 恢复出的凭据引用，不物化值、不报告为冲突。不得静默禁用/移动 `~/.qoder` 等用户配置，因为这会影响并发项目；也不得修改 tracked 项目配置或物化凭据来凑 PASS。报告冲突的 server/scope/path，由用户决定改仓库、产品迁移路径或隔离 Provider home。
- **槽位锁指向旧现场**：旧版 post-send 现场只有 lifecycle + send intent + watcher 三轮 `COMPLETED`/idle + 布尔 local parity outcome + 合法 final status + 当前 v3 snapshot hash 同时成立才属于 `WAITING_FOR_REVIEW_CLEANUP`；parity false 保留为 `LOCAL_DATA_FAIL` review，不表示 writer 仍活跃。当前 schema/hash 且草稿记录已存在（无 intent）属于 `WAITING_FOR_DRAFT_CLEANUP`，现场按保留处理。schema<5/contract hash 不可证属于 `WAITING_FOR_LEGACY_CLEANUP`。schema 5+ 既无草稿也无 intent 仍须区分 `PRE_SEND_ACTIVE` 与 explicit inactive `PRE_SEND_RECOVERY_REQUIRED`；缺文件本身不授权跨 run 清理。version 3 review-only App 从自己的 `scry-runtime` 快照运行；历史 version 2/legacy live 现场仍依赖共享 `out/`，会阻止 canonical `out` 重建和环境恢复，但不会阻止只写本次 run-local build-out 的 cache-miss 构建。同 Provider 槽位始终受保留锁保护。

## 重试矩阵

| 失败位置 | 重跑 Agent | 可复用范围 |
| --- | --- | --- |
| preflight 可恢复项 | 否 | 同一 `run_root` 内最多两次恢复；成功后才冻结，不重复创建目录；始终释放 `environment` 锁 |
| preflight fatal、build 失败 | 否 | 尚未进入人工交接或取得 Provider 槽位；保留 recovery/build/依赖证据，释放对应 `environment`/`build` 锁；依赖缺失先自动确定性安装再构建 |
| 等待用户手工克隆 | 否 | 未取得 Provider 槽位、未启动测试 App；保留 Step 0 的 `run_root`，收到 ID/URL 后重新 preflight |
| 登录、首次 init、只读需求核验 | 否 | 若 schema 5+ 且无草稿记录，统一 finalizer 自动归档并释放槽位；可复用新需求 ID，重跑时不要求再次克隆 |
| 发消息前 MCP 执行预检失败 | 否 | 保留 `mcp-execution-prereq.json`，统一 finalizer 自动收尾；配置修好后可复用同一个已核验的需求 ID |
| Scry Test 启动 | 否 | 无草稿记录时扫描 live PID；无 writer 则 quarantine 残缺启动物并自动释放槽位，有歧义才 `CLEANUP_FAIL` 保留锁 |
| 用户克隆完成、草稿前 | 否 | 可复用用户提供且只读核验通过的新需求 ID；不要求用户重复克隆 |
| 草稿 Provider/权限污染 | 否 | 草稿记录未落盘时统一 finalizer 自动归档并释放槽位；可复用固定 treehouse 和已由用户提供、唯一核验的新需求 |

## 固定池与实例生命周期

- 若用户取消或只说“完成”但未给 ID：前者保留 Step 0 证据并结束，后者继续停在 `WAITING_FOR_USER_CLONE` 只索要 ID/URL；两种情况都禁止 Agent 打开 Aone 或搜索最近创建的需求。
- 用户回复后的 preflight 若 `ok != true`，保留旧 `run_root`，用新 `run_root` 从 Step 0 重跑并复用该 ID；不得借重跑要求用户再次克隆。
- `fixed_workspace.py lease-all` 用于首次启用、修复映射，以及固定池被外部删除后重建（含 allowlist 内的陈旧 worktree 注册表 prune）。Codex/Claude/Qoder/OpenCode 分别固定为槽位 1/2/3/4；普通运行结束不执行 `treehouse return`。
- `bootstrap-status` 在 bootstrap 输入/权威 warm HEAD 或 origin 改变、预热仓库缺失/残缺/stale、四端配置缺失或值漂移、`.mcp.json` 结构/URL 漂移或 marker 损坏时返回 `needsInit`；这是 `repair_required`，不是命令失败。`reconcile-bootstrap` ready 时幂等，只有 repair_required 才运行一次 `init.sh`。
- 每次运行开始先做 before 清场；每次退出先释放共享锁，再由当前执行者以冻结 contract + lexical 草稿边界调用 finalizer。`send_prompt.mjs draft` 在打字验证后通过 `fixed_workspace.py record-draft` 持 lifecycle gate 原子写草稿记录；finalizer 在同一 gate 内先复核已完成事务，并在任何 stop/sanitize 前最后一次重读草稿记录与 intent。跨 run Step 0 只接管 explicit inactive handoff/prepared journal；有草稿、有 intent、`PRE_SEND_ACTIVE` 和 legacy 都保留。没有 state 时必须先扫描本 run 专属进程。Provider slot release 前必须持久写 `PRE_SEND_ARCHIVE_PREPARED` journal；若进程在 unlink/生命周期提交之间被强杀，下次 finalizer 在 lifecycle gate 内恢复同一 slot lock并重放幂等 after/release，完成提交后才删除 journal。
- 新运行不得覆盖或复用旧 run root 的启动 state。若同 Provider 仍有保留现场，必须等待用户明确清理；`superseded` 只可作为报告标签，不写入 launcher state。
- `stop` 根据本次 state 定位 launchId/PID/port，并用 Scry repo、macOS appPath、隔离 userData、port 与唯一 launchId 参数复核 live command；workspace 由权限证据和 session index 验证，不属于进程命令匹配条件。state 为 `starting/running/failed/stopping` 都可安全收尾；PID 已死时标记为 `stale`，不要向复用后的 PID 发信号。停止由 macOS `shlock` 管理的 run-local PID lock 串行化；控制器异常退出后只在原 PID 已不存在时原子回收旧锁。信号 reservation 与历史 attempt 永久追加在 state 中；超时重试只能检查已有 attempt 是否最终收敛，累计两次预算耗尽后不得继续发信号或覆盖旧证据。
- 保留期间若 Scry Test 被用户关闭或异常退出，不得用同一 run root 重新 `start` 或改写 launch state；保留磁盘数据、workspace 和 Provider 锁，报告 live UI 已不可用，等待用户显式清理。
- 草稿只放入输入框不点击发送：`record-draft` 落盘后若发现 renderer 出现新 `.turn`、`app-sessions.json` 候选或输入框文本与草稿记录不一致，说明有人点过发送或改过输入框，本次运行作废，保留现场并报告字段级 expected/actual；禁止点“停止”或重启 App 来“收尾”。
- 草稿不发送、不产生会话，不应出现业务代码或远端写操作；若实际出现分支与 push、CR、PRE 部署、需求状态或提测文档变化，它们不属于清场范围：`before`/`after` 只处理 workspace 本地现场，远端副作用只能只读核验并列入报告，由用户逐项决定是否回滚。
- 用户明确要求清理后，先受控 `stop` 并证明 `stopped/stale + processAlive=false + cdpClosed=true`，再做 after 清场与 release；CDP unknown 不能冒充 closed。
- `before` 发现旧 `.scry/upload/health.json` 有 pending/dead-letter 时仍归档而不上传；上传健康不属于本 skill 的最终判定，旧状态也不能污染新运行。
- 显式清场失败时保留 run root、现场和槽位锁，先诊断活跃写入者或无法归档的路径。修复后使用同一 `run_root` 补完同一 phase；不能直接开启新运行。
- 永远不把 `/Applications/Scry.app`、allowlist 外的 ignored 缓存、无本 skill 固定 holder 的 treehouse 纳入清理范围。只有显式退役固定池时才逐槽位核对无运行锁并 `treehouse return`。
