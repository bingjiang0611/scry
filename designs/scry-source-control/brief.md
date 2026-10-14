# Scry 源代码管理 · 设计稿

## D-20261014-scry-source-control

- Scope：`project:/Users/baobingjiang/IdeaProjects/vibecoding/scry`。
- Status：用户已要求调研、技术方案和设计稿；**方案与成品待用户确认**。未接生产，未获得视觉认可。
- 原始要求（2026-10-14）：按功能表 2、4、6、7 顺序开展，“先认真调研 t3 code 是怎么做的，然后出技术方案，如果涉及到页面交互的，要出设计稿……先看2”。本次 #2 是 Git/PR 闭环。
- [技术方案](../../docs/research/source-control-technical-plan.md) · [源码调研](../../docs/research/t3-source-control-implementation.md) · [交互稿](index.html)。

## 目标与感受

任务：用户在 Agent 完成后审查真实改动，提交准确范围，推进 PR，不丢失当前任务上下文。

感受：可检查、克制、不抢聊天主任务。源代码管理是工作台，不是第二个聊天助手；用明确分区和少量主动作表达下一步，不用“全部成功”的绿灯覆盖未知状态。

### 硬约束与假设

- H1：不改生产代码；HTML 使用明确演示数据，不接 Git、GitHub、Provider、凭证或真实文件。
- H2：沿用现有 Scry 的 light/dark token 与右侧 surface 结构；不改变 renderer sandbox、IPC、仓库 trust、recorder core 边界。
- H3：Agent diff ≠ index ≠ 工作区 ≠ PR；不能以某轮会话拥有全部工作目录为假设。
- H4：外部写入明确确认；unknown 不自动重试；旧 HEAD 的审查/行评论不能自动移到新 HEAD。
- S1：优先本机桌面 + github.com 完整手工闭环；这是建议，范围待确认。
- A1：主使用路径是从当前任务交付，而不是一天批量审查多个仓库。因此推荐 A。
- 保留：现有会话列表、对话、composer、终端挂载、文件面板、Agent evidence 的身份语义。
- 目标视口：桌面约 1280–1512 CSS px 宽；实际渲染检查为 Chrome 1512×708。窄屏有 CSS 布局，但未据此宣称手机端设计或真机验收。

## 方向探索与收束

先比较六种入口：聊天消息内 Git 卡片、composer 旁组合按钮、右侧工作台、全屏仓库中心、独立 PR Inbox、每个文件上的提交按钮。

- 聊天卡片适合通知，不适合承载真实 index 和长 diff。
- composer 组合按钮太容易把提示词发送与 Git 外部写入混在一起。
- 每文件提交破坏“完整 staged set”的审查视角。
- PR Inbox 适合跨项目 Review，但当前没有必要先新增这套导航。
- 收束为 A/B 两个信息结构，界面内“比较布局”同框展示。

| 方向 | 信息优先级与路径 | 保留/代价 | 状态 |
| --- | --- | --- | --- |
| **A 会话旁工作台（推荐）** | 对话 → 工作区文件/index/diff → 确认提交/推送 → PR → review/merge | 复用现有右侧标签与放大；窄面板需要扩大阅读空间 | 有交互稿 |
| B 独立仓库中心 | 仓库/PR 列表 → 宽幅审查工作区 → 提交审查/合并 | 新一级入口；批量审查更好，但离开任务上下文 | 结构草图与宽幅布局预览；未做完整 Inbox |

B 不是“用户已选定的第二套产品实现”。推荐 A 也不代表已经获准集成。

## 调研与复用收据

| 来源/区域 | 观察 → 本次动作 | 检查 |
| --- | --- | --- |
| T3 官网 Git 区块，2026-10-14 Chrome 原站实看 | branch/diff/下一步放在一起 → 仓库身份位于工作区顶部，动作就地 | 不复制营销“一键全做”；官网图只是示意，不冒充产品实机 |
| T3 `GitActionsControl.logic.ts` / PR layout，固定 commit 见调研 | 根据状态给下一步；PR metadata 与内容标签分层 → 工作区/PR 两层结构与有依据的 disabled 状态 | CI pending、认证缺失、stale、unknown 不显示可合并 |
| Scry `src/renderer/styles.css` | 复用 light `#f3f5f7/#3f72b7`、dark `#07090d/#6aa8ff` 等主色 token | 根画布/对话/工作台随主题切换，无额外品牌主题 |
| Scry `RightSurfacePanel`、`right-surface.ts` | 已有标签与放大 → 新增 surface，不加第二个抽屉 | 对话与工作台可并排；放大入口保留 |
| Scry `TurnDiffReviewPanel` | 复用 diff 阅读模式，不能复用“本轮证据”的身份 | 原型明确分开“本轮 Diff”和“源代码管理” |
| 个人库 `D-20260910-qoder-background-work` | 沉默≠失败/成功 → unknown 有可见核查入口 | 核查无确证仍保持 unknown，不重复写入 |

个人库已分别检索 `Scry`、component `diff review source control`、page `workspace inspector`。后两项没有命中可直接导入的组件；Scry 有多个旧来源路径 stale。本次只复用**项目模式与 token**，原型为独立原生 HTML/CSS/JS，不能称为“已导入生产 React 组件”。未引入外部字体、图片、UI 包或新依赖。

Craft 应用：动态数字用 tabular-nums；根背景随主题；高频 hover 即时、键盘 focus-visible；嵌套表面不堆叠装饰。无渐变/图片，不强行应用 Noise 或图片边框。

## 交互范围与诚实边界

- 工作区：已暂存、未暂存、未跟踪分组；文件切换、暂存/取消暂存、提交确认、独立推送确认。
- PR：已有/无 PR、创建标题/说明/草稿模式、描述/检查、文件与行评论草稿、review verdict、合并确认。
- 新 HEAD：旧 approval SHA 不变，草稿标过期并阻止提交；原型提供明确丢弃后重写，不演示自动行号映射。
- 自己创建的 PR：保留实际输入的描述/作者，不能自批；新 PR 不生成虚假的审批。
- GitHub API 登录与 Git 传输独立：没有 API 登录仍可走演示的已配置 Git push；不宣称 SSH 登录用户等于 API 用户。
- 场景选择器：已有 PR、无 PR、CI pending、stale、未登录、push unknown、Agent running。切换场景会重置演示数据，**不是现实中的故障恢复操作**。
- 原型不持久化草稿、不连接网络、不执行真实命令；刷新会清空演示状态。
- diff 为示意片段，计数/仓库/SHA/账户/检查均为演示数据；不代表当前真实 Scry 改动。
- 生产方案中的 binary/partial diff、多 remote/SSH alias 映射、hook 授权、账户切换、fetch、恢复日志、草稿 PR 转 ready 尚未逐一绘制；技术方案覆盖合同，实施各切片时补相应交互。

## 验证与独立评审

### 已执行

| 检查 | 结果/证据 |
| --- | --- |
| `node --test designs/scry-source-control/prototype.test.mjs` | 11/11；覆盖 staged 范围、commit/push 分离、unknown、不登录的 Git transport、旧 head 草稿、自批限制、pending/changed-head 合并拦截 |
| `node --check designs/scry-source-control/prototype.mjs` | 通过 |
| 负向对照 | 在临时副本移除 draft head guard，对应测试按预期失败（exit 1）；不是弱化断言来迁就实现 |
| Chrome Relay 实际点击 | 暂存→提交确认→只移除已暂存文件，其余 WIP 保留；PR 文件标签→填写行评论→保存后显示本地草稿、未提交；unknown→只读核查后仍 unknown |
| Chrome 状态读取 | PR 子标签被重绘后，新按钮 `focused=true, pressed=true`；不是只确认鼠标 dispatch。旧节点的 focus expect 因节点替换 unmet，随后核验了新节点 |
| 视觉 | 1512×708 下检查浅色工作区、深色 PR 草稿、A/B 同框；第一次布局提交区超出容器，已修正 grid/flex min-height 后重看；长文件名省略并保留 title，diff 局部滚动 |
| 键盘 | Escape 关闭结构比较 dialog；文件/PR 子标签焦点恢复已落实。未做完整屏幕阅读器审计 |
| 独立 advisory review | 源码级审查发现实际 push endpoint、旧 SHA 草稿、API/Git 身份耦合、新 PR 内容/自批、焦点丢失五项；均已修正方案或原型并加对应状态回归。独立评审未看渲染，不冒充视觉验收 |

### 减法与剩余限制

删掉仓库标题旁重复的“不是归属证明”，保留文件范围与证据区别在相关区域；不新增指标卡、hero 或第二套导航。原型中的静态聊天/侧栏只提供布局上下文，不伪装成可用聊天功能。

只对上述检查过的场景作结论：未运行 T3、Scry 完整 App、真实 GitHub 写入、真实 Provider、iOS 真机或所有视口。生产功能未实现。用户视觉和流程验收待确认。

## 下次复用

触发：在 Agent 工具中加入仓库/远端写动作。

动作：先区分 session 与 repository 身份；列出本地 index、远端 head 与用户实际审查版本；未知写结果先核查，不自动重试；再决定工作台或独立中心。

检查：无关 WIP 不被提交、push 实际端点可见、old-head review 不漂移、API 账号不冒充 Git SSH 身份。

此条是 **Scry 项目方案候选**，不升级为全局审美偏好或已获批产品组件。权威文件即本文件，注册只保存指针。

已注册 `D-20261014-scry-source-control`，查库 `Scry Git PR 闭环` 可命中本文件；本机索引已生成。全库 `check` 仍失败于 5 条原有失效来源（Pi model selector、Scry 旧 iOS brief/continuity、session-history 文档、LLM sidebar brief）。本次文件可用，不删除旧引用来让全库检查变绿。

## 本地打开

在仓库根目录启动只绑定 loopback 的静态服务：

```sh
python3 -m http.server 8876 --bind 127.0.0.1 --directory .
```

打开 `http://127.0.0.1:8876/designs/scry-source-control/`。若端口已占用，不启动第二个服务；本轮已为预览启动该端口，日志 `/tmp/scry-source-control-preview.log`。
