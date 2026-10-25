# Diff workbench：v4 设计落地

## 范围与入口

在 `feat/workspace-diff-worktree` 实现已确认的 v4 方向，基于 `529eb406`。只修改独立 `scry-workspace-diff` checkout；不改原 checkout，不合并、不推送、不安装。

- 保持现有右上角摘要 / 侧栏图标及右侧 Surface 入口；不新增带统计的顶栏 Diff 按钮，不默认展开。
- 左侧 Files / Commits 导航，右侧连续文件 patch；文件折叠、Unified / Split、已保存上下文展开。
- 字号沿用紧凑界面：代码 11.5px，导航约 11–12px；代码行和文件标题的交互高度 24px。
- 复用现有右侧分栏的拖动、最大化、恢复、关闭与窄屏逻辑。没有重做 App 外壳或会话导航。
- 四个范围仍是 Changes、Uncommitted、Latest turn、Turn。保留底层 session/turn 证据，不恢复“本会话”菜单。

## 数据与权限

```text
Changes 已捕获的 baseCommit + HEAD
  → typed preload → trusted IPC + 每次 cwd 授权
  → 本地 base..HEAD 提交分页
  → 所选不可变 commit 与第一父提交比较
  → 原有临时 index/object store + patch 预算
  → 左侧导航 / 单一虚拟化代码视口
```

`gitDiffCommits` 和 `gitCommitDiffSnapshot` 不接受任意 Git 参数。主进程验证完整 SHA、分页 offset 和已授权目录，并 canonicalize cwd。每个调用者都先授权，之后才允许同请求合并；最多四个不同请求在途。生产 trusted wrapper 的 sender/frame/origin 拒绝路径有测试，拒绝时特权读取函数不能执行。

历史固定于捕获时的 base/HEAD，不 fetch。所选提交必须属于 `reachable(HEAD) - reachable(base)`；合并提交明确与第一父提交比较，根提交与临时空树比较。只读真实 Git 对象，不改真实 index/object store，不执行 external diff、textconv 或签名程序。

统计和正文来自同一不可变 tree pair。切换范围时清除已取消请求的状态，旧响应不能恢复旧视图；选定提交处于 loading/failed 时不显示分支正文或假零统计。真实空提交才显示零文件。

主要模块：

- `src/core/turn-recorder/git-diff-history.ts`：固定范围、本地分页、不可变提交快照。
- `src/main/git-diff-history.ts`、`src/shared/diff-history.ts`、`src/preload/index.ts`：窄 IPC 合同及授权。
- `src/renderer/hooks/useDiffCommitHistory.ts`：惰性加载、请求代次与范围切换。
- `DiffNavigation.tsx`、`DiffFiles.tsx`、`StackedDiff.tsx`、`diff-stack.ts`：导航及有界堆叠视图。
- `diff-lines.ts`：提取原 parser，Source Control 与 Review 共用；保留旧测试消费者需要的 re-export。

## 展示边界

- 提交每页 50 条，最多 1,000 条；达到上限标记 truncated，不冒充历史结束。单页元数据最多 256KiB。
- 复用快照上限：1,000 文件、256KiB patch、默认五秒。只读 review 保存最多 20 行 Git hunk 上下文；recorder 历史仍保持原有三行合同。
- 只能展开确实保存在 patch 中的上下文。旧历史缺失的正文、hunk 间未记录的代码，不从当前工作文件重建。
- 单次堆叠投影最多扫描 1,000,000 个 UTF-16 字符。优先选中文件，保留所有文件标题；到达预算明确显示部分正文，不删除原始数据。单个超大文件也可能只显示前缀。
- 如果需要越过此展示预算，应接入已有授权 recorder-content 分页，并为缓存/索引设总上限；不能取消预算或用实时文件冒充历史。本轮未新增完整历史正文分页加载。
- 文件列表与代码视口虚拟化。Split 的两个列框保持在视口内，行号固定，一个水平滚动位置同步移动两侧代码。展开按钮消失或 Home/End 使原按钮移出虚拟视口时，焦点留在代码视口。
- `storage: complete` 不代表 `sourceCompleteness: complete`；部分来源仍显示警告。

## 验证

环境：macOS arm64，Node 24.18.0，Electron 42.10.1；App 0.2.222，CLI 0.2.51。只用独立 userData/HOME 和临时 Git 仓库，未调用付费 Provider。

| 检查 | 结果 | 证据 |
|---|---|---|
| 全量 unit | 333 文件、3,926 tests 通过，4 opt-in tests 跳过 | `/tmp/scry-v4-unit-delivery.log` |
| 最后 UI 焦点调整及未引用文案清理后的 renderer 复验 | 5 文件、270 tests 通过 | `/tmp/scry-v4-renderer-delivery.log` |
| 最终 typecheck | node/web 均通过 | `/tmp/scry-v4-typecheck-delivery.log` |
| CLI release check | 627 tests、独立构建与 package smoke 通过 | `/tmp/scry-v4-cli.log` |
| shell | 通过 | `/tmp/scry-v4-shell.log` |
| 当前生产 App workspace UI | 通过，真实 Git/IPC + 原生输入 | `/tmp/scry-v4-ui-delivery.log` |
| React 请求竞态隔离 fixture | 范围返回、旧分页/旧提交响应拒绝通过 | `/tmp/scry-v4-history-delivery.log` |
| 性能计数门禁 | 五次 git/total 均为 8，ratchet 通过 | `/tmp/scry-v4-performance/measure.json` |
| 最终 pack:artifact | 构建、包检查、Electron/文件/remote host smoke 通过 | `/tmp/scry-v4-pack-delivery.log` |

四个 opt-in skip 是 P0/P1、billing-admin-real 和性能 correlation。没有把跳过项算作通过。

生产 UI 验证包括：真实提交列表与单提交正文、工作区脏改动不混入提交、旧提交切换、返回全部改动、真实上下文、左右行号 21 对齐、窄栏双列同时可见、原生水平滚动同步、拖动/最大化/恢复/关闭/原入口重开；1,000 文件 / 2,000 行下的有界 DOM、折叠、键盘焦点、End/Home 与滚动；四范围和既有原子 first-send/失败恢复也通过。

最终截图目录：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workspace-session-ui-KvpEBZ`。截图是隔离 App 的真实渲染，不是设计稿或模拟 DOM。

性能结论只覆盖已有 `source-control.diff` 工作量计数。新提交浏览、单提交快照和堆叠渲染没有专用性能门禁，缺口已记录在 `performance-paths.json`；不宣称 L2/L3 加速。

## 首轮失败与负向对照

- 初次全量运行被工具的 300 秒执行期限截断；当时仍在推进，没有最终 Vitest 汇总。确认该仓库已无残留 Vitest 后重跑完成；没有扩大单项测试超时。
- 首次完整 unit 有三处失败：preload 精确 API allowlist 未登记新方法；统一 Diff 的既有 class 合同未复用；分页 fixture 逐提交启动 Git 在完整套件下超过五秒。修复 allowlist、复用 `unified-diff`，用一次真实 `fast-import` 构造相同的提交链；没有删断言或缩小分页负载，并新增 1,000 提交上限测试。随后全量通过。
- 真实 UI 首次误命中保留的隐藏会话按钮，改为限定 current surface。随后原生 Home 不能返回堆叠开头；单换绝对虚拟化布局不能解决，显式 Home/End 处理才通过。日志保留在 `/tmp/scry-v4-ui-*.log`。
- 新竞态测试在修复前确实失败：范围离开后返回，取消的 pending 页被复用，`pageCalls` 停在 1。`/tmp/scry-v4-history-negative.log`；清除范围状态后同测试通过。
- 视觉检查发现旧 Split 把第二列放到了窄视口之外。新增几何断言对旧构建失败：视口 `[1100,1440]`，第二列 `[1518,1936]`。`/tmp/scry-v4-split-negative.log`；改为固定双列框与同步水平滚动后同断言和原生滚动检查通过。

## 交付状态与未验证项

- 开发产物：`dist/mac-arm64/Scry.app`，包检查 298,737,901 bytes，低于现有上限；开发证书签名，未公开 notarize。
- 不安装，不替换 `/Applications/Scry.app` 0.2.223，不 push/merge，不升版本。
- 本轮没有宣称整个 `test:renderer:ui` 门禁为绿；之前已在基线复现的远程模型文案与 scrollbar 断言失败不在本次修改范围。
- 真实付费 Provider、手机端和完整屏幕阅读器验收不属于本轮证据；独立 Electron fixture 不是这些验收的替代品。
