---
target: Scry iOS 手机 UI
total_score: 31
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:/Users/baobingjiang/IdeaProjects/vibecoding/scry/apps/ios/ScryRemote/HomeView.swift"
target_fingerprint: "sha256:e4f2ed26f2918e7fc2c6486f7ade82209e824fdca7f51bd17a61bd6151e55fb9"
target_path: /Users/baobingjiang/IdeaProjects/vibecoding/scry/apps/ios/ScryRemote/HomeView.swift
timestamp: 2026-10-21T08-07-22Z
slug: apps-ios-scryremote-homeview-swift
---
Method: design review only (detector not applicable, native platform)

## Design Critique：Scry iOS

**范围**：`apps/ios/ScryRemote`，重点看首页、会话、配对、设置。
**证据**：当前 SwiftUI 源码 + 2026-10-13 会话 fixture。iCTRL 真机服务当前未启动，因此这不是当前构建的真机视觉验收；10 月 8 日浅色截图已落后于现在的 dark workbench，只用于确认历史问题，没有据此评价现状。

### Design Specificity Verdict

**LLM assessment**：这是为 Scry 写的界面，不是通用聊天壳。产品个性主要来自证据语义：状态不冒充、正常完成静默、问题就地出现、手机与 Mac 的回合不按来源分裂。表层视觉仍接近 Codex 类暗色工具，但这种克制符合 Operate 模式。最大的未利用机会是把“证据是否新鲜”做成更可发现、但不常驻打扰的 Scry 专属交互。

**Deterministic scan**：not applicable (native platform)。

### Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | 运行与刷新状态清楚；历史新鲜度藏在菜单 |
| 2 | Match System / Real World | 3 | 核心文案清楚；配对失败仍可能暴露技术错误 |
| 3 | User Control and Freedom | 3 | 返回、停止确认、重试和清除确认完整 |
| 4 | Consistency and Standards | 3 | Header、回合、Composer 已统一；设置页结构稍散 |
| 5 | Error Prevention | 4 | 未连接禁发、未知结果不冒充失败 |
| 6 | Recognition Rather Than Recall | 2 | 重要入口藏在图标和 `···` 中 |
| 7 | Flexibility and Efficiency | 3 | 搜索、置顶、项目内新建对重度用户有效 |
| 8 | Aesthetic and Minimalist Design | 3 | 会话页克制；首页元数据和设置说明偏密 |
| 9 | Error Recovery | 4 | 刷新、连接、历史、停止失败均保留恢复路径 |
| 10 | Help and Documentation | 3 | 配对引导完整；复杂证据状态缺少就地解释 |
| **Total** | | **31/40** | **Good** |

### Overall Impression

Scry iOS 已经不是“桌面端缩小版”。它形成了明确的暗色工作台：内容优先、状态克制、颜色只表达证据或行动。会话页尤其成熟，“运行状态只出现一次”的设计解决了此前最严重的信息噪声。

现在的主要问题不在视觉风格，而在高密度信息如何快速扫描、关键证据是否容易发现和小字号是否真的适合手机。

### What's Working

- 会话状态被收敛到 Composer 上方一条。运行中、等待决定、离线和历史问题不再到处重复。
- 正常完成保持安静。没有绿色“完成”徽章泛滥，也不会把缺失用量显示成 0。
- 消息来源视觉统一。手机续聊与 Mac 历史共用同一回合结构。
- 交互目标大多达到 44pt。Header、返回、附件、发送、项目内新建等主要按钮符合单手操作基本线。
- 危险动作诚实。停止运行、清除配对、未知发送结果都明确说明真实后果。

### Priority Issues

#### [P1] 字体体系没有真正支持手机可读性

**Why it matters**：大量关键文字使用固定 `9–13pt`。SwiftUI 的 `.system(size:)` 不会像语义 text style 一样自然响应 Dynamic Type。默认字号下看起来紧凑，但大字体用户会遇到截断、层级失真或信息过密。

**Fix**：正文和辅助信息切换到语义 text style；只有代码与数值保留受控尺寸。至少验收 320pt 宽、默认字号、XXL、深浅色和 Reduce Motion。

**Suggested command**：`/impeccable adapt`

#### [P1] 配对错误仍会把内部错误直接交给用户

**Why it matters**：`AppModel` 仍用 `配对码无法识别：\(error)`、`配对失败：\(error)`。历史真机截图里已经出现过 `badPrefix`。首次连接失败时，用户知道失败，却不知道下一步怎么做。

**Fix**：把已知错误映射成“二维码已过期 / 不是 Scry 配对码 / Mac 已取消 / 网络不可达”等可行动文案；技术详情放进可展开区域。

**Suggested command**：`/impeccable clarify`

#### [P1] 首页的项目层级与会话元数据重复

**Why it matters**：会话已经嵌套在项目标题下，但每一行仍重复项目名，并在多主机场景继续叠加 host、project、provider。屏幕越小、项目越多，第二行越像一串难扫的路径。

**Fix**：在项目分组内移除重复项目名；仅在聚合多主机时显示 host；Provider 用短标签放到行尾。搜索结果页再恢复完整上下文。

**Suggested command**：`/impeccable distill`

#### [P2] “证据是否新鲜”藏得太深

**Why it matters**：会话历史状态、上次核对时间、存储提示放在 `···` 菜单里。Scry 的核心价值正是让用户判断证据是否完整、是否仍可信。

**Fix**：正常且新鲜时保持安静；只有“缓存、部分、失败、旧数据”时，在 Header 副标题或状态条显示一个可点开的短标签。不要长期增加常驻徽章。

**Suggested command**：`/impeccable clarify`

#### [P2] 设置页的信息架构弱于会话页

**Why it matters**：“连接”“安全”后直接跟一段缓存政策、清除缓存按钮、结果消息和清除配对按钮。它们语义不同，却没有形成“本地数据”分组；说明文字使用 caption，危险操作反而成为最醒目的整行。

**Fix**：拆成“连接 / 本地数据 / 安全”三组。缓存容量和备份规则做一行摘要，详情按需展开；清除缓存与清除配对分别贴近各自说明。

**Suggested command**：`/impeccable layout`

#### [P2] 长任务标题在会话头部过早截断

**Why it matters**：当前标题只能显示一行，同时右侧占用“文件”和 `···` 两个 44pt 控件。现有 fixture 已显示标题被截成“重构远程会话列表并统一信…”。多个相似会话难以区分。

**Fix**：Header 显示稳定的会话标题，允许两行或提供点按查看完整标题；把“文件与 Diff”并入标题菜单或 overflow，减少横向争抢。

**Suggested command**：`/impeccable layout`

### Persona Red Flags

**Alex（Power User）**：搜索、置顶、项目内新建很高效；但 Host / Project / Provider 重复占用扫描空间，长标题又难区分相似会话。

**Casey（Distracted Mobile User）**：能一眼看到“运行中 / 等待决定 / 失败”；但历史是否来自缓存、是否已核对，需要主动打开 `···` 才知道。

**Sam（Accessibility-Dependent User）**：主要按钮尺寸合格；固定小字号和一行截断会让辅助信息在 Dynamic Type 下失去可用性。

### Minor Observations

- 视觉个性主要来自“证据诚实”和运行状态结构，而不是表层造型。这是合适的方向；不要为了更“品牌化”加入装饰。
- PairView 的三步流程清楚，但 11pt 的安全说明不应承担关键 trust 文案。
- Composer 的模型、推理强度、权限和附件集中在底部是合理的，但应继续保持“默认状态不展开”。

### Questions to Consider

- 哪些证据状态值得越过 `···`，直接出现在会话页？
- 首页是否真的需要在分组内重复项目名，还是只有搜索结果需要完整上下文？
- 如果用户开启 XXL 字体，哪些信息可以换行，哪些应该移入详情？
- 会话 Header 应该表达“这是什么会话”，还是“这一轮最早说了什么”？
