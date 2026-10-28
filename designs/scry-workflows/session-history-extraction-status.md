# Session history IPC 职责拆分检查点

本次仅拆分现有历史读取路径，不代表 M2 入口或 M1–M6 完成。工作树为 `scry-workflow-m0` / `feat/workflow-m0`，基线 `c9386b60`。保留现有未提交改动；未安装、推送、升版本或访问真实 Provider 账号。

## 实现边界

- `session-history-ipc.ts` 持有 `agent:loadSession` 注册和读取实现；`session-history-older-ipc.ts` 持有 `agent:loadSessionOlder`。
- revision、取消控制器和当前缓存由 `index.ts` 显式持有，两条注册路径接收同一个状态。迁出模块没有可变单例，也没有第二份缓存。
- 现有 App Store、运行登记、userData、shutdown、窗口焦点、项目选择及 selection maps 通过原有实例或 live getter 传入。注册仍使用生产 `handleTrusted`。
- 缓存键和 Hook 页装饰复用同一实现。未改变分页、来源、授权、活动运行等待、缓存失效或可恢复性语义。
- `performance-paths.json` 将迁出的文件归入既有 `history` 路径；没有新增指标、门限或 workload。

当前文件尺寸：`index.ts` 229,879 B，两个新生产模块分别为 14,567 B 和 3,894 B。主文件仍超出 20,000 B 的 authored blob 上限，不能据此暂存整个候选或宣称职责拆分结束。

## 实际验证

证据目录：`/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 结构等价 | 两个 listener、三个 helper 的 AST 在明确的 dependency/state 投影下相同；242 个其余顶层语句相同 | `m2-session-history-equivalence.cjs` / `.json` |
| 类型与 focused 单测 | Node/web 通过；7 文件、126 测试通过 | `m2-session-history-corrected-focused.log` |
| 隔离状态回归 | 实际注册 listener、真实空 App catalog；两个注册实例的 revision、取消与缓存互不污染；空但可用的分页不同于 unavailable | `session-history-ipc.test.ts` |
| 当前构建及生产 App | conversation ownership/unified IPC 与既有 workflow App 验收通过 | `m2-session-history-app-counter.log` |
| 既有计数门禁 | `history.page` 五样本：IPC messages 1、bytes 10020、stringify 1；ratchet 通过 | `m2-session-history-counters/measure.json` |

结构等价不是运行或 trust 证明。新状态测试直接调用生产 listener，不单独证明 sender/frame/origin 校验。生产接线仍使用同一 trusted wrapper，独立 App 验证与代码检查分别记录。

当前构建 main SHA-256：`8d2285161c3459438afdbd2a40460acf40fe42ada04c11df86fc1eebcdbd27d6`。Workflow App 现场为 `scry-workflow-node-stop-app-nZFyol`，unified 现场为 `scry-unified-rendering-NQgmcb`，均位于 macOS 临时目录。后者使用 21 次离线 Provider invocation；前者保留原四次离线调用、native SIGKILL、TAP、frame、policy 和 size 场景。前者三次登记资源 closure 均 tracked 4；这不证明 escaped descendants 或远程效果收敛。没有真实 SDK/账号验收，不据计数声明更快。unified 的临时主进程工作目录未保留；可读现场仅包含验收 JSON 与截图，不声称保留其 DB/Recorder 原始文件。

## 首败与修正

1. Worker 交付未经验证。首次 Node 检查发现残留 `ParsedTurn` 缺少导入，以及复制的 Hook helper 失去 nullable 属性 narrowing。保留 `m2-session-history-first-types.log`。修复导入并复用原 helper，未加入非空断言掩盖类型问题。
2. 源码复核将搬出的模块级可变状态改为显式 App-owned 状态，并删除重复 helper；不改变原来单 App 的状态语义。
3. 首次归档错误要求已不存在的 unified 临时主进程目录仍可复制，因而中止。只在原部分目录继续归档可读证据，记录缺失引用，不重新执行 App 或伪造现场。
4. 新测试错误假定读取失败后立即清除 AbortController。原实现的 finally 只结束性能记录，控制器在下一请求或失效时取消。`m2-session-history-focused.log` 保留 125 通过、1 失败；修正新测试以证明这一既有生命周期，没有改变实现或旧测试预期。

## 未关闭项

- 主文件及其他大文件的职责拆分、完整 TaskSubmission/routing/authoring 仍待实施。
- 本次没有重新运行默认全量 gate。此前默认单测的原 SystemStep 5000 ms 失败，以及 size 扩大验证中的两个 native recovery 5000 ms 失败仍保留；原因和与后续候选的关系尚未证明。没有放宽期限或通过重跑抹去首败。
- 当前场景不覆盖所有真实 Provider 历史格式、真实 SDK 或账号。

前一检查点见 [size guideline](size-guideline-status.md)。新证据只建立后继检查点，不修改旧 archive；checksum 不是签名，复制的合成现场不是可移植或可恢复执行授权。
