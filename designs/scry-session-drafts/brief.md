# Scry · 会话草稿标记

## D-20261019-scry-session-drafts

- 状态：需求已确认；A/B 设计稿待用户选择。只新增独立原型，不改产品源码，不把原型当作已上线能力。
- 用户要求：「当对话框中有输入的时候 切换会话可以显示下有草稿吗 先出设计稿」。2026-10-19 当前会话，附桌面端原始截图。
- 目标仓库与实际 cwd：`/Users/baobingjiang/IdeaProjects/vibecoding/scry`。开始时已有大量远程、iOS、composer 相关 WIP；本次不修改、提交或安装这些改动。
- 产物：[交互设计稿](index.html)，预览 `http://127.0.0.1:8956/`。本机 HTTP 服务只暴露此目录。无外部依赖、网络 API、真实 Provider 或真实草稿读取。文本仅存在本页内存中，刷新重置。

### 保留与行为

保留项目分组、Provider 图标、会话标题、选中态、时间、未读点及运行状态。不加退出确认、弹窗、常驻解释或新的草稿管理入口。

拟定规则（待设计确认，不代表已接入生产）：

1. 有非空白输入即显示「草稿」，当前会话与切走后的会话一致。
2. 点回会话继续编辑，不自动发送，不因切换清空。
3. 清空输入后标记消失；生产实现只能在发送成功并且该草稿确已消费后移除，发送失败必须保留。
4. 草稿与运行中、未读、待回答是独立信息，不能相互替代。不改变会话按活动时间的原有排序。
5. 接入时同样考虑只有附件的草稿；使用已有 store 与会话身份，不新建第二套存储。原型仅演示文本，不验证附件、远程身份、持久化或真实发送。

### 两种局部方向

| 方向 | 结构 | 取舍 |
| --- | --- | --- |
| A（推荐） | `Provider · 草稿 · 标题 … 时间 · 运行状态`；草稿为低饱和暖色文字，无底框 | 时间与运行状态区保持原结构；有草稿时标题起点后移 |
| B | `Provider · 标题 … 草稿标签 · 时间 · 运行状态` | 标题起点一致；标签和时间、运行状态挤在同一区域，长标题可用空间更少 |

「草稿」是文字，不靠颜色单独表达状态；不使用红色告警或绿色成功语义。300px 侧栏，标题允许省略，标记本身不截断。原型提供相同示例内容下的 A/B 与深浅色切换。

### 调研与复用映射

| 来源 / 区域 | 实际观察 | 采用 / 不采用 → 本次检查 |
| --- | --- | --- |
| 用户提供的原始截图 / 左栏会话与 composer | 标题右侧已经有相对时间与运行图标；有输入时无草稿标记 | 保留原有信息，只在会话行增加局部标记；检查长标题及运行中叠加。截图属于本次已查看的外部原始参考，不上传其内容 |
| `src/renderer/components/Sidebar.tsx:635–680` | Provider、标题、metadata 与运行状态分区渲染 | A 把标记放在标题一侧；不把草稿塞进 runtime 生命周期 |
| `src/renderer/composer-drafts.ts:55–100` | 已有 input + attachments 草稿结构、同步 store 及订阅 | 后续复用现有状态；本次不改正在并行变化的 store |
| `src/renderer/codex-alignment.css:1–78` | 现有深浅色 token、蓝色选择态、灰阶层级 | 原型沿用现有表面和选中态，不新造主题；草稿色为本次未索引的局部设计判断，待确认 |
| 库 `D-20261018-scry-sidebar-activity` / 原 brief 开头 | 已确认的侧栏工作方向强调保留状态区与现有外层入口 | 不重做导航，不把草稿变成新的动态分类 |
| 库检索 `Scry sidebar` / `draft` / component:`sidebar` / page:`Scry` | 项目记录可用；没有匹配的可复用侧栏组件；部分历史来源 stale | 复用项目结构与 token，不导入无关个人组件。不是“已抽取生产组件” |

额外尝试读取 Slack 官方 Send and read messages 页面，但返回内容没有可用草稿说明；不把它当作成功调研证据。本任务以用户提供的原始截图作为相关外部原始来源。

Craft：应用 [Hover 克制](https://craft.gustavofior.com/hover-restraint)、[等宽数字](https://craft.gustavofior.com/tabular-numbers)、[HTML 根背景](https://craft.gustavofior.com/html-background)。改动前无草稿识别；改动后局部文本标记即时变化，时间等宽，根背景随主题切换。未引入 hover 动画、噪点或新装饰。

### 实际验证

通过 Chrome Relay 查看真实 HTML 渲染，不以源码代替截图。当前版本交互采用原型内存数据，不代表真实 App 验收。

| 检查 | 结果 / 证据 |
| --- | --- |
| A/B 局部布局 | 已查看两种布局截图；A 标记、时间、运行图标均可见，长标题省略；B 的右侧标签更拥挤 |
| 会话切走与切回 | issue → project → issue 后原输入仍在；原型截图与输入替换前的 valueLength=19 一致 |
| 空白输入 | 替换为三个空格后该行「草稿」消失，模拟发送 disabled；其他会话草稿仍在 |
| 有效输入 | 替换为「先给我一份修复方案。」后标记恢复、模拟发送可用 |
| 模拟发送 | 旧稿与最终稿均演示了输入被消费、对应行标记消失、按钮禁用；最终稿同时不显示旧示例用量 |
| 最终稿 / 主题 | 深浅色截图已查看；最终深色为 1512×708 CSS viewport。截图 `pi1_browser_artifact_423e66cd-8c94-40f6-92c8-9cecffcc5a61`，SHA-256 `87966c4febf1be85ba5bda9719380a995833b5a5e40eab4defbe9f4b22b2ad2b` |
| 静态检查 | `node --check designs/scry-session-drafts/prototype.js`、`node --check designs/scry-session-drafts/copy.js`、`git diff --check` 通过 |

减法：删除无操作的侧栏快捷键装饰；不增加草稿数量、提示气泡、额外列表或 composer 状态条。渲染自审发现文案集中化后的 Provider 标签误用了图标字体，已把 CSS 限定至图标并重新查看最终截图。行的辅助名称含「有草稿」，按钮保留键盘 focus-visible；完整键盘路径和屏幕阅读器未验收。局部新增状态，不是整体重设计，未另做独立 critic。

### 交付边界与下一步

- 待用户选择 A 或 B，再接入真实 store 与侧栏。批准本稿不代表真实 App 验收。
- 附件草稿、远程/本地会话身份隔离、发送失败保留、重启恢复、待回答与草稿共存须在接入阶段补 focused 回归并于当前版本真实 App 重放。
- 本轮仅设计，不构建、安装、重启或发送到 Provider；不把并行 WIP 打包交付。
- 无新增跨项目视觉偏好；本记录只确认 Scry 草稿可见性的需求，设计成品仍待审。
- 共享检索回执：已 register 为 `D-20261019-scry-session-drafts`，`search 'Scry 会话草稿'` 首条命中本文件。`build` exit 0（53 条）；`check` exit 1，因为原有 5 个失效来源：`P-PI-MODEL-SELECTOR`、`D-20260912-scry-ios-remote`、`D-20261008-scry-ios-continuity`、`P-SCRY-SESSION-HISTORY`、`D-20261010-scry-llm-sidebar`。本次条目可读且可检索，不宣称全库健康；日志在 `/tmp/scry-session-drafts-library-{build,check}.log`。
