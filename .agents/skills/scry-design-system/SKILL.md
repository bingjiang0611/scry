---
name: scry-design-system
description: 在 Scry 桌面 renderer 做界面样式、组件选择、布局间距或 UX 文案改动时使用：按语义目录选组件、只用 token、按规则写文案，完成前跑审计、守卫与 UI 契约检查；不用于性能、iOS 原生界面、产品方向或品牌决策。
---

# Scry 设计系统

边界场景与触发措辞见 [使用场景](references/when-to-use.md)；仅在路由不明确时读取。

[DESIGN.md](../../../DESIGN.md) 是权威规范：token、语义目录、primitive 合同、UX 文案规则和 Do/Don't。本 skill 给出执行顺序和踩过的坑，不重复规范正文；两者冲突时以 DESIGN.md 为准。带日期的决策和验证证据见 [设计决策记录](../../../docs/design/decisions.md)。

## 权限：哪些可以自己做

| 自己做 | 先问用户 |
|---|---|
| 用现有 primitive 与 token 实现界面；把手写按钮、通知、标签页迁到 primitive | 新增 primitive，或给 primitive 加 variant／size |
| 把网格外的值取整到 scale；把写死颜色改为主题变量 | 新增或修改 token 的档位与色值 |
| 按文案规则改写常驻说明、按钮与错误文案 | 改变交互模型（键盘、焦点顺序、标签页激活方式）或读屏语义 |
| 同一意图的旧实现收敛到已有目标 | 收敛清单里标“待定”的模式（toast、菜单）的方案选择 |
| 更新受影响的 smoke 断言，前提是新值是有意的改动 | 删除或放宽 smoke 断言 |

## 工作流程

1. **定意图，再选组件**。读 DESIGN.md 的“语义目录”：先说清这块界面要做什么（触发动作、提示结果、切换平级内容、过滤……），再选对应实现。外观相近不是借用另一个组件的理由。
2. **先找已有实现**。`src/renderer/components/primitives/` 里的 Button、IconButton、Notice、Tabs、Segmented、Skeleton、BusyLabel、TurningIcon、CountProgress，以及 ModalFrame、ModalCloseButton、Disclosure。DESIGN.md 的“收敛清单”列出每个意图的唯一目标；标“不并入”或“待定”的不要自行合并。
3. **样式只消费 token**。
   - 字号 `var(--text-*)`，字重 `var(--weight-*)`，间距 4 的倍数（1px 只用于 hairline，2px 只用于光学对齐），圆角 `var(--r-*)`，阴影 `var(--shadow-*)`。
   - 颜色只用主题变量。状态与证据类型的浅底色、边框用 `color-mix(in srgb, var(--ok) N%, transparent)`，不写 `rgba()`。
   - 最终色值在最后加载的 `codex-alignment-shell.css`，改颜色前先看它，不要只改 `styles-theme-shell.css` 的基础值。
   - 对话正文和输入框正文用 `--text-reading`；界面控件不用。
   - 现有档位不够时停下，按“先问用户”处理，不要写字面值绕过守卫。
4. **容器级按钮规则**。需要重置容器里的原生按钮时写 `.panel button:not(:where(.btn, .icon-button, [role='tab'], .segmented > button))`，必须用 `:where()`。只改行为的规则（`-webkit-app-region`、`pointer-events`、`user-select`）反过来**不能**排除 primitive。
5. **文案**。可见文字放在 `src/renderer/constants/*-copy.ts`，不内联。动词开头并写清对象（“删除会话”而不是“确定”）；缺失写“不可用”并给原因，不写 `0`；错误写清发生了什么、影响什么、下一步；说明性段落改为 tooltip、Notice 或 Disclosure。
6. **删样式时**：只删被后加载规则无条件覆盖的声明，或没有任何来源再渲染的类名；`:is()`／`:where()` 里只删无效成员；整条规则删除时连同它的选择器前缀一起删，删完看下一条规则的选择器是否被改写。
7. **验证**，按 [验证清单](references/verification.md) 执行。
8. **记录**：会改变可见外观或交互的批次，在 `docs/design/decisions.md` 记一条（日期、改了什么、为什么、怎么验证的）；新增或调整 token、primitive 合同时同步 DESIGN.md。

## 踩过的坑（都曾进入 CI）

| 坑 | 后果 | 防线 |
|---|---|---|
| 容器规则写 `:not(.btn, …)` | 优先级被抬高到参数里最高的一项，压过组件自身的字号与字体 | 审计只接受 `:not(:where(…))` |
| 给 macOS 标题栏 `no-drag` 规则也加了 primitive 排除 | 顶栏的 Button／IconButton 落进窗口拖拽区，点击变成拖动窗口 | 审计放行纯行为规则；`design-system.test.ts` 直接检查标题栏规则 |
| primitive 样式表里在 reduced motion 下写 `transition: none` | 违反全局约定（缩短而不是取消颜色反馈），动效 token smoke 失败 | 动效只在 `motion.css` 统一处理 |
| 删除规则时留下选择器前缀 | `.mp-detail {…}` 变成不匹配的 `.mp-row .mp-detail`，详情栏布局失效、按钮被推出视口 | `ui-contract-check.mjs` 第 1 节 |
| 清扫类名时整条删除混有有效成员的 `:where()` | 标题失去 `text-wrap: balance`，指标标签失去大写 | 第 6 步；计算样式比对要覆盖相关属性 |
| 有意改动的值被 smoke 写死（6px→8px、Tab→方向键） | smoke 失败；且串行 smoke 中前一个失败会遮住后面的 | `ui-contract-check.mjs` 第 3 节；一次改完所有受影响断言 |

## 交给用户

- 新 token、新 primitive 或 variant、交互模型变化、待定模式的方案：说明选项、影响范围和推荐，等用户决定。
- Electron 内的 UI smoke 需要非 root 环境与 Chromium sandbox；本地无法运行时标“未验证，依赖 CI”，不加 `--no-sandbox`。
- 用户正在使用的 App 不会因为改动自动更新；需要验收外观时启动独立 test 实例。

## 输出格式

先一句话结论（改了什么界面、外观或交互是否变化），然后：

- **改动**：按区域或组件列出，标明“外观不变／有变化／交互变化”
- **验证**：执行了哪些检查、结果，`ui-contract-check.mjs` 三节各自的处理
- **未验证**：本地跑不了的 smoke、未看过的主题或平台
- **需要你决定**：只列真正需要用户拍板的事项

中文、短句；区分“已验证”和“推测”。
