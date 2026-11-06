# 方案 C：CLI diff 正文只内联一份

用户已批准 C：保留 `patchContent.content` 中的完整正文及其引用，去掉记录内重复的 `patch`。
这不是 D；不增加按需加载，不修改已有记录，不改变序号分配、重复提交判定或 fsync / 原子发布。

## 范围与调用链

`recorder-turn-finalize.ts` → `persistTurnDiffContent` → `aggregateTurnEvidence` → `commitRecord`。
只在 CLI / daemon 自行采集 Git diff 后生成持久化快照时去掉重复字段，原始 Git 快照不变。
`patchContent` 的正文、UTF-8 字节数、完整性、SHA-256 引用和内容库中的完整副本全部保留。
二进制、不可用与空 patch 不改；旧记录仍走原有读取路径。

App managed canonical handoff 不经过这个 Git 正文生成函数。本次不改它的证据结构、prepared
工件、原始 trace、重复提交校验或 App 展示代码；不能据此宣称所有 App 记录都已去重。

已检查的消费者：

- `store-index.ts` 校验与读取记录；`store.ts` 导出；`store-archive.ts` 归档与正文引用复制。
- `turns-summary.ts` 只使用文件变更元数据，不依赖 `patch` 正文。
- `normalizeTurnDiffSnapshot` 接受带 `contentRef` 的 `patchContent`；其旧 `patch` 长度限制不影响
  新正文。`diff-stack.ts` 已能从 `patchContent.content` 展示完整正文，无需新增读取接口。
- `turns content` 通过 `recordContentItems` 提取引用，不依赖是否保留 `files[].patch`。

自建 uploader 只读 `patch` 的实现需要改为读取 `patchContent.content`；未验证仓库外消费者。
合同说明已补到 `packages/turn-recorder-cli/docs/storage-and-performance.md`。

## 验证证据

新增 `recorder-diff-storage.test.ts`：超过 110 万字符的 Unicode patch，真实写盘，验证正文逐字节
读回、引用内容、共享解析器、原始快照不变，以及恰好省下一个 JSON `patch` 字段的字节数。
旧代码运行时在“不应存在 patch 字段”的断言失败（1 failed / 1 passed），修改后通过。

增强真实 Git 轮次测试：落盘、list、export、archive 后均保留同一份完整正文和引用。
renderer 投影测试同时覆盖旧双字段与新单字段格式，无需网络或引用读取。

另以构建后的 CLI 子进程，在临时 workspace / HOME / state 运行真实 start → 修改文件 → Stop：
以独立 `git diff HEAD -- file.txt` 为正文 oracle，检查 show、export、verify、content 分页及旧双字段
记录读取。没有启动真实 Provider、没有改真实 `.scry`，临时工作区自动删除。

| 环境 | patch UTF-8 字节 | C 记录字节 | 旧双字段记录字节 | 减少 |
|---|---:|---:|---:|---:|
| macOS / Node 24.18.0 | 2,760,134 | 2,994,634 | 5,984,786 | 2,990,152 |
| Linux guest / Node 24.22.2 | 2,760,134 | 2,994,371 | 5,984,523 | 2,990,152 |

数字来自同一记录补回旧 `patch` 字段的对照；非正文元数据不变。记录约减半，内容库体积没有减少。
减少的工作是真正不再序列化、写入和读取那份重复字段，不是移到后台或删除证据。

## S5 配对复测（不宣称额外内存或速度收益）

固定原有 S5 workload，before → after → after → before，每次新进程 3 轮，两侧各 6 轮。
测量脚本未改。baseline 为 `315e3639`（与本轮 `56620f73` 的相关源码一致）；candidate 只多
`recorder-turn-state.ts` 的 C 改动。构建模块哈希、逐轮数据、命令和负载见
[机器可读记录](../../../performance-experiments/20261106-recorder-c-inline.json)。

| 指标 | before | C |
|---|---:|---:|
| end 毫秒中位数（6 轮） | 10,545.15 | 9,781.30 |
| end git 进程数（每轮） | 7 | 7 |
| end RSS 增量最大值 | 378.9 MB | 319.2 MB |
| end RSS 绝对峰值最大值 | 529.6 MB | 583.1 MB |

宿主与 guest 都使用 `timing-run.mjs` 加锁。guest 负载低，但宿主负载 20.63 → 11.16 / 10 核，
`highLoad: true`；VM 并不隔离宿主 CPU / 内存争用，因此不能据此确认 L2 加速。
绝对 RSS 峰值反而升高 53.5 MB：最高样本的阶段起始 RSS 也升至 269.7 MB，增量为 313.5 MB；
尚不能据此归因代码或 GC，不重复刷样本。此次只确认删除重复字段的存储收益，撤回此前
“C 峰值约 210 MB growth”的未验证估算。

## 最终检查与自查

| 检查 | 结果 / 完整日志 |
|---|---|
| 修复前负对照 | 新用例按预期失败，`/tmp/scry-c-negative.log` |
| macOS 最终 Recorder 全套 + diff-stack | 47 文件 / 531 passed，`/tmp/scry-c-recorder-final.log` |
| Linux focused 回归 | 3 文件 / 16 passed，172 个非目标用例未选中；guest `/tmp/scry-c-focused-linux.log` |
| 真实 CLI 子进程，macOS / Linux | 均通过，`/tmp/scry-c-cli-{mac,linux}.log` |
| `npm run typecheck` | 通过，`/tmp/scry-c-typecheck-final.log` |
| `npm run build:cli` / `npm run build` | 通过，`/tmp/scry-c-build-cli.log` / `/tmp/scry-c-build-app.log` |
| `npm run performance:measure -- --scenario recorder.content-reuse --out /tmp/scry-c-performance` | 6 个指标通过 ratchet，`/tmp/scry-c-performance.log` |
| `npm run test:unit -- --maxWorkers=1` | 初跑 5471 passed / 3 failed / 4 skipped，1246.64 s，`/tmp/scry-c-unit.log` |

全量初跑中的 Qoder Q01 仍断言旧 `patch` 字段，已改为断言无重复字段且正文包含同一新增行，
没有削弱轮次边界检查；随后该测试所在的完整 Recorder 套件通过。
另两项是 `hook-skip-recency.test.ts` 和 `scry-doctor.test.ts` 的 pending / stale-open 诊断失败。
在未修改的基线 `56620f73` 临时 worktree 上同样复现 2 failed / 13 passed，日志
`/tmp/scry-c-baseline-doctor.log`。本轮未改 doctor、attention 或其测试；这两项留给独立 R3 诊断修复。
没有重跑 20 分钟全量来掩盖结果，不宣称全量绿。

自查：仅批准的 CLI 新记录重复字段变化；序号、去重、原子发布和正文完整性未变；新增测试、
真实 CLI 与旧格式对照覆盖核心合同。未推送、未发布、未安装全局 CLI，验证构建不等于日常版本已升级。

## 限制与生效

- C 仍把完整正文放在记录里，读大记录仍有成本；不宣称达到 D 的按需加载效果。
- CLI 子进程验收通过不等于真实 Provider / daemon 长期运行或桌面 App 真机交互验收。
- 旧记录不迁移；已有记录体积不会自动减半。需要构建并部署新版 CLI，后续新生成的轮次才使用 C。
- 不安装全局 CLI、不发布 npm、不改用户正在运行的 daemon，也不操作 main 分支。
