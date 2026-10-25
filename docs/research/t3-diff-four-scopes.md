# Diff 四项菜单与 v3 设计稿

本轮按维护者要求，替代先前设计中的「本会话」菜单和不可点击的「改动」标题。只保留 Changes、Uncommitted、Latest turn、Turn。

## 已实现的范围

- **Changes**：比较基准与已观测 HEAD 的 merge-base → 同一次捕获的工作树。包含分支已提交变化和当前未提交变化，不归因于某个会话。
- **Uncommitted**：已观测 HEAD → 捕获的工作树。
- **Latest turn / Turn**：最新实际轮次 / 指定轮次的历史快照。缺失证据不回退到其他范围。
- 默认打开 Changes。删除本会话菜单与主界面旧的会话 diff 跳转入口；保留 recorder 的会话基线、历史记录及其他既有消费者，不删除持久化证据。

语义依据：T3 Code `d14ace8233ad3cf7856b6b834824f888240d67a1`，`DiffPanel.tsx` 的 `branch-range` / `working-tree` 选择及 `GitVcsDriverCore.ts` 的 `resolveReviewMergeBase`。此前把 Changes 当作标题或会话范围的解释不正确。

## 比较与边界

复用现有 `readWorkspaceDiffSnapshot`、临时 index/object store、同树统计/patch 投影和可信 IPC。新增范围参数仅接受 `branch` / `workspace`；并发合并键包含 canonical cwd 和范围，每个请求仍重新授权。

基准优先使用现有 `branch.<name>.gh-merge-base` 配置；否则使用本地缓存的主远端 HEAD、main、master。主远端取 origin；没有 origin 时只使用唯一远端，多个远端时不任意猜选。不存在可比较分支或 detached HEAD 时，按 T3 行为使用已观测 HEAD，并明确返回 `baseRef: null`，UI 显示 HEAD，不冒称 main。已选基准没有共同祖先时返回失败，不退化为零。

本轮没有手动基准选择器，没有 fetch，也不执行远端 helper 来补齐对象。refs、差异文件各上限 1,000，继承工作区 5 秒捕获预算和 256 KiB patch 预算。超过上限明确不可用；大型仓库需要基准选择/定向查询时再扩展，不能悄悄截成完整结果。

## 新设计稿（尚未接入 App）

用户指定的 `/huashu-desigin` / `huashu-design` 在本机未找到；经结构化确认，改用 **impeccable / Operate**。

本机路径：`designs/scry-workspace-diff/v3/`。此目录沿用仓库 ignore 策略，不强制加入 Git。

按用户截图：四项浮层、左侧文件与 Commits、顶部比较范围、右侧 Unified / Side by side、折叠上下文、代码语法颜色与增删行号。不加新标签页、设置面板或说明卡片。设计稿是可交互示例，不是实际 Git/commit 查询；这部分完整布局待设计确认后另行实现。

## 验证

| 检查 | 结果与证据 |
| --- | --- |
| Typecheck + focused | 10 文件、142 测试通过；`/tmp/scry-four-scope-unit-final.log`。新增 Git fixture 区分已提交/未提交、merge-base 与基准 tip、缓存 remote HEAD、gh-merge-base、无基准和无共同祖先。可信注册 wrapper 拒绝非法 scope，另外验证不同 scope 不错误合并。 |
| 负向对照 | 暂时改回 HEAD 比较后，关键测试因缺少 committed.txt 失败；恢复后通过。`/tmp/scry-branch-negative.log`。 |
| 生产 Electron UI | `npm run test:workspace:ui` 通过；真实临时 Git + 离线 Provider，4 项菜单逐项可用，Changes 保留已提交文件，Uncommitted 正确为空，历史轮次不读取当前文件。另保留工作区三种首次发送、键盘、浅色、窄屏验证。`/tmp/scry-four-scope-ui-final2.log`；截图目录 `scry-workspace-session-ui-85oxdn`。 |
| CLI 回归 | `npm run check:cli-release`：627 测试、NodeNext/build、独立包 smoke 通过。`/tmp/scry-four-scope-cli.log`。 |
| 性能计数 | `source-control.diff` 两项计数各 8，五次重复，ratchet 通过。`/tmp/scry-four-scope-performance/measure.json`。不是新分支比较的耗时测量，不宣称更快。 |
| 设计稿 | 3 个 Node 状态/patch 排列测试通过；Chrome Relay 实际检查 1512×708 下的四项菜单、Changes/Uncommitted/Turn 1 切换、Unified 和并排画面。 |

首轮新增 IPC 测试把同步 authorization mock 写成 async，typecheck 正确拒绝；已修正测试签名，未放宽合同或断言。没有新增 skip。自审补正了未绑定工作区时 Changes 不应显示「发送后开始记录」，并补三项静态回归；SSR 会输出现有 useLayoutEffect 警告，实际交互另由 Electron fixture 验证。

未运行全量 App renderer gate；此前已确认的远端模型标签/滚动条失败不在本次范围。没有调用真实付费 Provider，没有替换 `/Applications/Scry.app`，没有 push。
