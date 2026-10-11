# Scry · 队列消息 Steer 设计稿

## 范围与状态

- 日期：2026-10-11。
- 用户要求：为 Scry 的队列消息增加点击 Steer 的入口，先出设计稿。所附截图为指定视觉和交互参考。
- 状态：candidate / needs-review；未获用户验收，不是已经实现的产品能力。
- 交付：`index.html`，零依赖、无外部资源的可点击 HTML 原型。未改 `src/`，未升版本，未调用真实 Provider。
- 路由：现有模式的局部新增。保留队列位置、索引、附件提示、移除按钮和默认排队行为，不另做 App 重设计或多个无关布局。

## 方案

每条排队消息右侧增加常驻的 `↳ Steer` 按钮。点击按钮直接将该条消息补充给当前运行任务，不先 interrupt，也不替换成下一轮任务。行本身不点击发送，以免选取文字时误触。

```text
当前任务运行中
┌ 等待运行 2 ─────────────── 当前任务结束后依次发送 ┐
│ 1  先出设计稿，不要改产品代码。      [↳ Steer] [×] │
│ 2  设计确认后，再补充其他状态。 附件1 [↳ Steer] [×] │
└────────────────────────────────────────────────┘
┌ 补充要求，或添加下一条消息…                      ┐
│ Codex · 模型 · Effort                [加入队列]  │
└────────────────────────────────────────────────┘
```

- 悬停或键盘聚焦：说明「不中断模型，将这条消息补充给当前任务」。
- 提交中：该条显示「提交中」，保留原文本和附件；禁止重复提交和移除。暂时禁止另一个 Steer，减少并发状态歧义。仍可加入普通队列消息。
- 已接收：只在 Provider 明确回执后移出该条；会话显示完整补充消息与 `Steer · Provider 已接收` 标签，其他消息顺序不变。
- 明确拒绝：该条仍在队列，显示行内原因和「重试」。正常的下一轮发送仍可按队列进行。
- 结果未知：该条保留，但不能重发、移除或自动作为下一轮重复发送。先核对 Provider 回执；不要把超时当作明确拒绝。
- 不支持：保留禁用按钮，并在队列底部显示能力原因；普通排队不受影响。原型模拟该能力状态，不代表 Codex 真实不支持。
- 任务已结束：禁用 Steer，进入正常队列路径。原型只展示这一状态，不自动启动真实下一轮。

## 实现时必须保留的合同（尚未实现）

1. 主进程基于当前 Provider、runtime、run 与 turn 的真实能力决定可否 Steer，不能只凭 Provider 名称猜测。
2. 调用绑定稳定消息 ID、run/turn 身份；不能仅凭队列索引定位，不能发送到已切换的会话。
3. 文本与附件必须一起传递；不支持附件时明确禁用该条，不能静默丢图。
4. 主进程在发送前重验任务仍活动；任务终结与回执竞争时，不能把补充消息同时 Steer 和下一轮发送。
5. `pending` 与 `unknown` 不进入现有自动出队逻辑。收到明确拒绝后才恢复普通队列状态；成功回执才移除。
6. 接收不等于模型已经读取、遵循或完成新要求。保留补充消息来源和 native 回执证据；不能重复统计为新的逻辑 turn，也不能丢失 recorder 记录。
7. 不支持原生运行中补充的 Provider 不能用 stop + restart 冒充 Steer。后续接入逐 Provider 核验，未验证的支持状态保持 unknown。

## 调研与复用回执

| 来源 / 区域 | 观察 | 采用 / 拒绝 | 检查 |
| --- | --- | --- | --- |
| 用户原始截图 / 队列行右侧 | 行内箭头加 Steer，tooltip 为不打断模型；移除保持独立 | 采用入口位置和语义；不复制 Goal stalled 等无关能力 | 原型的行内按钮、tooltip、独立移除 |
| `src/renderer/components/ChatView.tsx:637–677` | 队列已在 composer 上方，有索引、附件和移除 | 保留结构和排队默认行为，仅新增动作 | 两条队列，带附件示例，按钮不覆盖文本 |
| `src/renderer/styles.css:1–145,2269–2394` | 深浅主题、紧凑字体、10px 队列圆角、6px 按钮圆角 | 复用当前 token 子集、队列层级、字体和主题；HTML 自包含，不依赖工程构建 | Chrome 中深浅主题渲染 |
| `src/renderer/components/primitives/Icon.tsx` | 当前 stroke 图标体系 | 复用 clock/x/folder/message/check/image 等路径；Steer 新增单个折向箭头 | 实际渲染中检查图标和 stop 方框 |
| `src/renderer/App.tsx:1433–1471,1540–1602` | 空闲后自动取队列首条，运行中普通消息加入队列 | 不改变普通发送语义；为未来接入记录 pending/unknown 排除要求 | 设计区分加入队列和 Steer，未修改自动出队源码 |
| `src/main/providers/types.ts:40–60` | 当前 handle 有 interrupt、forceKill 等，没有 steer 合同 | 明确仅为设计稿；不声称 Scry 已具备 Steer | 本次没有 Provider / IPC / recorder 修改 |
| [OpenAI Codex app-server 原始 README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#managed-model-provider-requirements) / Managed model provider requirements | 原文将 turn start/steer 列为输入 RPC，配置不匹配时会拒绝 | 采用明确拒绝与接收证据分离；不据此宣称本仓库安装版本的支持矩阵 | 2026-10-11 直接获取原始 README，定向读取该小节；不是全文阅读或真实 RPC 验收 |

个人库检索：项目 `Scry` 命中现有后台任务等项目记录，阅读 `designs/scry-background-work/brief.md`，延续“静默/接收不等于完成”的证据语义。`Scry composer` page、`queue` / `排队 Steer` component 未命中可复用条目，因此优先复用本仓库真实组件和 token，不引入个人 demo 主题。历史 composer metadata 已查看，不将旧截图当作当前 App。

Craft：采用 [Hover 克制](https://craft.gustavofior.com/hover-restraint)、[HTML 根背景](https://craft.gustavofior.com/html-background)、[等宽数字](https://craft.gustavofior.com/tabular-numbers)。行内 hover 即时高亮；tooltip 仅首轮短延迟；根画布随主题切换；计时、队列计数使用 tabular-nums。其余排版与按钮层级是项目局部设计判断，不冒充已索引规则。

## 预览与验证

```sh
# 从仓库根运行
python3 -m http.server 4311 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:4311/designs/scry-steer/
```

原型所有 Provider 数据、回执、附件均为模拟。演示的正常提交在 1.1 秒后模拟确认，不是真实后台操作；顶栏与回执均明确标注。

已验证：
- Chrome Relay 中实际点击正常 Steer：先显示提交中，再将队列从 2 变为 1，第一条完整文本进入会话，第二条保留，当前任务仍显示运行中。
- 结果未知：第一条禁用，原消息和附件计数保留，显示“暂不重发或自动出队”。
- 任务已结束：多个运行状态读回均为已结束，队列仍保留，不宣称 Steer 成功。
- 深色初版与浅色当前稿真实渲染检查；修正 stop 图标缺少 viewBox 的裁切，以及提交中按钮的键盘聚焦保持。当前稿的正常提交与未知状态已重放。
- 当前稿的明确失败、能力不支持状态读回已检查；失败保留两条队列消息，不支持状态两个 Steer 均为 disabled。
- inline JavaScript 语法、静态 HTML ID / 内部引用、`git diff --check`。

未验证：完整 Scry App 重放、真实 Provider 的运行中接收、附件上传、错误 RPC、自动下一轮竞争、recorder / usage 记录；没有真实账号/费用操作。窄屏 CSS 已提供，但未实际调整设备视口验收。HTML 原型不是上述能力的替代验收。

不运行 App 构建、全量测试或安装：本次只新增设计 artifact，不修改产品代码。

## 本地保存与个人库状态

- `D-20261011-scry-steer` 已登记为项目 candidate，可通过 `library.py search 'Steer' --kind project` 检索；`_d_meta.json` 为 needs-review。
- 本次登记、build、search 成功。全库 `check` 仍失败：已有 `P-PI-MODEL-SELECTOR` 指向不存在的 `pi/packages/coding-agent/design/decisions.md`。这是此前查库已存在的 stale 指针，不属于本次设计范围；未静默删除，不宣称全库健康。
- 未更新全局视觉偏好，未登记为通用组件或 approved 模板，未上传图片或设计稿。
