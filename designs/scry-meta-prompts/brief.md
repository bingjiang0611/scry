# Scry · Meta Prompts 设计稿

## D-SCRY-META-PROMPTS

- Scope / status：project `/Users/baobingjiang/IdeaProjects/vibecoding/scry`；用户已确认 A 的提示词库方向，并要求去掉收藏、入口移到 MCP 下方。当前实现已验证，运行版本仍待用户验收。
- 用户需求：在分析 / LLM 性能 / 技能 / MCP 所在侧栏增加常用提示词管理入口；这些提示词暂不需要做成 Skill；方便复制和使用；先出设计稿。
- 初轮产物：`index.html` + `prototype.css` + `prototype.js`，独立 HTML 探索稿；保留作为历史，不是当前产品实现。
- 当前产物：`src/renderer/components/MetaPromptsView.tsx`、`meta-prompts.css`、`src/renderer/meta-prompts.ts`；接入 App 和 Sidebar；新增 typed 文本复制 IPC，无新增依赖。

## 2026-10-14 · 反馈与落地

- 用户原话：「去掉收藏功能 入口把meta prompts放到mcp下面 其他没问题下 实现吧」。认可初轮提交 `7976756` 的 A 结构，覆盖旧 H1 / H4 / A2；没有批准 B 的产品实现，也没有批准新的全局审美规则。
- 当前合同：个人全局纯文本库；MCP 下方独立入口；无收藏；新增、编辑、删除、标题 / 正文搜索、逐条复制、放入当前会话；保留原草稿和附件，不自动发送、不执行工具。附件保留来自已有 setInput 调用链的代码检查，未单独做含附件的插入端到端测试。
- 本机保存：复用现有 composer drafts 的 localStorage 模式，独立键 `scry.meta-prompts.v1`。仅首次缺键显示空库；格式损坏或读取受限时显示错误并禁止写入；保存失败保留编辑内容和原库。全 App 冷重启已验证持久化。不增加项目文件、导入导出或云同步。
- 复制：Scry 原有权限策略拒绝网页剪贴板写入，因此走 typed `window.scry.copyText` → `app:copyText` → 生产 sender/frame/origin wrapper → `writeClipboardText`。只允许非空文本，每次最多 1,000,000 个 UTF-16 字符，不截断、不读取剪贴板、不放开 renderer 权限；超限明确报错，可手动复制。超过该范围的真实使用需求才评估限额，不预留配置。
- 复用：保留前述 Raycast 原始调研证据；复用项目 Icon / ModalFrame、当前主题 tokens、会话草稿 setter 和现有 Electron 隔离 fixture / 安全 smoke runner。新增 copy 线性图标；未构建第二套通用组件或信任接口。
- 视觉：已检查生产组件深 / 浅色的 1200 × 818 CSS px 隔离渲染；正文滚动而动作留在底部，无收藏，入口位于 MCP 下方。成功消息 2.4 秒后消失，错误信息不自动隐藏。截图保留在 `/tmp/scry-meta-prompts-implemented-{dark,light}.png`，全部是人工示例压力内容。当前是在已确认方向内落地，不重新发起重设计评审。

### 当前验证（macOS arm64，Node 24.18.0，Electron 42.10.1，App 0.2.181）

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | main / preload / renderer 类型 |
| `npm run test:unit -- src/renderer/meta-prompts.test.ts src/renderer/components/MetaPromptsView.test.tsx src/renderer/components/render.test.tsx src/renderer/composer-drafts.test.ts src/renderer/sidebar-hit-area.test.ts src/main/clipboard-text.test.ts src/main/ipc-trust.test.ts src/main/renderer-security.test.ts src/preload/index.test.ts` | 9 文件、298 测试通过 | 新库、纯文本与损坏数据、草稿、侧栏、剪贴板 schema、IPC 拒绝与 preload 接线 |
| `node scripts/session-capability-ui-smoke.mjs --meta-prompts-only` | 通过 | 原生坐标点击；新增 / 编辑 / 放弃 / 删除；搜索；localStorage reload；实际系统剪贴板内容逐字一致；保留草稿、不发送；损坏库禁写；使用真实生产 preload 和 trusted IPC wrapper |
| `node scripts/electron-security-smoke.mjs --dev-meta-prompts-only` | 通过 | 当前完整 App 的 main / preload / renderer；原生鼠标与输入；实际侧栏和输入框接线；复制回执、原草稿保留、输入框聚焦、无 Provider 启动；退出并重启后仍读到原提示词 |
| `npm run build` | 通过 | 当前开发构建 |
| `npm run pack:artifact` | 通过 | 开发签名目录包、sandbox CJS preload、资源检查、真实打包安全 smoke、文件与远程 host smoke；未安装、未公证 |
| `npm run test:renderer:ui` | 通过 | 现有 macOS UI gate，包含新 Meta Prompts fixture；Credits / 会话 / 预览 / 后台 / Steer / remote 相邻回归 |
| 破坏性对照（临时只返回 body，丢弃原草稿） | 预期失败；恢复后 11 测试通过 | 原草稿断言能识别真实数据丢失，不是只看插入成功 |

### 首轮失败与边界

- 类型检查首轮发现测试的未使用 React import，删除该 import 后通过；未改变业务逻辑或断言。
- 隐藏 fixture 的模拟 Cmd+A 没有选中全文，导致搜索内容拼接；改用仓库已采用的 Electron `webContents.selectAll()`，保持真实输入与断言，不加重试或扩大超时。
- 首次复制实测失败：网页 API 要求焦点且被生产权限策略禁止。用上述最小 typed IPC 修复实际接线，未放宽策略；最终 native clipboard 比对通过。
- 全 App 首次观察将 DOM 对象按值返回，CDP 序列化失败；改为只返回 Boolean。插入聚焦原本同步断言早于异步 focus timer；改为等待同一聚焦条件（原 5 秒上限不变），未删减要求。
- SSR 测试打印已有 App useLayoutEffect 警告，测试通过；不以 SSR 代替 UI 验证。
- 未使用真实 Provider / 账号 / 费用，未进行含附件插入、多窗口同时编辑或换安装位置的数据迁移验收。用户数据被清除会删除该本机库；此实现不提供备份 / 导出。
- 本轮测试使用临时 HOME / userData；测试 App 均由现有 owned process cleanup 结束并清理临时目录。系统剪贴板测试写入了人工示例文本；原有用户提示词库没有被修改。

## 历史 Brief（初轮探索，以下旧约束不覆盖当前合同）

- 目标：创建、查找、预览和复制个人常用指令；可选放入当前会话输入框，由用户自行补充和发送。
- 感受：一个安静的文本工具，不是 Prompt 商店、自动化平台或另一个 Skill 系统。
- H1：保留原导航顺序，在技能与 MCP 之间插入 Meta Prompts。
- H2：沿用当前 Scry 中性深灰表面、系统字体、线性图标和按钮层级。
- H3：提示词是纯文本，不执行工具、不自动发送、不增加新的授权语义。
- H4：当前仅设计；所有示例数据只在内存修改，刷新恢复初始样本。
- A1：默认个人全局库，而非每个项目各建一份；尚未由用户确认，生产实现前需明确。
- A2：收藏足以处理当前少量高频提示词；不预留标签管理、变量替换、导入导出或版本系统。
- 尺寸：面向桌面；实际 Relay 渲染检查视口 1301 × 1232 CSS px，未验证其他窗口尺寸。

## 结构方向

| 方向 | 路径 | 优点 | 代价 |
| --- | --- | --- | --- |
| A · 提示词库（推荐） | 侧栏 → 列表 / 搜索 / 收藏 → 正文 → 复制或放入会话 | 管理与编辑空间充足；列表行也可直接复制 | 暂时离开会话视图 |
| B · 快捷弹窗 | 侧栏 → 保留当前会话的搜索弹窗 → 复制或放入会话 | 少打断当前任务 | 长正文需要滚动；管理需要转入 A |

两者共用相同六条示例和状态。可选择一个方向，也可后续明确采用 A 管理 + B 取用；当前不默认实现双入口。

## 调研与复用

| 来源 / 区域 | 观察 | 采用 / 拒绝 | 动作与检查 |
| --- | --- | --- | --- |
| 用户侧栏截图 + `src/renderer/components/Sidebar.tsx:177–218` | 当前四个入口同组，技能与 MCP 打开弹层 | 保留导航，不重排原功能 | 新入口插在技能与 MCP 之间，截图核对 |
| `src/renderer/styles.css:1–145`、`src/renderer/codex-alignment.css:1–119` | 有实际生效的中性深灰 token 覆盖层 | 采用当前覆盖层，不用较早蓝黑色盘 | 原型 token 快照；检查侧栏、正文、选中态 |
| https://ray.so/prompts/code （实际浏览、截图，参考视口 1497 × 708） | 分类导航 + 多列全文卡片；文本内容是主角 | 借鉴正文可见与直接操作；拒绝多列卡片和完整分类体系 | 左列表 / 右正文，减少嵌套表面；不是商店 |
| https://manual.raycast.com/snippets （打开并抽查） | 以可复用文本为管理对象 | 信息结构线索；不声称阅读全文 | 不引入工具执行、Skill 能力或模板引擎 |
| Designeer https://designeer.xyz/ | 已 fetch 入口；未取得与本任务匹配的原始参考条目 | 不当作完成的视觉参考 | 转向 Raycast 原始页面，明确保留发现缺口 |
| 个人库：Scry / 搜索 / list / prompt / 列表检索 | 有 Scry 历史记录；无适合此任务的已验证提示词组件或页面 | 不借用无关 Usage 组件；失效来源保留 stale | 复用项目 tokens 和导航结构，不声称组件已抽取 |

本次不创建个人通用组件库。历史案例不代表本稿已获用户批准。

## 细节与减法

- [Craft 光学对齐](https://craft.gustavofior.com/optical-alignment)：导航和动作使用 18 / 16 px 线性图标；按实际截图检查图形与文本重心，未施加全局偏移。
- [Craft HTML 根背景](https://craft.gustavofior.com/html-background)：根画布随深浅主题同步；不宣称验证了 Safari 回弹。
- [Craft Hover 克制](https://craft.gustavofior.com/hover-restraint)：列表、按钮与切换即时反馈，不使用 transition: all；键盘焦点可见。
- 减法：正文区域去掉与列表底部重复的“个人提示词”说明，以及重复的正文标签。保留编辑字段标签、未保存确认和真实复制失败信息。
- 当前图形和密度为项目匹配判断，不宣称它们全是 Craft 已发布规范。

## 实际验证

- `node --check designs/scry-meta-prompts/prototype.js`：通过。
- `node --test designs/scry-meta-prompts/prototype.test.cjs`：4 项通过，验证插入时保留已有草稿与换行、空草稿不加额外分隔、纯文本转义、标题及正文搜索。只测试原型逻辑，不证明真实 App。
- 首轮临时命令的引号转义有误，最后一项断言在执行前出现 SyntaxError；修正为上述可重复运行的测试文件后通过，未改产品或弱化断言。
- `git diff --check`：通过；交付前再次执行。
- Relay 截图：A 深色、B 深色；标题、导航、选中项、正文和主要动作可见。最终减法版已另行打开新预览页并截图检查；视口均为 1301 × 1232。
- 搜索：输入“Recorder 不存在”显示无匹配和空预览；输入“方案”只保留对应条目。
- 复制：用户动作后出现“已复制提示词”；这是 clipboard.writeText fulfilled 后的反馈，未独立读取系统剪贴板核对内容。
- B 弹窗：保留会话背景，可预览同一条长文本并滚动；主要动作不随正文滚走。
- 放入会话：动作后关闭弹窗、显示会话和输入框，并提示“尚未发送”；没有连接 Provider。具体输入值和不覆盖原草稿的规则由上述本地逻辑测试通过；当前未做真实 App 端到端验收。
- 新建：保存带 `<script>` 的标题和正文后，列表数量由 6 变为 7，正文按字面显示；不是执行内容。
- 独立视觉评审：已尝试 reviewer；该子 Agent 无 browser_inspect，未取得截图，未进行独立评审。主会话做渲染自查，不伪称独立通过。
- 尚未交互重放：删除、修改后放弃确认、收藏筛选、浅色主题、小窗口、完整键盘路径、复制失败、全部删除后的空库。
- 不运行 App 构建或真实 Provider：原型与生产完全隔离，当前任务不涉及这些改动。

## 下一次复用与验收

- 触发：给 Scry 增加类似的个人文本管理工具。
- 动作：先看生效的 codex-alignment tokens；沿用原侧栏；把管理与快速取用作为结构选择，不先增加自动执行或复杂分类。
- 检查：真实文本长度、主要动作持续可见、复制结果真实、插入输入框不自动发送且不丢原草稿。
- 用户验收：用户已按本轮反馈确认 A 的结构并授权落地；当前运行版本待实际使用反馈。旧探索稿仍保留历史，不能以其收藏或入口顺序覆盖当前合同。
- 共享检索：本文件已注册为 D-SCRY-META-PROMPTS，build 成功，search 命中此 ID / 路径；check 因 5 个既有失效来源失败（P-PI-MODEL-SELECTOR、D-20260912-scry-ios-remote、D-20261008-scry-ios-continuity、P-SCRY-SESSION-HISTORY、D-20261010-scry-llm-sidebar）。本次记录可检索，不表示全库健康。不复制成另一份验收记录，不升级任何全局审美偏好。
