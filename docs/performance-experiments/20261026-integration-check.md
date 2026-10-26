# 2026-10-26：独立集成验证——尚未通过

> 历史首轮记录。通知实现提交后，[第二轮完整检查通过并提交独立合并](20261026-integration-r2.md)。本页首次失败保留；两项UI偶发问题没有被宣称修复。

## 范围与当前结论

用户选择“独立集成验证”：只组合开发分支已提交HEAD与性能分支，保留原工作区WIP，不修改原分支、不安装、不推送；有需要取舍的冲突再询问。

集成树已生成，**没有文本冲突，但验收未通过，因此未提交合并**。完整unit中的12项失败已在未合入性能改动的开发基线复现；完整UI另有两处首次失败，独立检查没有复现，仍未定因，不能以随后通过抵消首次失败。

## 冻结输入与隔离

| 输入/产物 | 身份 |
|---|---|
| 开发基线 | `d837ed229126a58c9385348eefa241545595c0b4`，`reliability/collection` |
| 性能分支 | `2a7a167cac57ec4fd7e7009155019b5e02dc7f76` |
| merge base | `d822f840d1525a4938e3c9085a8b38e2056feb42` |
| 已核验集成tree | `7dec28cd2284a88e9ebb40ee03012073db23b4f9` |
| 本机独立分支 | `integration/performance-climb-20261026`，HEAD仍为开发基线，merge未提交 |
| 本机构建工作区 | `/private/tmp/scry-performance-climb-20261025.yjlnNW/integration` |
| mac2候选/对照 | ownedroot中的`integration`与`integration-before` |
| 本轮App构建 | 0.2.221，build `d5031cd03be4b8d58551ad642e3fdf9e5ace508230a6494e69f9b31a44e7858d`，未安装 |

两侧相对merge base没有同路径修改。正常`merge --no-commit --no-ff`产生92个暂存改动文件，完整文件20KB门禁及diff检查通过。mac2从相同开发commit创建独立worktree，应用相同binary patch，`git write-tree`与本机逐字相同；没有复制原开发工作区的未提交文件。

原开发工作区开始时有9项未提交改动，后续又新增CLI文档等改动，最新只读快照共13项；HEAD仍是`d837ed22`。这是另一项任务在继续工作，不是本轮修改。不要据此重置、提交或复制其WIP。

根`package.json`及lockfile在两侧完全相同。mac2复用owned candidate的依赖，不碰宿主其他项目。Node24.18.0/Electron42.10.1；完整unit之前切到已验证的Node137 SQLite绑定，之后恢复Electron146。

## 完整unit：失败属于冻结开发基线

命令：

```sh
npm run test:unit -- --maxWorkers=2 --no-file-parallelism --reporter=json --outputFile <owned-results>/unit.json
```

结果：359文件、4086用例，**4070通过、12失败、4项既有opt-in探针跳过**。类型检查和`build:cli`均通过。没有增加测试超时、skip或改断言。

全部12项失败位于`src/core/turn-recorder/commit-delivery.test.ts`，覆盖：失败序列计数、五次失败后dead-letter、后续记录继续交付而不伪造连续ACK、损坏状态fail-closed、全局trust拒绝不计为记录失败、按时间退避、冷启动不绕过重试时间、显式重放及trust拒绝前不改状态。

对未合入性能分支的`d837ed22`单独运行同一文件：2通过、12失败。集成树focused同样为2通过、12失败。三份JSON报告的失败名称和**完整失败消息**仅规范化worktree根路径后逐项完全一致，哈希及名称见[证据](20261026-integration-evidence.json)。这不是凭“文件未改”推测为既有失败。

例子：重放命令在冻结实现中仍返回CLI usage；快速drain/冷启动没有满足新测试要求的重试调度。原工作区恰有对应CLI/notification实现WIP，但本轮不借用这些未提交内容，也不在另一分支重复实现后宣称它已完成。

## UI：保留首次失败，不报全绿

原始`npm run test:renderer:ui`在第7段`--overlays-only`失败。随后只继续尚未执行的第8–26段；其中第23段`--session-lifecycle-only`又失败，最后第24–26段另行完成。

| 范围 | 结果 |
|---|---|
| 原始27段命令 | 25段首次执行成功；第7、23段失败；没有一次完整串通过 |
| 第7段 | `Surface menu did not restore its trigger` |
| 第23段 | `Pointer geometry did not settle: .modal-foot button [删除 Scry 副本]` |
| 未合入性能改动的开发基线 | 独立overlays与lifecycle各执行一次，均通过 |
| 当前集成的独立诊断/对照 | overlays诊断复制件、未修改的lifecycle各执行一次，均通过；不抹掉原始失败 |
| 其他实际检查 | Credits、四个独立DesktopRemote场景、真实临时Git的production App、生产conversation ownership/unified IPC、Pi历史恢复均执行成功 |

两次首次失败都发生在`highLoad=false`的检查中，不能直接归咎于负载。基线单独通过不证明是集成回归；候选单独通过也不证明首次问题已修复。当前归因仍为unknown，未改产品代码或断言来猜测性修补。

已检查实际focus恢复路径、`usePresence`、Surface菜单、确认弹窗场景及原生pointer命中/动画等待合同。这些focus组件、原生pointer helper在此次合并中没有源码差异，但性能分支的hook变化可能影响时序，不能仅凭该事实排除影响。

临时overlays诊断仅存在于owned结果目录：保持原相等判断、所有业务断言和时限，附加focus观察。生成器最初两次因匹配到normal/reduced-motion两段相同调用而拒绝，**没有启动UI或写产品文件**；读出两个上下文后改为唯一行边界。诊断随后通过，但子进程的附加focus stdout被既有外层runner丢弃，没有取得可用于解释首次失败的focus快照。因此没有声称已定位原因。首次失败窗口已退出，静态fixture文件不能还原当时activeElement或命中状态。

后续由本agent在下一次集成验收的失败路径保留focus/geometry状态，继续定位，不通过循环重跑、扩大时限或等待所有动画结束来弱化原有交互合同。

## 性能对照：既有收益在新开发基线上仍成立

执行`performance:measure --compare d837ed229126a58c9385348eefa241545595c0b4`，两侧使用同一冻结测量实现、lockfile及固定负载。没有新性能实现或新L2提速宣称。

| 固定工作量 | 开发基线 | 集成树 |
|---|---:|---:|
| 无分析消费者的5次dataUpdated，SQL queries | 130 | 0 |
| 既有内容复用，SHA调用 | 64 | 32 |
| 四份双权威新内容，目录metadata操作 | 167 | 85 |
| 四份双权威新内容，sync调用 | 116 | 88 |
| 20次远程尾部投影，既有前缀读取 | 100020 | 0 |
| 同场景数组复制前缀读取 | 100000 | 100000 |

唯一较该开发基线增加的计数为cold stat：36→44，是已记录的“先stat避免必然失败的mkdir”交换，不是隐藏回归。目录总操作减少，不以单个stat上升误判整体；也不删除这一`worse`。

全部gating通过，74项观测/77项登记。仍有三个历史candidate `worse`：readdir20对18、archive IPC10558对10536、cold stat44对36；三个CPU candidate未测，不记0。本轮没有改任何基线、容差或门禁。

两侧显示revision均为`d837ed22-dirty`，因为baseline也会复制冻结harness。**不能仅凭显示revision判定源码相同**：权威输入分别是开发commit及候选tree/patch；完整原始比较与measure清理证据保留。由工具创建的临时baseline worktree已清理，专门保留的开发对照worktree不清理。

## 状态、证据与下一步

- 集成merge未提交：本机保留`MERGE_HEAD`和92文件暂存树；mac2保留相同暂存树和隔离依赖链接。它们不是用户原工作区的WIP。
- 本报告在性能分支单独提交，不把失败的集成树提交为已通过版本。
- 未改原开发分支、未安装、未推送、无真实付费Provider、无L3。
- 原始日志、完整unit/对照JSON、冻结输入bundle、patch及失败fixture路径保存在`/private/tmp/scry-performance-climb-20261025.yjlnNW/results/mac2-integration-20261026/`。
- 最后扫描未见以ownedroot为cwd的进程；这不是整机或逃逸子进程清理保证。失败fixture和测试产物保留。

**需要的决定**：由当前CLI/recorder任务先完成并提交通知重试实现，再由本agent更新独立集成；还是明确授权本agent在独立分支实现同一合同（可能与现有WIP重复）。默认不接管另一任务的未提交实现。无论选择哪条，UI两处首次失败都仍由本agent负责后续定位，当前不能宣布集成验收完成。
