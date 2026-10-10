# LLM 性能

左侧「LLM 性能」位于技能上方。点击打开居中弹窗；侧栏没有实时数字或网络设置。弹窗展示数字、近 30 秒趋势和历史同类对照，数据口径默认折叠。关闭、Escape 和焦点返回沿用 ModalFrame。

## 实时证据

范围是本 Scry 实例登记的全部当前运行会话，跨项目、Provider 和模型。复用 run registry 和每个主 run 的最新 observer 小摘要，不扫描 trace，也不随当前查看会话改变。一个会话只取当前主 run。各指标独立按可测会话等权平均，分别显示「可测数 / 运行数」；缺失不补零。

- 输出速度、会话均速只用 token/s。没有权威且区间对齐的主输出 token 计数时显示未知，不从字符、消息块、分词器或经验比例换算。
- 首次输出等待用秒，计时从本地执行接受到首个主文本输出，包含启动和排队。尚未首输出的运行只计入运行数，不拿已经等待的时长当最终等待值。
- 终态 canonical usage 不回填实时速度或曲线。全部不可测时只显示未知和空图提示。
- 主进程运行期间独立每秒采样最多一次，保存最近 30 秒最多 30 点；空闲时停止采样并清空实时值。成员变化最多在下一次采样生效。IPC 只读取缓存；弹窗自身刷新，不使 Sidebar/App 每秒重渲染。隐藏或关闭弹窗停止视图刷新，异步返回不会更新已关闭视图。
- 实时读取失败清空旧摘要并显示错误，不继续显示上一次的数字。

## 当前五类 Provider 接线

| Provider | 当前生产来源 | 实时 token 速度 |
| --- | --- | --- |
| Claude | normalize 的主文本 delta；result 的 canonical usage/API 时间 | 未接入区间对齐的主输出 token 计数，不可测 |
| Codex | agentMessage delta；thread/tokenUsage 用于 canonical turn usage | usage 通知未形成主输出时间窗证据，不可测 |
| Qoder | SDK 消息经 normalizeQoderMessage/qoderTrace；result usage | 无主输出 token 时间窗证据，不可测 |
| OpenCode | text delta / retry genuineStreamDelta；assistant 消息终态 usage 聚合 | 无主输出 token 时间窗证据，不可测 |
| Pi | message_update 文本；message_end usage 与最终 turn result | 无主输出 token 时间窗证据，不可测 |

以上描述的是当前 Scry 接线，不宣称上游永远不支持。后续只有实际 adapter 提供权威主输出 token 计数、身份和对应时间窗，并补 Provider wire 回归后，才增加实时测量能力。现在没有新增虚构的 Provider capability 字段。

首次输出等待仍可使用。历史 API 推导仅在完整 canonical 输出 token 和 Provider API 时间都存在且可配对时计算。Claude continuation 取最新累计快照，其他 Provider 的增量结果累加；不以墙钟、工具残差或活动时间代替 API 时间。API 推导可能包含 prefill、思考或 Provider 计入的子代理用量，不是主文本解码速度。

## 自动网络配置线索

启动和运行边界异步采集本机配置，不阻塞 Provider 启动。macOS 使用固定的 `scutil --proxy`，只保留 HTTP/HTTPS/SOCKS/PAC/自动发现开关；其他平台系统配置未知。App 环境只保留 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY 是否配置，不保存任何值、代理地址或凭据。

所有运行共享至少 30 秒的缓存及同一次在途采集。记录采集时间与来源；系统读取失败保存未知。没有 LLM、公网 IP 或测速请求，不切 VPN，不读取 SSID。配置快照不证明实际请求使用了代理或直连，也不证明 Provider 生效环境与 App 环境相同。快照不会因运行持续而变成新的事实；下次运行边界重新采集到期缓存。

## 历史与归属

- 沿用 `userData/usage.jsonl` 的 `kind: llm_performance`，不增加 DB 或 recorder 事实源。这些行不计入 billing 或 turn 数，沿用原 session 删除归属。
- 最近 30 天最多 1000 轮，按 Provider/Profile/模型/上游及配置线索分组。配置未知的自动记录不池化为相同网络。旧手动标签明确显示为「历史备注」，不冒充自动检测。
- 每组可展开逐轮时间、run ID、失败/停止、首次输出等待、canonical 输出 token、API 时间及 API 推导。失败/停止保留，但不计入成功中位数。实时输出 token 历史目前同样不可测。
- 损坏行和截断保留部分证据提示。历史按需读取，共享一次扫描；文件身份、大小、修改时间和变更时间使追加与原子删除失效，30 天期限也会使缓存失效。缓存只保留一个 userData 文件，返回量有界。
- Trace 保留本地测速快照与当时已经采集到的配置线索；过早终态的 history 会等待有上限的本机采集完成。进程崩溃或未收口执行不保证有终态测速记录。

扫描预算仍为流式 JSONL、30 天/1000 轮。如果实际文件扫描延迟不可接受或需要更长历史，升级到既有 SQLite 投影，保留相同证据与删除合同；不扩大 IPC 上限。

## 验证入口

```sh
npm run test:unit -- src/shared/llm-performance.test.ts src/main/llm-performance.test.ts src/main/llm-performance-history.test.ts src/main/llm-performance-sampling.test.ts src/main/llm-network-configuration.test.ts src/main/usage-jsonl.test.ts src/shared/trace.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts --exclude '.local/**'
node scripts/session-capability-ui-smoke.mjs --performance-only
npm run typecheck
npm run build
node scripts/electron-security-smoke.mjs --dev-performance-only
```

UI fixture 使用生产 App、registry、sampler 和 observer；跨项目/Provider 的数据由真实观测事件产生，不硬编码摘要。它验证等待/部分可测、成员结束/停止/空闲、焦点独立、逐轮历史、错误清空、隐藏/关闭停止刷新和两种主题。生产 IPC smoke 使用当前构建的 main/preload/renderer、临时 HOME/userData 和显式 smoke adapter，验证登记、采样时钟、冻结配置、失败历史、真实鼠标/键盘与焦点返回。两者都不启动真实付费 Provider。

本次首轮 unit/typecheck/build 通过。UI 首次失败源于 fixture 订阅计数未同步、且把 App 常驻订阅误当作面板残留；第二次失败源于同时出现两个 alert 时只检查第一个。修正计数与选择器后保留原行为断言，没有 skip 或延长超时。生产 IPC smoke 首次因新增临时项目没有登记目录授权被拒绝；修正隔离 fixture 的 recent-folders 登记，未绕过生产授权。旧子任务的组合验证仍缺结束事件，不能算本次通过证据。

设计合同与参考见 [brief](../designs/scry-llm-performance-sidebar/brief.md)。原型样例不代表 Provider 已有实时 token 能力；本次没有付费探针、真实厂商/VPN 对比或安装验收。
