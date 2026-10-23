# 批次 C：工作区 diff 只读路径

## 结论

**已优化，有明确可用范围。** `agent:gitDiff` 不再调用 recorder 快照树管线；不执行 `add -A` / `write-tree`，不建立临时对象库。进行中请求按 canonical cwd 合并，刷新保留同工作区旧结果并显示刷新中/来源时间。未合入 main、未安装，不改变用户当前运行的 App。

- 测量提交：`26cca06`；对象计数补强：`c2802e1`（也统计真实仓库新增对象，避免只看隔离库）。
- 优化提交：`0dcd7fe`。
- 详细实验和全部样本：[实验](../../../performance-experiments/20261022-workspace-numstat-readonly.md)、[原始数据](../../../performance-experiments/20261022-workspace-numstat-readonly.json)。

## 实现与减少的工作

| 项目 | 实现 / 取舍 |
|---|---|
| 只读实现 | 新增 `readWorkspaceNumstat`，只供 `src/main/git.ts` 注册的 `agent:gitDiff` 使用。复制真实 index 并保留时间戳，在临时副本 `read-tree --reset HEAD`，直接 diff 工作树；未跟踪文件由 Node 有界读取计数。临时 index 仍写入，用户 index 和对象库不写入。 |
| 并发 | 每次调用先重验授权，再按 canonical cwd 合并 in-flight promise；成功/失败后均删除。别名合并，后续调用重新取证。 |
| 已完成结果缓存 | **不实现 TTL 缓存**。HEAD/index 身份不能证明任意工作树内容未变；只做进行中合并，避免建立不能廉价失效的缓存。方向 3 的 HEAD/index 缓存键因此不适用，不把旧结果作为新请求的事实。 |
| 刷新 | `useIntegrations` 保留同 cwd 的数据；两个展示面明确显示刷新中和来源时间。跨 cwd 不保留；原有 seq + cwd 校验拒绝乱序和旧工作区回复。 |
| 工作去向 | 删除 blob/tree 写入和快照对象库创建/清理，不转移到后台；并发重复请求合并。保留必要的配置/属性/index 语义检查，所以不宣称单次 spawn 次数下降。 |

## 测量

固定负载：9 / 5001 tracked 文件，5 dirty（1 修改、1 删除、3 未跟踪，含中文路径/空文件），另有 ignored `.scry/noise.txt`。每组一次预热、6 个正式样本；验证 5 条结果及真实 index 字节不变。显式 excludedPaths 用独立 oracle fixture 验证。

| 规模 | Git spawn（L1） | 新写对象（L1） | 旧实现 p50 | 新实现 p50 |
|---|---:|---:|---:|---:|
| 小仓库 | 8 → 8 | 4 → 0 | 277.29ms | 224.18ms |
| 5001 tracked | 8 → 8 | 4 → 0 | 289.90ms | 218.83ms |

命令：`npm run build:cli`，然后在 `timing-run.mjs c-workspace-frozen-paired` 的同一锁内，依次用 `BENCH_IMPL=gitNumstat` / `readWorkspaceNumstat` 执行 `npm run bench:git-diff -- --workspace-numstat`。

机器：darwin-arm64，8 核，Node 24.18.0，Git 2.50.1 (Apple Git-155)。该组 load 6.81→6.63，`highLoad=false` 但接近上限，不称空闲机；这是固定 API 场景的受控 L2 观察，不代表屏幕绘制、日常 p95 或 L3，不能把全部差值归因到优化。首次 baseline 和裸 HEAD index 候选均为高负载，完整保留，不纳入最终组；裸 index 丢失 stat hints 的大仓库退化已修复为保留时间戳的副本。

全部内容哈希次数为 **unavailable**（Git 没有暴露完整内部计数），不能把 0 对象写入说成 0 哈希。4 个新对象为 3 个去重后的 blob + 1 tree；计数包含临时库和真实仓库。

## 红线核对

1. **不执行仓库代码**：配置先读；所有工作树 Git 读取均走 `snapshotGitArgs`，复用 `loadSnapshotOverrides` 的 clean/process/required 覆盖、禁 hooks、禁 fsmonitor。所有 diff 保留 `--no-ext-diff --no-textconv`。filter 名保留大小写。只读命令额外设置 `GIT_NO_LAZY_FETCH=1`，缺失 promisor 对象不触发仓库配置的 remote helper/core.sshCommand。
2. **等价或明确不可用**：oracle 为原样保留的 `gitNumstat`；修改、新增、删除、暂存后继续修改/删除后重建、未跟踪、空文件、binary、中文/tab/换行路径、symlink、scope、excludedPaths、ignored、非 Git、无 HEAD、失败和 deadline 都有测试。已发现不能等价的情况不返回成功空列表，见下表。
3. **状态语义**：仍为 `captured / unavailable / timeout / failed`；失败文件列表不冒充 captured。新增 workspace-specific reason，由集中 copy 模块解释。来源时间是读取开始时间，不是跨文件原子快照保证。
4. **Recorder 隔离**：`beginGitTurnDiff`、finish/preview/session/managed recorder 函数体不改；AST 比较核对旧 Git 函数体，仅共享 loader 增加可选预载配置键，recorder 默认调用和行为不变。Core 不引入 Electron/SQLite/native，CLI 构建通过。

| 明确不可用的范围 | reason / 原因 |
|---|---|
| scoped assume-unchanged / skip-worktree | `workspace_index`。旧路径 clean/dirty 分支对这些标记的行为不同，不选择一种解释静默改变合同。 |
| 暂存的 `.gitattributes` 改动 | `workspace_attributes`。临时 HEAD index 会改变属性 fallback，不冒充原始 index 的解释。 |
| 未跟踪文件需 autocrlf true/input、text/eol/ident/working-tree-encoding 转换，或使用命名 diff driver | `workspace_attributes`。不把原始字节的行数/二进制探测冒充规范化 blob；包括 CRLF 与 bigFileThreshold 边界。 |
| 发生改动的 gitlink / 子模块 | `workspace_submodule`。直接 worktree diff 的 dirty 状态不能冒充旧快照的 commit-only 语义。 |
| 非文件/非 symlink 的未跟踪路径（如嵌套仓库目录） | `workspace_file_type`。不静默遗漏。 |
| >1000 条变更、未跟踪总量 >16MiB、未跟踪路径输出 >128KiB | `workspace_limit`。Git stdout 另有 16MiB 上限，整个读取预算 5 秒。升级需先增加相应工作量与等价性测试，不自动回退昂贵快照。 |

## 验证

源码冻结为 `0dcd7fe` 的内容（检查时尚未提交，提交仅写入相同文件）。App 0.2.219 / CLI 0.2.51，Electron 42.10.1；均为本地测试构建，不是已安装版本。

| 检查 | 结果 / 证据 |
|---|---|
| `npm run test:unit` | **3711 pass / 4 既有 opt-in skipped**，299 文件通过；包含 main git 50、只读等价/降级 11、terminal pair 10、IPC 边界/合并 2，以及全部 recorder tests。`/tmp/scry-c-unit-frozen.log`。 |
| focused | 开发中完整受影响范围 694 pass；最终只读专项 11 pass。新增覆盖 oracle 等价/明确降级、用户 index 字节/mtime 及对象库不变、filter/hook/fsmonitor/textconv 和 lazy-fetch 副作用拒绝。 |
| `npm run typecheck` / `npm run build:cli` | 最终源码通过；CLI 无 Electron/SQLite/native 依赖新增。 |
| `npm run test:source-control:ui` | 真实隔离 App/main/preload + 临时真实 Git 通过；新增生产 `agent:gitDiff` 验证未跟踪行数、来源时间和 index 字节不变。原提交/取消暂存/本地 bare remote push/hook 拒绝等相邻路径仍通过。 |
| `node scripts/session-capability-ui-smoke.mjs --workspace-diff-only` | 真实 Electron renderer/native input 通过：刷新保留文件和计数、来源时间、同 cwd 乱序和旧 cwd 回复拒绝、失败不当作无改动；Git API 是受控 fixture，不冒充真实 main 证据。 |
| `node scripts/electron-security-smoke.mjs --dev` | 完整本地 fake-provider 安全冒烟通过，含生产 preload/main 的 not_git、非法输入、未授权目录和 symlink escape 拒绝。无真实 Provider 调用。 |
| `npm run test:renderer:ui` | **未全绿**：前三组（session-opening、session-capability、Credits）通过，chat-preview 中 workspace dirty 标记超时。`bf92d04` 的独立 detached worktree、相同依赖上复现完全相同失败；候选单跑也同样失败，未改本批外实现/断言/超时。 |
| renderer UI 剩余 11 组 | 在上述失败之后逐组原命令执行全部通过：session-performance、background、steer、remote-queue、desktop-remote、session-parity、composer-history、remote-settings、session-lifecycle、conversation-ipc、pi-history。`/tmp/scry-c-ui-remaining-results.log`。未声称复合入口通过。 |
| `npm run performance:measure -- --scenario source-control.diff --out /tmp/scry-c-performance-frozen` | 既有 gate 8（5 次稳定）pass；total candidate 8 unchanged，无 worse。此 collector 走未改的 `readWorkspaceGitDiff`，不是新 numstat 的收益证据；新路径看上面的冻结 bench。workspace.files 映射目前没有对应 collector，不伪造计数。 |
| ratchet/feedback tests / ledger guard | **24 pass**；旧台账→当前 guard 通过，无台账改动、无放宽、无升门禁。 |
| `git diff --check` / 源码审查 | 通过；AST 比较所有旧 Git 函数体，除 loader 可选参数外均原样保留。三项独立评审发现已补回归并修正，复审无具体遗留问题。 |

当前唯一阻断完整 UI 绿色的项是基线同样失败的 workspace 编辑 dirty 标记，不属于 Git diff 路径。由对应 workspace/UI 维护者另起修复；本批不扩大范围。未测试 Linux、其他 Node/Git 版本、真实 Provider、安装或日常 L3。

原始日志均保留 `/tmp/scry-c-*.log`。Node SQLite addon 已恢复；Electron ABI 专用副本保留 `/tmp/scry-c-electron-native/`，不影响日常 App。用于基线复现的 detached worktree 在交付前移除。

开发中失败均保留：首轮等价性测试 3 失败（skip-worktree 非等价、empty -diff binary 标记、fixture hook 自己成为未跟踪文件）；已分别以明确不可用、正确 binary 标记、将 hook 放入 `.git` 修正。首轮全量 3707 pass / 1 failed / 4 opt-in skipped，特殊 index 的合同与实现处于切换中；不作为交付通过证据。首轮 renderer UI 在 Credits 被 Node/Electron SQLite ABI 137/146 不匹配阻断，后续通过使用对应 ABI 的独立依赖构建验证，不删断言、不延长超时。

负对照：开发中临时恢复 fixture 的仓库 post-index-change hook 后，测试确实失败，产生 `executed` 文件；恢复禁用后通过。缺失 promisor 对象测试另有真实 Git lazy-fetch 控制：未禁用时 fixture sshCommand 写 marker，生产只读路径失败且 marker 不存在；均无外部网络访问。

## 交接与状态

用户本次明确要求更新 STATUS，覆盖 README/C.md 的并行分支一般约定：仅更新 C 为待核验，不代替审查方标记已核验。

后续由审查方在 `perf/handoff` 核验本报告并决定合入；合入、安装、日常 L3 均不在本次分支交付中。L3 需部署后同场景 ≥30 样本、≥2 会话。无付费 Provider 探针、无远端服务写入；仅 push 到授权的 `perf/c-git-readonly`。

## 核验意见（审查方，2026-10-22）

结论：**已核验**。审查方未能在本会话重跑测试（网络策略拒绝 npm registry），依据是逐行读 `0dcd7fe` 的 diff 与本报告的命令记录。

- **recorder 隔离**：`beginGitTurnDiff` 及 finish/preview/session 路径未改；`loadSnapshotOverrides` 只多了可选的预读配置参数，默认调用行为不变。
- **不执行仓库代码**：所有读取工作树的命令都经 `snapshotGitArgs` 和 filter 覆盖；`diff` 保留 `--no-ext-diff --no-textconv`；读真实 index 的 `ls-files -v` 和 `diff --cached` 不触碰工作树，也不会触发 clean filter。`GIT_NO_LAZY_FETCH=1` 是交接文档没要求的额外防护，做得好。
- **默认排除**：IPC 路径不传 `excludedPaths`，与旧 `gitNumstat → beginGitTurnDiff(cwd)` 的默认值一致。
- **证据诚实**：无法等价的情况（skip-worktree、暂存的 `.gitattributes`、需转换的未跟踪文件、子模块、超限）显式返回 `unavailable` + reason，不返回成功空列表。不做已完成结果的缓存也是正确判断。
- **收益口径如实**：spawn 8→8 没有减少，只消除了对象写入（4→0）；受控 p50 下降约 20%，机器负载接近阈值，已标注。

非阻塞建议（可在后续顺手做）：

1. 未跟踪的普通文件先 `lstat` 再 `open(absolute, 'r')`，两步之间可被换成符号链接。影响只是行数统计读到工作区外的文件，不泄露内容；可改用 `O_RDONLY | O_NOFOLLOW` 打开。
2. renderer 在 render 中读取 `gitDiffCwdRef.current`；目前每次 setState 都会触发重渲染，所以结果正确，但这依赖调用顺序，日后改动时留意。

## 建议 1 的后续加固（2026-10-23）

按用户要求，仅处理建议 1，不改建议 2 或 STATUS。未跟踪普通文件使用 `O_RDONLY | O_NOFOLLOW` 打开，拒绝 lstat/open 之间替换成的符号链接；原本就是 symlink 的路径仍走 readlink，不改变原有语义。

新增确定性竞态回归：在真实 lstat 返回后，将未跟踪文件换成指向工作区外的 symlink。外部文件与原文件等长但行数不同，避免测试被尺寸上限误挡。旧实现确定失败（返回 captured、统计外部 3 行）；加固后返回 failed/git_error，无成功文件列表。

验证：focused 74 pass；完整 unit 3712 pass / 4 既有 opt-in skipped；typecheck、App build、CLI build 通过。`performance:measure --scenario source-control.diff` 为 gate 8 pass / total 8 unchanged，无 worse；不宣称新增性能收益。原始日志 `/tmp/scry-c-nofollow-*.log`。未安装 App，未合入 main。

### 核验意见 · 跟进（审查方，2026-10-23）

`5daa809` 已核验：未跟踪普通文件改用 `O_RDONLY | O_NOFOLLOW` 打开；回归测试在 `lstat` 与 `open` 之间把文件换成指向工作区外的符号链接，确认结果是 `failed` 而不是读到外部文件。建议 2 不改，同意。
