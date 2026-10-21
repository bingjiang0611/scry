# Scry 用量 · Bolder 设计稿

- 状态：needs-review，待用户确认；仅设计稿，未改 App 运行代码。
- Surface mode：Operate。目标是更快读出总成本、集中来源和趋势，而不是增加装饰。
- 入口：`index.html`。预览：`http://127.0.0.1:8766/index.html`。
- 启动：在仓库根目录运行 `python3 -m http.server 8766 --bind 127.0.0.1 --directory designs/scry-usage-bolder`。

## 方向

沿用用户截图和当前 `src/renderer/analytics-evidence.css` 的黑白灰、Qoder 金色与系统字体。没有新增品牌色、字体、图片、阴影卡片或装饰性动效。

1. 顶部把总额与成本构成并列。横向比例条代替四个低信息密度进度条，让 Codex 的 81.8% 在结构上可见。
2. 趋势图成为主画布，右侧为按已知成本排序的 Provider 清单。金额右对齐，来源与完整性分层。
3. 总额的已知下界、非实际账单以及 unknown 的成本不可用仍然可见。Provider 来源、Token 完整性和覆盖范围统一收进“数据说明”，不再放在各行下方。
4. 底部五项 Token 指标统一基线，只保留名称和数值；不再显示指标脚注、覆盖提示与底部解释。原始口径仍可在“数据说明”查看，不把缺证据当作零。

## v2 · 去掉常驻说明小字

按用户反馈，移除 Provider 下方来源与完整性说明、各指标脚注、覆盖提示和重复辅助文案。Provider 占比与金额改为同行排列。“数据说明”集中保留这些证据。HTML 资源链接增加 v2 标识，避免浏览器继续显示旧稿缓存。

## 事实与示意的边界

- 总额、Provider 金额/比例、Credits、Token 指标与覆盖范围均沿用用户截图，不读取用户 DB、会话或真实账单。
- 没有补全截图中 Codex 被截断的 Token 数字。
- 每日曲线为人工示意数据，不是从截图精确采样；页面顶部及图表可访问名称均声明此边界。
- unknown 成本为 `—`，不分配比例；不能据此宣称全部成本已知。
- 返回、7/30/90 天、刷新、Token 切换均禁用。唯一交互是原生 `details/summary` 展开数据说明，没有伪造数据加载。
- UI 文案集中在 `copy.js`，渲染在 `draft.js`，样式在 `style.css`。零依赖，无外部资源请求。

## 参考与复用

- 首要视觉依据：本次用户截图。源码核对：`AnalyticsView.tsx`、`analytics-evidence.css`、`codex-alignment.css`。
- 已查个人库的 Scry 记录与 usage 组件。`UsageReadout` 的 unavailable / lower-bound 思路与本页一致；不引入其独立 React 样式或依赖。
- 已查看仓库 `designs/scry-analytics-narrative/`、`designs/scry-qoder-credits/`。历史稿不是本次截图的视觉权威。
- 外部内容调研：https://vercel.com/docs/observability 可读取，只作观测信息组织参考，未做其页面视觉验收或复制布局。OpenAI usage 帮助页返回了前置页面，未用作有效参考。
- 新产物仅登记在本目录 `_d_meta.json`；尚未被用户接受，不记为全局审美偏好，不进入已批准组件库。

## 已执行验证

| 项目 | 结果 | 范围 / 证据 |
| --- | --- | --- |
| 浏览器目视 | 通过 | 当前稿，Chrome Relay，1512 × 708 CSS px；顶部与滚动到底部分别查看，无可见重叠或截断。短窗口需要纵向滚动。 |
| 全文遍历 | 通过 | snapshot：contentCoverage=scroll-end，contentComplete=true，truncated=false，scrolledContainers=1，无分页游标遗漏。 |
| 数据说明交互 | 通过 | v2 点击后回读完整的 Provider 来源、Token 完整性、指标口径及覆盖范围；默认闭合状态不显示这些说明。 |
| JS 语法 | 通过 | `node --check` 检查 `copy.js`、`draft.js`。 |
| 数据与渲染检查 | 通过 | v1 验证金额合计 458706 美分、占比合计 100%。v2 用 Node vm 运行新旧两个版本：旧稿无法通过去小字检查，新稿通过；常驻说明被移除，详细证据与五项数值保留，无 undefined/NaN。 |
| 文字对比度 | 通过 | 基底 #0d0d0c 上主文字 16.44:1、次文字 7.57:1、Qoder 金色 8.45:1。仅代表这三组颜色，不代表完整无障碍认证。 |
| 静态资源 | 通过 | index.html / style.css / copy.js / draft.js 均 HTTP 200。 |

## 限制与下一步

- 尚未在较窄真实浏览器 viewport、浅色主题或 Scry App 中验收；本轮是指定深色桌面界面的方向稿，不是生产交付。
- 媒体查询已编写，不把源码存在当成响应式视觉验收。
- 未运行 App unit/typecheck/build，不构建、不安装、不触发 Provider。本稿不改变 App。
- 用户下一步：确认本方向，或指定希望继续放大的部分。确认后才将设计接入真实数据与 App，并按受影响路径做测试和真实界面验收。
