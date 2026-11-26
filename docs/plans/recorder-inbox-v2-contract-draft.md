# Recorder Inbox v2 契约草案

状态：待评审，未实现。目标是让已经获准的宿主集成在开场钩子里不启动 Node，也能可靠提交认领请求。落盘只代表接受请求，不代表开启采集、建立 Git 基线、封箱或上传。v2 不改变晚基线证据规则，也不迁移现有 v1 条目。

## 1. 目录和条目

收件箱放在 canonical 工作区下的 `.scry/inbox-v2/`。它与旧版 `.scry/runtime/`、`.scry/locks/` 分开；即使已配置其他 `dataDir`，新收件箱仍在这个位置，消费后的运行态仍写入经验证的配置目录。若该工作区的 v1 `dataDir` 选了这个目录或它的子目录，拒绝 v2，避免路径重叠。不要把新目录链接到旧目录，也不要写入 v1 的 attention 索引。

```text
.scry/inbox-v2/
  sessions/<provider>/<sessionKey>/
    inbox/<sequence>-<entryId>.json
    failed/<sequence>-<entryId>.json
    failure/<sequence>-<entryId>.json
    next-sequence
  locks/<provider>/<sessionKey>.lock/
  attention/<provider>/<sessionKey>
```

- `provider` 使用 recorder 已支持的标识；`sessionKey` 是原始 `sessionId` 的 UTF-8 字节的 SHA-256 小写十六进制，不做 Unicode 正规化。路径不使用原始 ID；消费者重新计算并与条目核对。不依赖 v1 的 `safeKey`。`entryId` 是小写标准 UUID，重试沿用同一 ID。
- v2 使用 UTF-8 JSON 对象。公共字段为 `schemaVersion: 2`、`entryId`、`provider`、`sessionId`、`workspace`（canonical 绝对路径）、`arrivedAt`（UTC ISO 8601，仅供观测）、`kind`。拒绝重复键、超限字段和未识别的版本或种类，不落入普通 hook 处理。上限建议为单项 1 MiB，超限返回明确失败，不静默截断；正式冻结前用真实样本确认。
- `kind: "capture"` 另外带 `action: "start" | "stop"`、`capture`（现有 `codelens.session-capture.v1` 上下文）、`event`、`payload`、`authorityRef`。`event` 是实际宿主事件或显式认领命令的 `CaptureStart`/`CaptureStop`，不得按转录是否存在重新命名。`payload` 是原始宿主对象。`authorityRef` 是受信任集成安装授予的引用，不是授权内容。`start` 连同触发它的事件是一条请求；消费者只应用该事件一次。`stop` 必须引用同一 capture，不能创建工作区或采集。
- `kind: "hook"` 另外带 `captureId`、`event`、`payload`，只对同批或已生效的认领有效。普通 hook 不能触发初始化。一个会话不能把 start 写到 v2、后续事件写到 v1；在首次接收前选择通道，并维持到会话结束。迁移或故障回退不得重投已落盘的同一事件。

### 持久化、顺序与唤醒

生产、消费和清理 attention 共用该会话的目录锁。互操作锁需要相同的目录创建、所有者标记和过期/恢复协议；不得仅按文件年龄抢活锁。锁忙时返回可区分的未写入结果，不写未排序的条目。序号是固定 20 位十进制字符，严格按其数值排序，不按宿主时钟。序号先持久预留再写条目；崩溃可留空号，不可复用。达到序号上限时失败，不回绕。

在目标目录写同文件系统独占临时文件，权限仅本机用户可读写；文件 `fsync` 后原子发布，随后同步父目录。不得覆盖已落盘文件；同 `entryId` 同内容的重试返回既有结果，冲突拒绝。消费者只读最终文件名，核对身份并验证内容；应用成功后才确认并删除。进程崩溃后重放靠持久的 `entryId`/`captureId` 状态收据幂等，不能靠序号猜测业务成功。失败条目和脱敏原因分开保留。同会话前置认领未应用时，后续条目不可越过；永久拒绝后明确隔离依赖该认领的条目。

条目发布后，在同一把锁下持久化 attention。唤醒可以由已验证支持 v2 的 daemon 接口触发，也可以由受信任集成的后台任务启动消费；它是提示，不是投递保证。`serve` 启动与显式 `recover` 必须发现“条目已落盘、未写 attention”这一崩溃窗口。清除 attention 前，在同一把锁下确认没有可处理条目。禁止通过伪造 v1 attention 或向旧 daemon 提交 v2 请求唤醒。

## 2. 受限冷启动入口

`serve` / `recover` 增加一个只读发现入口，可在配置不存在时检查固定 v2 路径，但只有通过下列验证的 `capture/start` 才能开始初始化：

1. canonical 工作区和实际条目、数据根都匹配；拒绝相对路径、路径穿越、符号链接跳转或越出工作区。不从条目接受任意数据根。
2. 条目目录、载荷、capture 上下文中的宿主和会话全部一致，并按现有宿主规则核验转录路径与宿主证据；不得扩大 Qoder 尚未落盘例外或读取其他会话的转录。
3. 独立于仓库和队列内容核对已有的宿主集成授权及其指纹、工作区范围与有效性。`authorityRef` 是查找键，不凭字符串本身放行。不具备可验证授权、指纹变化、非开场指令、普通 hook、任意文件或身份冲突，都拒绝。该授权解决仓库不可信问题，不宣称能隔离同一 OS 用户内的恶意进程。
4. 仍尊重禁用 sentinel、禁用环境、配置禁用或无效配置。缺配置仅允许上述授权路径按现有 `capture start` 默认值初始化；已有不同配置不能被覆盖。复用幂等的目录/配置、Git exclude 和接收器初始化。提交钩子必须独立通过现有 canonical cwd、可执行文件/配置指纹及 trust 校验；没有合格授权就不激活，见第 4 节。

冷启动与已初始化路径共用现有 session-lock 和认领幂等语义；不能同时用独立的 v1、v2 消费锁打开同一会话。未初始化且未获授权的条目不能产生 `started` 或成功收据。

## 3. 无 Node 能力检查

在 recorder 包根（与 `package.json` 同级）随发布构件提供 `recorder-capabilities.json`，初始字段建议为 `schemaVersion: 1`、`recorderVersion`、`entrypoint`（相对包根）、`entrypointSha256`、`inboxContract: 2`。清单由制包流程生成，放在可校验构件里；安装器校验整个包，不能用工作区自报的清单代替。

Python 先按既有优先级解析实际选中的 CLI canonical 路径，再从其可信安装包根读取清单，不启动 Node。核对 `package.json` 版本、入口文件及摘要与选中的路径一致；无法证明某个自定义 CLI 路径与可信安装构件绑定，就不直写。版本下限等第一个通过 v1/v2 混版本测试的正式版发布后再固定，不能仅凭版本号或 `latest` 认定有能力。

清单缺失、未知版本或能力、路径/摘要不一致，一律在首条落盘前回退原 CLI。若对应工作区已有旧 daemon，或无法确定实际消费者版本，也回退；不能把新包路径当成旧 daemon 已退出的证据。发现无 daemon 时只有在受信任 launcher 能启动同一 v2 构件时才允许直写。不能自动杀旧进程；已落盘的 v2 工作留给相容消费者并报告等待，不通过 v1 重写。即使版本检查遇到竞争，独立目录仍不被旧版消费；新旧 daemon 并存不是可运行模式，必须按工作区验明唯一消费者和同一 session-lock。

## 4. 可随条目携带的上传环境

沿用现有 `UPLOAD_ENV_KEYS`，逐项限制类型、大小、语义与 scope：

- `SCRY_TURN_UPLOAD_ENABLED`、`SCRY_UPLOAD_DEADLINE_SECONDS`、`SCRY_UPLOAD_LOCK_WAIT_SECONDS`、`SCRY_MANAGED_UPLOAD_WAIT_SECONDS`；
- `SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`TMCP_TRACE_URL`、`RATE_NATIVE_ASYNC_QUEUE_DIR`。

含路径或 URL 的值仍受安装授权规定的范围限制；未知键、非字符串、冲突或超限值拒绝。值不写诊断日志，不改变 daemon 的全局环境。不携带凭据、`PATH`、任意 shell 变量或 `SCRY_RECORDER_COMMIT_HOOK`。

提交钩子授权待评审，两种备选：以 `authorityRef` 查找由可信安装器登记的 callback 和指纹；或由宿主启动器预先通过现有验证入口登记一次 grant，条目只引用 grant 和摘要。两种都要重验可执行文件与 canonical cwd；不从队列直接取信路径，不在本草案选定。

## 5. `recover --json` 统计

保留 `recovered`、`pending`、`expired` 的轮次含义。另加版本化的 `inbox` 对象，按实际处理到的 `workspace/provider/session` 范围报告：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 统计 schema 版本，初始为 `1`，与收件箱版本分开。 |
| `scope` | 工作区或指定宿主/会话；不在公开日志打印会话 ID。 |
| `scanComplete` | 是否枚举完所求范围；无配置且不能确认 v2 范围、读取错误或时间预算用尽都不能报 true。 |
| `consumed` | 本次新应用且持久确认的条目数；重放同一条目不再计一次业务成功。 |
| `deduplicated` | 本次经已应用收据确认的重复条目数。 |
| `quarantined` | 本次新隔离的条目数，不等于重试次数。 |
| `remaining` | 此次结束时所求范围内尚未确认、可重试条目数；没有完全枚举时为 `null`，不能报 `0`。 |
| `failedRemaining` | 所求范围内仍保留的终态失败条目数，枚举不全时为 `null`。 |

`consumed` 不表示轮次封箱，更不表示上传成功。现有退出码和诊断不因增加统计而降格；失败不得混入成功条目。

## 6. 混版本与必测矩阵

| 场景 | 预期 | 必测内容 |
| --- | --- | --- |
| 新 Python + 旧 recorder | 能力拒绝，只走 v1 CLI；不写 v2。 | 缺/错清单、自定义二进制、旧 daemon + 新安装、回退只投递一次。 |
| 旧 Python + 新 recorder | 新 recorder 继续消费 v1；v1 不具备冷启动特权。 | 旧认领与后续事件顺序、旧 workspace 配置、不生成或迁移 v2 条目。 |
| 新 Python + 新 recorder | 支持 v2，获准的 `capture/start` 可冷启动。 | 双语言序号、相同时间多进程、跨会话隔离、锁竞争、各原子写窗口崩溃、恢复幂等、无 attention 自愈、真实宿主完整链路。 |
| 新旧 daemon 可能同时存在 | 先回退或等受控交接；不并发消费同一工作区。v2 字节对旧 walker 不可见。 | 启动真实的旧 `serve`，手动 `recover` 和增量扫描均不触碰 v2 sentinel 条目；旧进程已接管时不向 v2 写，交接后新程序能消费遗留条目一次。 |

额外必须测试：禁用或无效配置、假授权、错误工作区与宿主身份、路径逃逸与符号链接、未知 schema/kind、提交钩子指纹变化、作用域恢复与不完整扫描计数。旧进程实测不扫描新目录之前，不宣称混版本安全，不冻结正式契约。

## 7. 已知风险（0.2.92 隔离实测）

| 写到旧路径的内容 | 实际结果 |
| --- | --- |
| 有配置，条目显式写 `schemaVersion: 2` | 原条目移入 `inbox-failed`，但旧 `recover` 返回全 0。 |
| 有配置，伪装 v1、`kind` 未知，其余是旧版可识别的 `SessionEnd` 形状 | 落入普通 hook 分支，条目被删除，没有建立采集或隔离记录。 |
| 无配置 | `recover` 返回全 0，队列文件原地未读。 |

v2 必须使用旧 walker 不扫描的新目录，且失败和滞留必须可见。“旧 recover 返回 0”不是队列已清空的证据。本草案没有对候选 v2 模块执行混版本测试，因为它尚未实现。
