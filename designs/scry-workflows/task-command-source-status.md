# M2 命令来源与读取边界（进行中）

此检查点实现 main-owned 命令目录和纯数据语法解析，已接入真实 `conversation:commands` IPC。**尚未接入命令发送、模式授权或路由；不代表完整 M2。**

## 已实现

- main 根据实际 conversation、canonical workspace 与当前原生接续身份生成命令 ID。renderer 只能选择 ID，不能声明来源、工作区、authoring 权限或费用授权。
- Scry 命名空间和 Provider 命令明确分源。同名时要求选择；Provider 内部重复名称不能伪装成可按定义 ID 精确执行。
- 原生命令目录 `unsupported/unknown/degraded` 不等于 `ready + []`。缺少完整目录时不推断“没有冲突”；仍可明确选择已知 Scry 项。
- 原生目录最多 512 条、规范化元数据最多 256 KiB。超限返回 unknown，不裁剪后冒充完整。真实 Provider 超限时，需要分页目录合同及相应验收后才能调整限制。错误摘要最多 4096 字符，并显式标记截断。
- 发现前后重验原生身份；变化时丢弃结果，不重试。目录 ID 不是权限令牌，也不证明完整模型配置、命令文件内容或原生实现不可变。
- CLI 解析仅处理顶层命令位置；保留参数正文，不执行 shell。覆盖 list、size/default、run、direct、mode、research、指定来源或裸 UUID 的 template/edit。解析结果只是请求，不授予模式、数据、费用或执行权限。
- 新 IPC 经过生产 trusted wrapper，启动恢复与异步项目 authority 在原生命令发现之前完成。复用原有项目授权，无新的任意路径入口。

## 验证

- `command-api-registered-gates.log`：Node/web typecheck、6 文件 53 测试、App build 通过。覆盖目录来源、重名、陈旧 ID、Provider 伪造来源、目录上限、CLI 参数、metadata identity 变化、默认 off 提交、生产 IPC wrapper 拒绝及性能目录分类。
- `command-id-negative.log`：故意移除 ID 匹配后，来源回归测试失败（1 fail，9 个由过滤器排除）；恢复源码后 10/10 通过。未修改断言。
- 首次新增 API typecheck 因测试使用不存在的局部变量失败；修正为实际 canonical cwd。随后 4 个测试因合成 Pi Profile 不符合既有 `pi:<16 hex>` 合同失败；仅修正 fixture，未放宽生产校验。原日志保留。
- `command-api-current-app.log`：独立 userData、临时工作区、既有 FakeProvider 的生产 App/真实 preload IPC 通过。原生目录明确 unsupported，只有 main-owned Scry 项；伪造来源/工作区请求拒绝；注入未授权目录的临时 App 记录后，实际 handler 在发现之前拒绝。恢复后 conversation 字节不变，目录读取新增 TaskSubmission 0、Agent run 0。
- 同次 App 保留原 6 个 ownership 拒绝、正向 fork/resume/delete、2 个普通 task、并发重复去重、晚 fence 为 not_sent、冷启动不重发及输入字节不变检查。总 FakeProvider 调用仍为 4。仅证明已执行场景，不是实际 SDK 或账户验收。

证据根：`/tmp/scry-workflow-task-entry.V7ObQf/`。场景：`scry-electron-smoke-Jmy6fI`。完整路径见日志。

当前受验构建：

- main SHA-256：`c28a57c5edb4bf1019128996d626d7470a42c2d340bc02193afc4774b5974ecb`
- preload SHA-256：`eb5540aefdb0c3295eca2ced575d82b8923606111b0a7333dc0d841021ac96f0`
- `command-api-current-app-identities.json`：30 个源码与 16 个构建文件哈希；本地校验和，不是签名或执行授权。

## Renderer 前置拆分

`useConversationReadback.ts` 接管分页读取、原生运行观察、初次选择和清理。`ConversationView.tsx` 降至 19,637 字节；未改变 JSX/CSS。

- `readback-equivalence.json`：36 个保留语句、10 个迁移状态声明、refresh/effect 完整 AST 对照；只允许参数化 conversationId、稳定 live notifier 与父 error setter。
- 隔离 Electron 中的真实 React DOM fixture 验证乱序读取、无关事件、分页、最新 callback、错误及 unmount fence。移除 generation 防护的负控确实失败；当前源码通过。该 fixture 已加入现有 renderer UI gate，未删除旧检查。
- `readback-current-gates.log`：typecheck、4 文件 34 测试、该 fixture、build 通过；与上述 53 测试有重叠，不相加。
- 此 fixture 不证明实际点击命中、焦点、CSS、完整 App readback 或真实 Provider。活动运行的轮询分支仅有完整源码等价证明，未单独交互验收。

## 保留限制与下一步

命令发送、typed 选择菜单、单次覆盖、会话 manual/auto 与费用/数据授权、一次 route+plan、canonical authoring 消费仍由主实现继续。旧完整单测/恢复/Node TAP/SystemStep 超时没有被重跑清除；当前源码不据此宣称全量通过。`send.codex-fixture` collector 仍 unavailable，不记 0 或性能成功；未更改 workload、门限或既有指标定义。新增目录 IPC/阶段 trace 只做必要分类与观测。

按用户明确决定，跳过不可用的本机 Claude CLI，不下载、替换或继续探针；历史失败不变成通过。未执行真实模型、账户或费用操作。未提交、推送、安装、升版本或重启日常实例。关闭证据仅为既有 registered-resource stop helper 返回，不覆盖 escaped descendants 或远端业务效果。
