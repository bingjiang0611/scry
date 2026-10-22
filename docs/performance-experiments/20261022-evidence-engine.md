# 2026-10-22 A+B 收口：按需控制与增量证据

## 范围、合同与交付身份

用户要求连续完成 A/B，仅修改 Scry。原工作区的并行 WIP 不混入；不合入 main、不 push、不安装 App/手机、不执行真实或付费 Provider。

- A：按需 metadata/selected 控制层、OpenCode 有界复用、Qoder live 模型与初始化证据寿命。Pi 保持 fresh offline/no-session 探测；没有公开的完整 resident reset 合同，不用旧状态伪装刷新，也不声称全 Provider 统一常驻。
- B：不可变 tree pair 的批量 Git patch；Pi 原生身份索引先选页再读正文；Scry 归档基表＋单轮 metadata delta；managed journal 的不可变 v1 intent＋小型 phase sidecar。
- recorder 仍等待证据收敛；`.scry/records` 一轮一文件及其权威性不变。缓存不是事实源。sandbox、trust/fingerprint、Provider operation gate 和 renderer 权限边界不放宽。
- 独立分支：`perf/provider-control-20261021T115356Z`，工作树 `/tmp/scry-provider-control.UGpNzU/source`。
- B 对照源码：`55dacdb14c5ccf5cd539ed00812b37623da7777d`。算法实现到 `f3db73f552566f955d282a3455a3645b9ae89db3`，生产 IPC observer 为 `f35a72d`；文案常量归并后的最终受检代码为 `4d561ddbaa3ece4345776b4d7277f3d3628e00af`。最后一次变动只迁移原有错误文案；本记录仍重新执行完整验证及低负载生产 IPC，不把旧构建结果直接当作新构建。
- 测量代码独立提交：`04391f0`、`5d0a7c4`、`743bb3a`、`f35a72d`。同一 observer 分别调用基线/候选生产实现，没有缩小固定负载或放宽生产/测试期限。

## 实现与减少的工作

| 路径 | 实现 | 工作去了哪里 |
| --- | --- | --- |
| Git | 每批至多 128 文件、64 KiB 编码 pathspec；`--raw -z --patch --output`；raw 路径为归属权威，hunk 计数分帧 | 多次启动合并；仍比较原 tree pair、保留 numstat、binary/policy/deadline/completePatches 语义 |
| Git 完整性 | 强制完整 glob 匹配，避免 deleted `a` 选中 `a/private.env`；固定 framing；每次独立输出并及时删除；失败时只保留被后续 header 证明完成的前缀 | 不用截断 stdout 或旧 preview 冒充完整 patch；17 MiB UTF-8 patch 与 native Git 全字节 oracle 相等 |
| Pi 历史 | 有界 entry/offset 索引，原生 parent ancestry 与归档身份对账后选页；选中 entry 才构建正文 | 不再每次 hydrate 整段 ancestry；不按相同 prompt 去重；append 仍校验旧前缀，重写/截断/替换使旧快照失效 |
| 归档 | 冷源建立一个 v2 基表；每次写入只发布 canonical body 和单轮 delta；读时以 32 并发核对 canonical 文件成员/指纹并合并变更；已解析基表缓存最多两份 | 不再每轮重写增长索引；没有把延后工作排除：harness 另测 insert 后读取。sidecar-only 会话首次读发布一次基表，后续不重开全部 sidecar |
| journal | full v1 intent 只写一次，recordId/phase 原子写小 sidecar；缺失/损坏 sidecar 回退完整 intent | 不再把同一大 request 重写三次。可解析、可归属但结构无效的 intent 保留身份并报告 pending，不再被归一化为不存在 |
| 页面诚实性 | 新旧页都按选中的 run ID 读取归档正文/附件；来源不完整与 hasOlder 分离；翻页源变化拒绝旧游标；初始 Native 失败切换到真正归档页及对应 cache/cursor | 不显示 metadata marker 冒充正文；不造 offset=0 仍可加载更早的状态；cache/prepend 不把 partial 变 complete |

metadata 放在 `userData/trace-archive-metadata-v1`，不能放进 canonical 目录。否则维护缓存会改变远程事实源版本。删除会话同时清理 metadata 与其临时文件。基表沿用 32 MiB/100000 entries 上限；更大规模需另行验证持久分页结构，不扩大本轮额度。

## L1：相同负载、实际 I/O/进程计数

完整 helper 负载：Git 4/100/1000 文件；Pi 40/400/4000 轮，最新/旧页各 40；归档 40/400/4000 既有轮次的一次插入＋相同内容重试＋插入后读；256 KiB prompt 的真实 managed commit。字节来自透明文件系统计数，不是预计值。三对完整 helper 的 L1 来源为 f3db73f；后续仅 observer 和文案常量迁移，不改成功路径的 Git/归档/Native 算法。`physicalBytes` 是 FileHandle 返回的字节，包含 OS page cache，不代表物理磁盘吞吐。

| 固定路径 | 基线 → 候选 | 证据边界 |
| --- | --- | --- |
| 4 文件 finish 的 Git 启动 | 13 → 10；patch 子进程 4 → 1 | 固定输入，所有 patch 完整 |
| 1000 文件 patch 完整率 | 中位 53/1000 → 1000/1000；候选 8 批 | 原 2 秒 patch budget 不变。旧实现因 deadline 没有完成 1000 次调用，不能写成“实测 1000→8” |
| Pi 4000 轮 unchanged warm | 21517508 → 215440 读取字节；24001 → 240 次 JSON.parse | 36 组阶段/规模配对的选中 ID 和正文 SHA-256 相等。append 仍读旧前缀，不宣称所有读取 O(page) |
| 4000 轮归档插入＋同内容重试 | 约 981132 → 796 写入字节 | 包含 canonical/index/metadata/catalog 的实际写入；cold 基表只发布一份，insert 后读另计 |
| 大 journal | 3 → 1 次完整 intent 写入；约 1581998 → 527299 字节 | 另有两份小 phase sidecar；canonical record 的完整 prompt 从磁盘核对，不是只查 open/progress |

新归档正文读取的稳定阶段仍做 O(history metadata) 的指纹核对；正文 hydrate 有页界。Claude/Qoder 原生全源解析未被包装成真正分页。legacy monolith、坏索引或无 metadata 的冷源仍可能完整扫描，不能拿暖路径代替这部分成本。混合 legacy/损坏来源保持 partial；不能凭缓存恢复已经缺失的正文或消除旧会话的历史歧义。

## L2：隔离 Electron App 的完整生产 IPC

mac2：macOS 26.3.2、8 核、Node 24.18.0、Electron 42.10.1。全部使用临时 workspace/HOME/userData，不执行 Provider。baseline 55dacdb 只覆盖相同 observer，`src/` 未改；各自构建后执行：

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <label> -- \
  node scripts/electron-security-smoke.mjs --dev-pi-history-perf-only
```

负载是 4000 canonical 轮次、4001 native 轮次，模型文本约 2 KiB/轮；每个 sample 调用生产 preload/Main 的 `loadSession` 与 `loadSessionOlder`，各返回 40 轮。所有 sample 的 80 轮正文 SHA-256 均为 `25d8bb02aa4ddc60fa089b88568f1424ff55344688ba5753791d8e30d1ea73f5`。

| 生产 IPC（ms） | 基线 | 候选 |
| --- | ---: | ---: |
| bulk append 后第一次打开＋旧页 | 1708.1 | 1002.7 |
| unchanged warm 最新页，中位（3 次） | 957.5 | 118.2 |
| unchanged warm 旧页，中位（3 次） | 0.8 | 39.0 |
| unchanged warm 两页合计，中位（3 次） | 958.1 | 154.6 |

最终 baseline 锁记录 load2.44→3.03/8 核；candidate 3.03→3.03/8 核，均 `highLoad=false`。此前 f35a72d 的有效复核为 937.3→166.3ms，原日志也保留；不挑选其中更快的一侧混用。第一读是应用缓存冷/批量 append 后的读取，不是清空 OS page cache。每侧一个隔离 App、三个暖样本，不推导 p95、屏幕绘制、真实账号或 L3。

**单独旧页确实更慢**：原路径已提前把整份正文放进 cache；新路径现场读取选中正文并核对来源。保留这个必要成本，不用总耗时下降掩盖它。完整两页链路减少约 84%，不再为每次打开 hydrate、保留整份历史正文；metadata 索引仍随历史规模增长且有上限。这里不是实际 RSS 测量。

独立 helper 的最终三对完整运行虽全部通过，但 load6.14→8.35/8 核、`highLoad=true`，不采信其毫秒收益。L1 计数/内容核验仍保留；上表来自后续独立、低负载且受锁的生产 IPC，不靠高负载数字宣称成功。

## 每项 worse 与失败保留

- 首版 metadata 逐文件重读在 4000 轮 insert 后读约 491 ms，不能接受。随后改成基表＋delta、并发指纹核对、缓存已解析基表，去掉冷重建的 N 次 sidecar 发布。没有删完整性断言来恢复旧的快速但不验证行为。
- `performance:measure --compare 55dacdb --scenario files.fixed-operations` 的 5 轮固定混合负载：read336→417、readdir18→20、读取字节约 1183196→1220678；stat1065→1038、write4→3。额外读取/目录查询与首次按需 metadata 基表构建、来源完整性材料相关；fixture 的 120 次种子写入不计时，旧实现已在那些写入中维护索引，新实现把一次性基表建设放在首次读取中。此成本不移出测量，不能声称每项 I/O 都降低。
- `persistence.archive/ipc.bytes` 10536→10558，多出的 22 字节是 `sourceComplete`，用于区分缺失来源与已经到达第一页。它是必要证据语义，不为省字节删除。
- 首次 mac2 全量 10 失败/3514 通过：metadata 改变 canonical 目录时间戳，触发 remote history snapshot changed。移动到独立目录后，原有远程/TLS/归档 73 项通过；最终全量通过。未放宽 stale snapshot 断言。
- 新的坏 journal scoped-recovery 回归在修复前失败（错误地 pending=0），修复后通过；sidecar-only 首次分页在修复前读全部正文，修复后只取选中页，并证明后续 JSON.parse ≤41。
- IPC fixture 编写时保留三次失败：先错误地按时间戳推断 Native/Archive ordinals，再用了非生产 `response` tool stage，最后误以为附件 DTO 必有 path。按已有原生锚点顺序、`tool_result` 和 dataBase64 合同修正；没有弱化工具/用量/附件正文校验。

## 最终组合验证与产物

| 检查（冻结 4d561dd） | 结果 |
| --- | --- |
| `npm run test:unit` | 3528 pass / 4 既有 opt-in skipped，286 文件通过 |
| `npm run typecheck`、`npm run build`、`npm run build:cli` | 全部通过 |
| `npm run test:renderer:ui` | 全套通过，含 Credits、安全、归属、统一对话及 43 轮 Native/Archive IPC 回归 |
| `npm run test:shell` | 通过 |
| `npm run smoke:cli-package` | 临时 tarball 安装、bin、幂等 init、hook/record、doctor、原生计费解析通过；CLI 0.2.49 |
| `npm run performance:measure` | 43 measured observations，每项 5 次，ratchet passed；4 better / 4 worse / 33 unchanged / 2 gating pass；3 个 CPU instruction candidate 仍 missing，不记 0 |
| 生产 IPC 内容与失效 | 旧页保留实际 tools/usage/attachments；坏来源保持 partial 且 offset0 不显示虚假的 hasOlder；Native 源变更拒绝旧 cursor；重新打开后归档 fallback 的页及 cache 同一坐标 |

测试构建是 App 0.2.216 的开发输出，不是已签名/安装的发行 App；未生成本次 packaged build ID。源与测试构建对应由冻结源码、构建日志及输出 SHA 核对，不把版本号或 HEAD 冒充已部署 build：

- `out/main/index.js`: `63a10f645ced894b03c3bdbe79a7aaef62ad75336f96406ce23ffe9a364366b3`
- `out/preload/index.cjs`: `28247155fe6ca902d022f3a8adb8066c1270515551a271fbb893ac3fe1e27688`
- `out/renderer/index.html`: `819ca96a28dd21f1851b9753f5bedc435dfccd933d0aa8c0b5ccea8a35c21f91`

mac2 证据根 `/Users/test/scry-provider-control-mac2.IEatqT/`：`B-final-unit-v4.log`、`B-final-ui-v4.log`、`B-final-*-v4.log`、`B-final-performance-v4/measure.json`、`B-final-file-comparison/measure.json`、`B-whole-ipc-{baseline,candidate}-v4.log`。初次失败及高负载日志也保留。父任务本机 `/tmp/scry-provider-control.UGpNzU/` 留有汇总和对应原始样本。

`performance:propose` 仅生成四项收紧提议（terminal-pair 的 Git/total 17→13，files stat1065→1038、write4→3），未加 `--write`、未应用；四个 worse 不抬基线。没有修改性能门限/tolerance 或升格 candidate。A 的低负载 OpenCode 复核见[原实验](20261022-opencode-control-lease.md)。

## 生效与剩余边界

- 仅独立分支本地提交。没有合入 main、push、打包安装、重启用户 App、修改 Pi/Rotom 或全局 CLI。CLI 安装仅发生在自动清理的包冒烟临时目录。
- L3 `unavailable`：未部署日常实例，没有每侧 ≥30 样本、≥2 会话。需用户另行授权合入/安装，再以相同场景采样；旧 packaged 日志不能评价本次未部署改动。
- 无真实 Provider/账号/手机验收。Swift XCTest 此前因缺完整 Xcode 未能执行，本轮未补验；既有 TLS leaked-promise 诊断不被桌面测试代替。需要对应授权、设备和环境后，由测试 owner 重放。
- Pi 常驻仍需公开、可验证的完整原生刷新合同；本次宁可新进程，不把 `new_session` 或 prompt 当成进程级 extension/trust cache 重载。Qoder 不扩大原 5 秒空闲/30 秒目录期限。
- 结论只到 Scry 的 L1 与上述受控 L2，不承诺全部 Provider、全部会话规模或每个单独路径单调变快。
