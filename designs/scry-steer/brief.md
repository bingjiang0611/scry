# Scry · 队列消息 Steer 设计稿

## 范围与状态

- 日期：2026-10-11。
- 用户要求：为 Scry 的队列消息增加点击 Steer 的入口，先出设计稿。所附截图为指定视觉和交互参考。
- 状态：用户已明确批准设计并授权实现（「没问题 实现吧」）；产品源码已实现，真实 Provider 接收仍未验收。
- 交付：`index.html` 为已获批准的零依赖 HTML 原型；实现路径和检查范围见末尾。没有真实账号/费用操作，未升版本、安装或发布。
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

## 实现合同

1. 主进程基于当前 Provider、runtime、run 与 turn 的真实能力决定可否 Steer，不能只凭 Provider 名称猜测。
2. 调用绑定稳定消息 ID、run/turn 身份；不能仅凭队列索引定位，不能发送到已切换的会话。
3. 文本与附件必须一起传递；不支持附件时明确禁用该条，不能静默丢图。
4. 主进程在发送前重验任务仍活动；任务终结与回执竞争时，不能把补充消息同时 Steer 和下一轮发送。
5. `pending` 与 `unknown` 不进入现有自动出队逻辑。收到明确拒绝后才恢复普通队列状态；成功回执才移除。
6. 接收不等于模型已经读取、遵循或完成新要求。保留补充消息来源和 native 回执证据；不能重复统计为新的逻辑 turn，也不能丢失 recorder 记录。
7. 不支持原生运行中补充的 Provider 不能用 stop + restart 冒充 Steer。后续接入逐 Provider 核验，未验证的支持状态保持 unknown。

## 设计阶段调研与复用回执

以下源码位置与「未修改」描述记录设计阶段，不代表实现后的状态。

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

## 原型预览与验证

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

设计阶段没有构建 App、运行全量测试或安装；实现阶段的检查另列如下。

## 本地保存与个人库状态

- `D-20261011-scry-steer` 已登记为项目记录，可通过 `library.py search 'Steer' --kind project` 检索；`_d_meta.json` 标记已批准的原型，不表示真实 Provider 验收。
- 本次登记、build、search 成功。全库 `check` 仍失败：已有 `P-PI-MODEL-SELECTOR` 指向不存在的 `pi/packages/coding-agent/design/decisions.md`。这是此前查库已存在的 stale 指针，不属于本次设计范围；未静默删除，不宣称全库健康。
- 未更新全局视觉偏好，未登记为通用组件或 approved 模板，未上传图片或设计稿。

## 产品实现与验收范围

### 已实现

- Codex：同一 app-server transport 的 `turn/steer`，绑定 `threadId` 与 `expectedTurnId`。回执必须返回匹配的 turn ID；运行中控制请求不会自动启动新 transport。
- Pi：当前 Scry native RPC runtime 的 `steer` 文本/图片输入。明确拒绝与未知结果分开；agent 结束与回执竞争、超时等未知结果禁止复用 RPC，避免下一轮带入旧输入。同一 Scry run 的后续 `agent_start` 重建 cycle guard，旧 cycle 的回执仍按未知处理；回归先证明第二个 cycle 被错误拒绝，再修正。只有实际 Steer dispatch 才允许补充 user entries，根身份保留最早且同 ancestry 的原始 user entry。
- Claude、Qoder、OpenCode：保持 unavailable；普通排队不变，不用 interrupt/restart 代替 Steer。
- 主进程重验 run、Provider、profile、canonical cwd 和 native session；稳定 message ID 防重，同步隔离 in-flight 与 accepted 身份。附件分批隔离，失败只回滚本批。
- 队列保留 FIFO、原文与图片；pending/unknown 禁止重复发送和移除，拒绝可重试。手动停止仍清空普通队列，但保留并暂停待确认的 Steer，防止稍后拒绝回执触发自动下一轮。保留普通队首正在启动时的移除保护，并禁止同时 Steer。已接收仅表示 Provider admission，不表示模型遵循。
- `human / steer` 生命周期进入原有 trace archive，recorder 保持一轮一文件，原始 prompt 不被替换；`user.value.steers` 保留每条最终 admission，图片仅保存尺寸/hash，不在 workspace record 内存 base64。

代码入口：`src/main/run-steering.ts`、`src/main/index.ts`、`src/main/providers/{codex,pi}.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`src/renderer/steer.ts`、`src/renderer/components/{ChatView,ChatTurn}.tsx`、`src/core/turn-recorder/aggregate.ts`、`src/shared/{runtime,turn-record}.ts`。`scripts/steer-ui-smoke.mjs` 使用隔离 Electron fixture 和坐标命中，不是完整 App 的真实 Provider 验收。

### 实际检查与首次失败

- 受影响的 Provider/queue/recorder 测试：串行 focused 260 passed。
- 全量 source-only unit：`LC_ALL=C P0_PROBE=0 P1_PROBE=0 BILLING_ADMIN_REAL=0 npm run test:unit -- --exclude '**/.local/**' --maxWorkers 1`，2590 passed、3 个真实探针 skipped。运行时存在其他任务的无关 WIP；不统计 `.local` 源码副本。之后自审增加拒绝数组伪装 status/MIME 的回归，先证明失败再修正，单独重验最终 schema。
- 最终 focused Pi/renderer/队列/schema/主进程 admission/进程清理 360 passed（包括 Pi 全部 77 项）；独立 Steer 原生键盘 Enter、坐标点击、目标行选择、pending 禁用、unknown 阻断、图片按钮可达和手动 Stop 保留保护通过。Credits 与 shell fixture 通过。
- CLI/Core 合同 569 passed，CLI 构建通过；Node 22.22.1 / npm 10.9.4 的隔离 tarball 安装、bin/init/hook/doctor smoke 通过。Node 24 / npm 12.2.0 的首次 package smoke 因 `npm pack --json` 不返回预期数组而失败，未修改断言掩盖工具版本差异。
- 先前完整类型检查通过；最终 web 类型检查、App/CLI 构建及 `LC_ALL=C npm run pack:artifact`（含 packaged resource 和实际 Electron security smoke）通过。最终完整 typecheck 被其他任务引入的 `src/main/remote/remote-host-service.test.ts:129,134`（disabled RemoteStatus 没有 devices）阻断，Node 22/24 均失败；未修改无关测试，不能宣称最终完整 gate 通过。Packaged smoke 覆盖实际 main/preload/renderer 隔离和历史/终端路径，不代表真实 Steer 接收。
- 首次默认区域设置全量 unit 有 4 个失败：进程清理身份不可得，Pi extension acknowledgement、CLI EPIPE、remote Git 各超时。前者定位为 en_NZ 的 `lstart` 顺序与脚本固定格式不匹配；后三者在串行全量及 focused 检查通过。保留首次失败，不删断言、不扩大超时、不放宽清理身份校验；本次遗留的隔离 App 已按确切 PID/启动时间/argv 重验并清理。Steer smoke 的超时路径现在复用 `scripts/owned-app-processes.mjs`；该 helper 在 `ps` 子进程中固定 `LC_ALL=C`，默认 en_NZ 下 TERM-resistant 回归通过。
- 新增 Stop 界面检查首轮工具调用 120s 超时；现场为 10 核、32 GiB，聚合 CPU 1007%、RSS 21.4 GiB，无法证明资源争用是唯一原因。旧脚本仅 TERM 根进程且缺少部分进度；现在保留 30s/5s 原时限、输出阶段诊断、重验并清理已登记的子进程；无法证明清理时保留 fixture。后续检查通过，首次超时不被抹去。
- `test:renderer:ui` 整体仍失败：既有 session-capability fixture 缺少 `workspaceResolveFile`，所以没有宣称完整 renderer UI gate 通过；独立 Steer/Credits 不受此失败遮蔽。

### 未验证与交付限制

没有真实 Codex/Pi 账号接收、模型遵循、完整 App 的 Steer 原始操作重放或 Provider 费用验收。Node 24 本地 unit 与 Node 22 CLI smoke 不替代 Node 20/22/24 完整 compatibility matrix。没有安装 App、notarize、registry 发布或 push。保留其他任务 WIP 和原有性能截图，只提交 Steer 相关改动。
