# Scry Welcome 重设计 — 设计说明

对象：Scry zero-turn welcome（`src/renderer/components/ChatView.tsx` 的 `turns.length === 0` 分支 + `styles.css` 的 `.welcome-*`）。
原图：`reference-current-welcome.png`（本机 0.2.44 冷启动，1000×830 窗口，未绑定项目）。

## 已确认范围

- 痛点：**留白与重心** + **Provider 区形态**。
- 方向：**更强的就绪仪表盘**，但严格沿用 Scry 现有深色/浅色 token。
- 变体：**2 个**（A · 就绪台 / B · 就绪条），外加「现状」对照。
- 状态：**未绑定 + 已绑定** 两态都做。
- 顶栏与 composer 作为**不变对照组**照抄现有实现，不在本轮改动范围。

## 设计语境

- 产品源码：`src/renderer/components/ChatView.tsx`、`ViewChrome.tsx`、`Pickers.tsx`、`styles.css`。
- token 来源：`_scry-tokens.css` = `styles.css` 第 1–178 行**原样拷贝**（深色 + 浅色 + `.ico` 基类），没有新造颜色。
- 数据：4 个 Provider 的名称/路径/版本/transport 全部取自截图里的真实探测结果；原型不连 Provider。
- 产品身份：本地 AI agent 观测与治理桌面 app（不是聊天软件，不是营销页），所以「数字/状态的来源可追溯」是硬约束。

## 现状诊断（截图 + 代码对照）

| # | 现状 | 症状 | 根因（代码） |
| --- | --- | --- | --- |
| 1 | welcome 内容顶对齐 | 列表底到 composer 之间约 110px 空洞，页面重心塌到底部 | `.welcome-field { display: block }`，滚动容器里不做垂直定位 |
| 2 | Provider 行铺满 840px | 「可用」badge 被甩到极右，跟 Provider 名失联 | `.welcome-provider > span > span { justify-content: space-between }` |
| 3 | 满宽 hairline 分隔行 | 像一张没做完的表格，不像可选项 | `.welcome-provider { border-bottom }` + `border-radius: 0` |
| 4 | 事实说了三遍 | 顶栏 Provider/项目 → 列表选中项 → composer 底部 Provider/项目 | 三处独立渲染同一批事实 |
| 5 | 两个标题打架 | H1「开始一次可追溯执行。」vs composer heading「告诉 Agent 要完成什么」 | `welcome-heading h1` 与 `.welcome-composer-heading` 同屏 |
| 6 | 就绪状态点掉在文本列外 | 与 H1/正文左边线不齐 | `.welcome-ready-line` 用 flex 把 pulse 放在文本列左侧 |
| 7 | 4 条等重的绝对路径 | 首屏最大注意力给了最不需要看的信息 | `code` 与 `b` 视觉权重接近 |
| 8 | （仅本原型）welcome 列与 composer 对不齐 | 两个框各说各的宽度 | **原型自身的 bug**：我只拷了 `styles.css` 的 `.composer`（`max-width` + `margin:0 auto`，在 grid 里退成 shrink-to-fit），没拷 `session-evidence.css` 的覆盖 |

### 8 号的更正（重要）

我一度得出“真实实现里 composer 的 `max-width:960px` 从未生效、宽度是被控件行撑出来的”这个结论，**这是错的**。落地前读 `session-evidence.css` 才发现它已经把这事做对了：

```css
.chat-body, .runtime-composer { --evidence-column: 880px; --evidence-gutter: clamp(20px, 3.2cqi, 38px); }
.runtime-composer          { width: min(var(--evidence-column), 100%); max-width: none; padding: 8px var(--evidence-gutter) 10px; }
.chat-body .chat-transcript { padding: 20px var(--evidence-gutter) 34px; }
.chat-body .welcome-field   { width: min(100%, calc(var(--evidence-column) - 2 * var(--evidence-gutter))); }
```

它给 `.runtime-composer` 显式 `width`（并 `max-width: none` 掩掉 styles.css 的 960），transcript 与 composer 共用同一条正文列，**两者本来就是对齐的**。用户看到的错位来自本原型（只拷了 `styles.css`）。因此落地时**没有**改 `.composer` 的宽度，只把 `.welcome-field` 的宽度完全交给 `session-evidence.css`。教训：多 CSS 文件叠加时，只看一个文件就下“根因”结论是不算的。

## 两个方案

共同前提（两个方案都做的重心修正）：

- welcome 内容块 `min-height: 100%` + `align-content: center`，**空白被分到上下两侧**，不再在内容与 composer 之间开一个洞。
- **welcome 列与 composer 严格对齐**：两者用完全相同的宽度公式 —— `width: min(100%, 960px)` + `margin-inline: auto` + `padding-inline: clamp(12px, 3cqi, 32px)`，且 `cqi` 解析到同一个容器（`.app-shell`，对应真实实现的 `.main-area` / `container-name: main-pane`）。1000px 窗口下两个框都是 50→950；1280px 下都是 192→1088。
- H1 从 `clamp(28px, 3.7cqi, 38px)` 收到 `clamp(24px, 2.9cqi, 30px)`，`letter-spacing` 从 `-0.045em` 放宽到 `-0.012em`（原值对中文过紧）。
- kicker 从 `NEW SESSION · LOCAL EVIDENCE` 改为「新会话 · 本机证据」——中文界面里不留一行英文大写；mono + letter-spacing 的质感保留。
- 内容列宽度改由 composer 决定（1000px 窗口 = 900px），正文 `p` 仍限 `max-width: 560px`，行长不跟着变宽。

### A · 就绪台

- Provider 从满宽表格行改成 **2×2 卡片矩阵**（`--r-md` 圆角 + `--border3` 描边 + `--surface-faint` 底）。
- 「可用」微章**紧贴 Provider 名**；可用是常态 → 纯 `--ok` 小字，不可用是例外 → 才上 `--bad-soft` 色块。四个绿胶囊平均叫嗓等于没有重点。
- 路径缩写成 `~/.local/bin/claude`，全路径进 `title`；版本 · transport 单独一行。
- 选中态：`--selected-line` 描边 + `--selected-soft` 底 + 右上一个小勾（替代现状的左侧 2px inset 条）。
- 就绪表头：`4/4 个 Provider 可用` 右侧紧跟 4 段分段计量（不重复数字、不钉到右边缘）；detail 一行 mono 说明「账号与用量在运行后采集」。
- 表头右端是「↻ 重新扫描」按钮，右边线与卡片、与下方 composer 对齐。放在右端是因为它是**动作**（等价于 B 的就绪条右端、以及 CliPicker 里的 `Rescan PATH`）；被批评的是把「可用」这种**状态微章**甩到右边缘。
  - 扫描中：按钮转为「探测中…」+ disabled + 图标旋转（`prefers-reduced-motion` 下不转），detail 换成实现里 `agentScanning` 分支的真实文案「已发现本机可执行文件；正在补齐版本信息」，**不伪造「重新发现 4 个」这种假结果**。
- 脚注保留来源标注：`路径与版本＝本机 PATH 探测结果；未探测到的字段保持「未知」`。

### B · 就绪条

- Provider 折叠成**一条横向就绪仪表**：左端 `4/4 PROVIDER` 计数块，中间 4 个等宽 chip（色点 + 名 + 版本），右端「重新扫描 PATH」（条内空间紧，只留图标，可访问名称靠 `aria-label`）。
- 选中 chip 用顶边 2px `--selected` + `--selected-soft` 底；其下一行 mono 事实行把「名称 | transport | 完整路径」一次讲完。
- 纵向占用比 A 少一半，纵向空间还给任务起点；detail 落到带 info 图标的来源脚注。

### 已绑定态（两方案共用）

- 项目上下文条：文件夹图标 + 项目名 + 完整路径（mono，溢出省略），**并且它本身就是项目切换入口**（点开下拉）。
- 顶栏按现有实现自然变化：出现「对话」tab 与「文件」「纵览」按钮，`不绑定项目` pill 消失。
- 副文案去掉「已绑定 vibecoding；」——项目名由上下文条讲（还带完整路径），**这是相对现有实现的一处文案改动**。

### 切项目：只换绑定，不跳对话（行为改动）

**现有实现的问题在 `App.tsx` 的 `pickRecent(dir)`**：它先查 `projects.find(p => p.cwd === dir)?.sessions[0]`，一旦该目录有历史会话就直接 `pickSession(firstSession)` —— 也就是把人扭进该项目下最近的一个旧对话；只有目录“一次也没用过”时才仅绑定并停在新会话。结果：选一个用过的项目，根本没机会看到它的具体路径。

本方案的行为：

- 在 welcome 的上下文条里选项目 = **只重新绑定**；不换视图、不动 `activeSessionId`、不打开任何历史会话、不清空输入草稿。
- 下拉里每一项都同时展示**项目名 + 完整路径**（同名子目录很常见，光有名字区分不了），当前项带绿色「当前」勾；末尾保留「选择其他文件夹…」与「不绑定项目」，与 composer 里 `WorkdirPicker` 的菜单项保持一致。
- 切完多一行绿色 mono 确认：`已绑定到 Nib；未打开任何历史会话。` —— 静默重绑很容易被当成“没生效”，而这句话在零轮次空态里一直成立，所以**不做定时消失的 toast**。
- 需要调整的实现点：`pickRecent()` 去掉 `firstSession` 分支，统一走“仅 `setCwd` + `selectSessionId(null)` + 停在 chat 空态”（即它现在的 else 分支）。
- 本轮**没动**侧栏：侧栏项目行现在只是 `toggle(p.cwd)` 展开/折叠，点具体会话才进对话，那是对的；“点侧栏项目行要不要也只换绑定”待确认。

## 已落地（A 方案，Scry 0.2.47）

A 方案已写进真实代码并打包安装：

- `ChatView.tsx`：zero-turn 分支换成就绪台（kicker 中文 / 分段计量 / 重新扫描 / 2×2 卡片），删掉 composer 的 `welcome-composer-heading`。
- `Pickers.tsx`：新增 `WelcomeProjectContext`（上下文条 + 工作目录下拉，每项带完整路径）。
- `styles.css`：`.welcome-*` 改成卡片矩阵 / 计量 / 扫描按钮 / 上下文菜单；`welcome-field` 垂直居中；新增 `@container main-pane (max-width: 640px)` 收拢。
- `App.tsx`：`pickRecent()` 去掉 `firstSession` 分支——选目录只重新绑定，不再跳进旧对话。

与原型的差异（有意为之）：

- **路径不做 `~` 缩写**。原型里的 `~/.local/bin/claude` 需要知道 HOME，renderer 拿不到；改写路径也违反“不编事实”。实现保留完整路径 + 尾部省略号 + `title` 全值。
- **扫描中的按钮文案是「扫描中…」而不是「探测中…」**。现有测试有一条反假状态断言：已知 Provider 时不得把状态降成“探测中”；换个词保住这道守卫，也更贴近“重新扫描 PATH”的真实动作。
- **没有「已绑定到 X；未打开任何历史会话」那行绿字**。原型里它的作用是证明“真的没跳转”；落地后这是默认行为，常驻一行解释反而是噪音。如果实际用起来觉得“点了没反应”，再加回来。
- **去掉了来源脚注「路径与版本＝本机 PATH 探测结果；未探测到的字段保持『未知』」**（0.2.47，用户要求）。剩下的可追溯渠道：就绪行的 detail「本机可执行文件已确认；账号与用量状态在运行后采集」、卡片上的 `title` 完整路径、缺字段时的「版本未知」。如果以后要加“估算/推断”类字段，得重新给它一个来源标注位置。

## 未做（需要时再谈）

- 痛点 4（顶栏 / 列表 / composer 三处重复 Provider 与项目）本轮**没动**：去重要同时改 `ViewChrome.tsx` 与 composer，超出「只重设计 welcome」的范围。建议方向：顶栏保留权威态，welcome 内的 Provider 区在选中后不再重复版本号。
- 痛点 5（H1 与 composer heading 打架）在 A/B 里通过**隐藏 composer heading** 规避（只有「现状」对照组显示它）；如果要保留该 heading，需要重新分配两者的字重。

## 原型交互

- 顶部控制条：方案（现状 / A / B）、工作目录（未绑定 / 已绑定当前项目）、窗口宽度（1000 / 1280）、主题（深色 / 浅色）。
- 状态可深链：`?v=current|a|b&bound=1&theme=light&w=1280&menu=1`（`menu=1` 直接展开工作目录菜单，方便评审与截图）。
- 项目切换：上下文条 → 下拉 → 选 vibecoding / Nib / scry / etch（本机真实存在的目录）；上下文条、composer 的目录按钮同步变，页面停在 welcome。
- Provider 卡片 / chip 可点，选中态会同步顶栏 pill、composer 的 Provider 按钮与 textarea placeholder。
- 「重新扫描」可点：进入 1.2s 的探测中状态再复原，期间只改文案与按钮态，不改数字。
- composer 可输入，Enter 发送后只给「原型不会调用 Provider」的提示，不伪造任何运行结果。

## 验证

- HTTP 预览：`python3 -m http.server 4311 --directory designs` → `http://localhost:4311/scry-welcome-dashboard/Scry%20Welcome%20Redesign.html`。
- 截图（2× DPR）1000px / 1280px 两档窗口：`shot-a-unbound-dark.png`、`shot-b-unbound-dark.png`、`shot-current-unbound-dark.png`、`shot-a-bound-dark.png`、`shot-b-bound-dark.png`、`shot-a-unbound-light.png`、`shot-a-1280-dark.png`、`shot-a-project-menu.png`、`shot-a-project-menu-light.png`、`shot-a-switched-nib.png`、`shot-b-switched-scry.png`。
- 窄宽度：`@container main-pane (max-width: 640px)` 下 A 收成 1 列、B 的 chip 换行、H1 降到 24px、「重新扫描」只留图标。
- 对齐核对（1000px / 1280px 两档窗口）：welcome 内容盒与 composer 外框的左右边线在截图上重合。
- 已核对：无 console 错误、无横向滚动、图标尺寸受 `.ico` 约束、浅色主题对比度可读。
- 项目切换已实测：菜单里点 Nib（A）/ scry（B）后，上下文条与 composer 目录按钮同步换成新项目 + 完整路径，标题与整个 welcome 仍在位，绿色确认行持续可见；菜单里 4 条路径未被省略号截断。
- 工具局限：后半段 headless Chrome 在沙箱里取不到 unpkg CDN（React/Babel 加载失败 → 空白图），项目切换相关的截图改用带网络的浏览器完成。
