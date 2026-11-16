# 工作区 UI hill-climb

## 范围与参考（2026-11-16）

本批只调整桌面工作区的 Agent Profile 标签、时间线辅助信息与密度、文件证据条、侧栏分区与分析入口图标。正文继续使用 `--text-reading`（15px）。不改 token 定义、primitive、交互模型、权限或证据语义；不隐藏 ID、计数、不可用状态或警告。

第一轮评审实际查看的输入是 `scry-unified-rendering-ue52x1` 中宽／窄、深／浅四张 timeline 截图，以及 sol 与 luna 的完整评审。本执行线程最初按任务指定另查看过 `scry-unified-rendering-ELaDgR` 的基线截图；两目录都属于未改代码的基线，但不是同一次取证，不能混用。两者均不是修改后的验收证据。

- [Linear 参考](https://linear.app/now/how-we-redesigned-the-linear-ui)：采纳主控已读取的基线对齐、少色阶明确层级、跨状态压力测试原则；本执行线程未重新联网读取原文。
- [Craft](https://craft.gustavofior.com/nested-border-radius)：文件证据条圆角从 12px 降至现有 8px 档，减少嵌套容器的视觉重量；实际内缩与卡片角形并非同心，不声称是精确同心计算。保留现有等宽数字；不批量平移图标或新增纹理。
- 个人库两次检索无匹配，且存在 stale 条目，本批不依赖它。
- 模型替代原因：Kimi／DeepSeek 受 Radius 403 条款限制，Opus 返回 429；实际证据采用 sol／luna 两份报告，不把计划模型的评审记作已执行。第一评审实际模型为 `openai-codex/gpt-6.1-sol`，第二评审为 `openai-codex/gpt-5.6-luna`。

## 第 1 轮分数

| 维度 | sol | luna | 平均 |
| --- | ---: | ---: | ---: |
| Typography | 8.6 | 9.1 | 8.85 |
| Hierarchy | 8.8 | 8.8 | 8.8 |
| Spacing | 8.4 | 8.2 | 8.3 |
| Color | 9.1 | 8.9 | 9.0 |
| Iconography | 9.0 | 9.2 | 9.1 |
| Consistency | 8.7 | 8.7 | 8.7 |
| Clarity | 8.5 | 8.8 | 8.65 |
| Overall | 8.7 | 8.7 | 8.7 |

两位 `highStandard` 均为 false。未达标项是当前身份标签过早截断、元信息难读、纵向密度及浅色层级；没有截图可证明的 blocker。不编造本批修改后的分数。

## 本批决定

| 采纳／取舍 | 实现与理由 |
| --- | --- |
| 采纳 sol 的身份标签修复 | Profile `flex: 0 0 auto`；按钮宽度上限最终统一 192px（初版 168px 经真实验收证明不足，见下），删除主区 ≤720px 的 96px 覆写，composer ≤560px 也使用 192px。优先让模型控件收缩，保留既有窄栏换行，不缩字号。长名仍 ellipsis，名称本身新增完整 tooltip；按钮原动作说明移入集中 copy。 |
| 采纳 sol 的可读性方案 | who、runid、mini、footer 使用 `--text-sm`（12px），运行标识及微统计使用 `--dim2`；footer 标签 10→11px，使用 `--dim`；who 行高 1.4。拒绝 luna 的元信息统一 11px，以及正文降为 `--text-base`（14px）：前者不如 12px 易读，后者违反 DESIGN 的阅读字号合同。 |
| 采纳 sol 的精确密度调整 | turn 底内边距 16→12px，相邻 turn 顶内边距 24→16px，turn-flow gap 12→8px。保持助手卡片 16px 内边距。不同层级按实际容器调整，不机械套用 luna 的统一 24px／16px 间距，也不把视口剩余空白当作应删除的内容。 |
| 文件证据容器减重 | 仅 files-summary：上边距 16→8px，圆角 `--r-md`→`--r-sm`，summary 最小高度 44→36px、横内边距 16→12px。保留 surface-subtle，无新增边框；Hook summary 与警告不变。 |
| 侧栏与图标 | sb-section 上边距 24→12px，左右与下边距保持 8px；项目／会话行高 32／36px 不变。“分析”用已有 overview，“LLM 性能”保留 chart。 |
| 浅色层级有界增强 | 助手卡片仅浅色从 surface-faint 改为 surface-muted，hover／focus-within 用 surface-hover；文件条保留原底色。拒绝对每层增加 panel2＋border，避免与容器减重冲突。 |
| 不做无关图标规格清洗 | 核对现有 panel-pill 的 32px 框、16px 图标及 1.6 stroke；未改 primitive、小尺寸工具按钮或独立发送按钮。不采纳全局统一到同一尺寸或发送按钮 40px 的建议。 |

## 回归与证据边界

- 现有 `scripts/unified-conversation-smoke.mjs` 的 preview／timeline 截图循环内增加 computed-style／布局断言，沿用宽／860px 窄、深／浅组合；检查当前 Profile 可见、完整名称 tooltip、ellipsis 保护、控件不越界或重叠、阅读字号 15px、辅助字号／颜色与间距、证据条规格、侧栏行高。每张图旁写出 `*-layout.json`，便于独立复核。不删除或放宽旧断言，不新增 harness。
- `Pickers.test.tsx` 增加长名称 text／title 断言；临时恢复旧 CliPicker 后仅该新增用例失败，恢复实现后 7 项通过。负对照日志：`/tmp/scry-ui-improve1-negative.log`。
- 短检查已通过：design:audit 无发现；设计系统／圆角／动效／primitive／Pickers／conversation-visual-style 共 10 文件 50 项；typecheck:web；smoke 脚本语法检查；git diff --check。
- ui-contract-check 三节已核对：6 条新选择器均有意（窄栏模型 flex 优先级、浅色卡片状态，以及覆盖既有高优先级 footer 标签／数值字号）；0 个退役 smoke 类；既有写死值不因本批改变，新增断言使用批准后的精确值。日志：`/tmp/scry-ui-improve1-contract-check.log`。
- 初版 168px 在主控真实 smoke 中失败：`preview/dark/1280px` 的 `claude Smoke Fixture` 标签可用宽度 106px、内容 121px。日志 `/tmp/scry-ui-round1-app.log` 保留原失败；这是实际宽度预算错误，不是 flake。glyph／chevron／padding／gap 占用约 62px，总宽至少需要 183px；改用现有 4px 网格的 192px 上限，保留模型优先收缩、560px 响应式、长名称 ellipsis 与 tooltip，不删除或放宽断言。
- 修正后本线程实际执行 `npm run build && node scripts/electron-security-smoke.mjs --dev-unified-conversation-only` 通过，完整 smoke 返回 3 turns、22 次测试 Provider 调用、2 次重启；未调用真实账号。日志 `/tmp/scry-ui-improve1-app-fixed.log`。
- 截图及 8 份布局 JSON：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-nObxcF`。preview／timeline × 1280／860px × 深／浅的 Profile 均为 width=contentWidth=121px；正文均 15px，辅助字体与间距断言通过，控件无越界或重叠。实际查看了四张新 timeline 图，确认标签完整，证据与警告可见，不自行给分。
- 长 Markdown、工具展开、运行中、极长 Profile 的实际截断布局及 Linux 仍未专项验证；第一轮实现交接时第二轮独立评审尚未执行；实际第 2 轮结果见下。

第一轮实现交接建议是让主控基于上述独立临时 userData／workspace 证据复评；后续实际结果与本轮取舍如下。优化子任务当时未安装、提交或推送，由主控统一交付。


## 第 2 轮评审与局部修正（2026-11-16）

完整读取 `/tmp/scry-ui-round2-sol.md` 与 `/tmp/scry-ui-round2-luna.md`。本轮评审输入是 `scry-unified-rendering-nObxcF`，不同于第 1 轮的 `ue52x1` 基线，也不同于下面用于第 3 轮的修正后截图。

| 维度 | sol | luna | 平均 |
| --- | ---: | ---: | ---: |
| Typography | 8.3 | 8.5 | 8.4 |
| Hierarchy | 8.2 | 8.2 | 8.2 |
| Spacing | 8.7 | 7.8 | 8.25 |
| Color | 8.6 | 8.2 | 8.4 |
| Iconography | 8.8 | 8.0 | 8.4 |
| Consistency | 8.5 | 8.3 | 8.4 |
| Clarity | 8.7 | 8.3 | 8.5 |
| Overall | 8.5 | 8.2 | 8.35 |

sol 的 `highStandard: false`；luna 的 `highStandard: true` 只表达其“可以交付”的意见，与用户门槛不一致，不能代替门槛。本轮仍判未通过。平均 Overall 从第 1 轮 8.7 到第 2 轮 8.35，原值保留，不声称单调提升。两位均未发现 blocker；本轮可执行未达标项是统计脚注的字重和字距过强。第 3 轮不预填分数，也不由实现线程打分。

### 建议取舍与真实样式链

- **采纳 sol 的 footer 减重**：仅 `.chat-body .turn-footer .stat .lbl` 使用 `--weight-regular`（600→400）、`letter-spacing: 0`（原 0.08em）；`.stat b` 使用 `--weight-medium`（600→500）。字号仍为标签 11px、值 12px，颜色／字段／数值／单位均不变。保留既有大写转换，不改文案；DESIGN 并未要求这类紧凑指标取消大写，本次先靠字重与字距恢复阅读层级，不叠加另一个视觉决定。
- **拒绝无证据缩 composer**：它是 64px 编辑区域，不是空态占位。`codex-alignment-editorial.css` 的 textarea height/min-height 与 `chat-preview-ui-checks.mjs` 的 64px 合同一致。不能因当前无草稿就削减编辑能力；sol 也明确认为这不是浪费。当前真实 App 的 8 份布局均测得 editorHeight=64。
- **拒绝按旧 `.turn` margin 再缩轮次**：`Transcript.tsx` 实际同时渲染 `turn transcript-turn`。`styles-chat-entry.css` 的 24px、`styles-evidence-session.css` 的 32px margin-bottom，已被后加载且更具体的 `session-evidence-chat.css` 中 `.chat-body .transcript-turn { margin: 0 auto; }` 覆盖；没有额外完成态 margin 叠加。当前 8 份布局均测得 margin-bottom=0px，保留首批批准的 12px 底／16px 相邻顶内边距。
- **不重复强化浅色边框**：最终浅色卡片已使用 surface-muted，hover/focus-within 使用 surface-hover；文件证据仍有独立浅底。本轮截图没有提供足以支持再升 1–2 级或增加边框的明确失败证据，sol 认为双主题协调。沿用已批准的少嵌套容器方向，不盲目叠框或改 token。
- **不重复统一顶部／分支图标**：最终 `codex-alignment-shell.css` 中 `.tb-action` 已高 32px、`.panel-pill` 宽 32px、图标 16px／stroke 1.6，hover 与全局 focus-visible 已存在；时间线分支是 `Button size="sm"` 的 28px 行内文字动作，不是同类图标按钮。不能为约 1.5px 的建议把两种语义混成同一规格，更不改 primitive。

### 验证与证据归属

- 本线程先在修改前构建上执行新增 footer 权重断言：真实 App 在 preview/dark/1280px 以 **600≠500** 失败，证明回归能识别旧实现。日志 `/tmp/scry-ui-round2-footer-negative.log`；此为预期负对照，不是被忽略的未知失败。
- 修改后本线程执行 `npm run build && node scripts/electron-security-smoke.mjs --dev-unified-conversation-only` **通过**。构建日志 `/tmp/scry-ui-round2-build.log`，完整 App smoke 日志 `/tmp/scry-ui-round2-app.log`；3 turns、22 次测试 Provider 调用、2 次重启。没有调用真实账号，没有削弱旧断言。
- 第 3 轮真实截图与 8 份布局 JSON：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-XpOtf8/`。preview／timeline × 1280／860px × 深／浅均通过：footer 标签 400、值 500、字距 computed 为 normal（CSS 0）；既有字号／颜色、Profile 121px 完整可见、15px 阅读字号及所有间距断言仍通过。新增断言还明确保留 uppercase、64px 编辑区与 0px turn margin。本线程实际查看了四张新 timeline 图，只核对可见性与局部变化，不给分。
- 本线程本轮短检查：design audit 无发现（`/tmp/scry-ui-round2-audit.log`）；设计系统／圆角／动效／primitive／Pickers／conversation-visual-style 共 10 文件 50 项通过（`/tmp/scry-ui-round2-guards.log`）；脚本语法与 diff 检查通过。ui-contract 三节复核通过，仍为前批 6 条有意选择器、0 个退役 smoke 类，本轮未新增选择器（`/tmp/scry-ui-round2-contract.log`）。
- **主控执行、不是本线程执行**：读取 `/tmp/scry-ui-renderer-tests.log`，确认前批 `npx vitest run src/renderer` 为 **136 文件／1335 项通过**。读取 `/tmp/scry-ui-round1-chat-preview.log` 与 `/tmp/scry-ui-round1-sidebar.log`，确认主控 `chat-preview-ui-smoke` 的 wide/narrow 以及 `--sidebar-activity-only` 通过；这些是 footer 修改前的相邻链路证据，不冒充本轮全 renderer 重跑。
- Linux 未验证。长 Markdown、工具展开、运行中与极长 Profile 未新增专项验证。第三轮独立评审由主控基于 XpOtf8 截图执行；以下记录第三轮最终结论。

## 第 3 轮评审与完成结论（2026-11-16）

本轮实际评审输入仅为四张桌面工作区 timeline 截图，目录为 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-XpOtf8`；不扩大为全 App 评审，也没有第四轮。

| 维度 | sol | luna | 平均 |
| --- | ---: | ---: | ---: |
| Typography | 9.6 | 9.6 | 9.6 |
| Hierarchy | 9.5 | 9.6 | 9.55 |
| Spacing | 9.5 | 9.5 | 9.5 |
| Color | 9.5 | 9.5 | 9.5 |
| Iconography | 9.6 | 9.5 | 9.55 |
| Consistency | 9.5 | 9.6 | 9.55 |
| Clarity | 9.5 | 9.5 | 9.5 |
| Overall | 9.5 | 9.5 | 9.5 |

sol 的 `highStandard: true`；luna 的深色与浅色 `highStandard` 均为 `true`。所有维度平均分均不低于 9.5，两位评审均通过，达到用户停止条件。三轮 Overall 汇总为 **8.7 → 8.35 → 9.5**，保留第 2 轮回落事实，不声称单调提升。

第三轮相对第二轮只记录已完成的 footer 收尾：标签字重 400、数值字重 500、标签零字距；保持 15px 阅读正文与 64px 编辑区，不再增加改动。四张截图中 profile、权限、模型、发送控件、警告、run ID、工具证据与统计均可见；未发现 blocker，也没有需要继续修改的可见问题。

### 最终验证与边界

- `/tmp/scry-ui-round3-renderer.log`：footer 修改后的最终源码通过 **136 个 renderer 文件／1335 项测试**。
- `/tmp/scry-ui-round3-typecheck.log`：node 与 web typecheck 通过。
- `/tmp/scry-ui-round3-design.log`：design audit 无发现；其中的 UI contract 检查仍确认 6 条新增选择器均有意、0 个退役 smoke 类。
- 当前构建与完整 App smoke 通过，证据为 `/tmp/scry-ui-round2-app.log`：3 turns、22 次测试 Provider 调用、2 次重启；8 组布局 JSON 位于上述 XpOtf8 目录。此前 chat-preview 与 sidebar 交互日志仍是 footer 修改前的相邻链路证据，不冒充最终源码后的重跑。
- 早先本地 ABI 提示为 Electron 42.10.1 requires ABI 146/native 137；在本 worktree 重建 `better-sqlite3` 后基线通过。这是本地构建产物问题，不记录为产品缺陷。
- Linux 未验证；未调用真实 Provider 账号；未安装 App，用户日常实例未更新。结论仅覆盖上述四张桌面工作区截图及列出的验证证据。

三轮 hill-climb 已完成。当前仅待主控按仓库流程提交、推送并创建 PR；本记录不预写这些动作已成功。

## 提交门禁职责拆分验证（2026-11-16）

仅抽取 Agent picker copy、统一对话布局检查与设计决策主题文档；不改变 UI、业务、权限、评分或既有断言。focused 10 文件／50 项、web typecheck、设计审计、脚本语法、build 与完整统一对话 App smoke 通过。日志前缀 `/tmp/scry-ui-size-`（focused、typecheck、audit、build、app）。

新截图目录 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-6mInr6/`；8 份 layout JSON 与第三轮 `XpOtf8` 同名文件逐字节一致，比较记录 `/tmp/scry-ui-size-layout-equivalence.log`。文案对象及 17 节历史决策原文迁移检查通过（`/tmp/scry-ui-size-migration.log`）；原有 smoke 主体逐字保持 HEAD，仅新增 import 与检查调用。此为渲染不变证据，沿用第三轮视觉结论，不新增设计或评分。未暂存、提交或推送；正式 staged 文件体积门禁由主控执行。Linux 仍未验证。
