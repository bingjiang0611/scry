# 2026-10-16 Pi Node 版本探针复用

## 当前交付状态（2026-10-17 集成更新）

- 优化源码 `7ac7fcb` 已随 `89e4465` 合入 main；保留 main 的原生会话 fork 与较完整的旧日志迁移逻辑。
- 验证构建：App **0.2.196**，完整 build ID `1d7585fc0e27063072cc5fc0975b074a3a192800dedb1d68cf4888da9710b2e1`。这是源码/依赖配置指纹，不是安装回执或包二进制哈希。
- 构建验收：unit/shell、CLI、开发构建与隐藏 App/UI 通过；打包运行校验中私有 CLI 收到 SIGKILL，未通过。深度签名校验通过，终止来源未知；用户明确批准只合入源码，不安装、不放宽门禁。
- 安装/生效：本次未安装；宿主实际版本/build、安装/首次生效时间及日常 baseline→candidate 映射仍为 `unknown`，L3 待验证。
- 下文 L2 数据属于原实验源码。集成版仅重验了功能与 L1，没有把旧毫秒样本改标成新构建收益。集成验收与首轮失败见[机会日志](../performance-opportunities.md)。


## 假设与范围

方案一（常驻执行服务）的第一步：只复用已验证的直接 Node runtime 版本，不缓存 Provider 命令、模型、权限、扩展或 trust。重复解析同一环境无需反复启动版本探针。

- 基线与冻结 collector：`cafc418`；生产优化：`7ac7fcb`。
- 固定负载：一个真实 Node 二进制，五次环境解析（包含首次冷查询），五次独立 fixture 重复。
- collector：`scripts/performance-counters/runtime-evidence.counters.test.ts`。
- fixture 只启动本地 Node，不执行真实 Provider。

## 结果

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| `providers.pi-environment/subprocess.node` | 5,5,5,5,5 | 1,1,1,1,1 |
| 配对计时：五次解析 p50 | 606.20 ms | 390.89 ms |

**L1 成立；L2 未验证。** 配对计时经 host-wide timing lock 串行执行，但 `SCRY_TIMING_RUN` 为 `loadBefore=8.66, loadAfter=10.44, cores=10, highLoad=true`，只能写“高负载下测得，不可信”，不能把数字作为收益证明。初次基线同样 highLoad=true（10.04→10.11），单独候选为 false（9.24→9.30），没有可用的双侧低负载比较；不继续重复测量来挑绿结果。

**后续L2补证（2026-10-17）**：用户授权在mac2进行同机固定负载比较，中位批耗时557.70→400.39ms，减少28.2%；8核负载7.95→7.12，highLoad=false，各5个fixture。负载接近阈值，结果只适用于该受控场景，不代表App/真实Provider收益。详见[mac2原始样本与方法](20261017-mac2-runtime-evidence.md)，本日高负载结果不删除，L3仍未验证。

减少的工作：四次版本探针进程真正不再启动；没有延后到首次使用之外，没有把 Provider 启动移到计数外。每次仍异步校验 canonical runtime 的 dev/ino/size/mtimeNs/ctimeNs；完整 sanitized environment 的摘要进入键，不在键中保留明文凭据。

## 边界与失效

- 缓存最多 32 项，FIFO 淘汰；更多环境仍正确，只是重新探测。只有 profile/runtime 数量实测导致频繁淘汰时再测量是否调整，不预留第二套缓存。
- 报告的 `process.execPath` 必须等于 canonical 候选才保留结果；version-manager shim 不保留已结算结果。
- 环境、symlink 目标、runtime 内容元数据或权限变动重新探测；失败/非 Node 响应不缓存。显式 PI_AGENT_NODE/ROTOM_NODE 仍遵循已有覆盖语义。
- 同时查询共享进行中的版本探针；capability probe 的“每次刷新看见新配置”合同不变。
- 这不是进程常驻服务，也不证明 12 秒目录查询已解决。下一步先测 RPC 启动/四类响应/关闭的占比，再决定 capability broker 的生命周期。

## 验证与负对照

- 新失效回归覆盖：并发、暖查询、环境变动、symlink 目标、二进制修改、shim、失败探针和已存在的环境清洗/覆盖语义。
- 保留新测试而临时恢复旧生产实现：`shares direct-runtime probes` 在 `expected 2 to be 1` 处失败；恢复优化后通过。不是 timeout 负对照。
- 初次全量 unit：3259 passed / 1 failed / 4 skipped。失败是旧 PATH fixture 仍返回纯版本字符串，已更新为版本探针的新结构化输出；原选择/覆盖断言未删改。最终全量：3260 passed / 4 skipped。
- 最终 `npm run typecheck`、`npm run build`、`git diff --check` 通过。已有4个 opt-in real/correlation suites 未开启，不执行付费 Provider。
- 全量 `npm run performance:measure`：30 observations；3 better、25 unchanged、2 gating pass、3 CPU-instruction candidate missing（macOS未采集），无 worse。
- 全量之后追加 ratchet/feedback 专项：22 passed / 1 failed。原有 `performance-feedback` 的 rotated-journal 顺序断言遇到同毫秒 archive stamp + 随机后缀排序问题。固定同毫秒并使用逆序唯一后缀可确定性复现；journal/report 源码与基线 `1c3cf63` 的 Git blob 完全相同（journal `577e8de6`、report `1dfcf9fd`）。这是另一个尚未修复的已证实问题，不用重跑绿灯掩盖；诊断测试与首轮日志保留本机结果目录，不修改既有断言或采集格式，下一轮需单独决定是否纳入。
- `performance:propose` 将 candidate 平台基线收紧 5→1；没有升为 gating，没有放宽。

## 可复现命令

```sh
node scripts/performance-counters.mjs collect /tmp/scry-runtime-counters.json runtime-evidence
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs runtime-evidence -- env SCRY_RUNTIME_EVIDENCE_TIMINGS=/tmp/scry-runtime-timings.json npm run test:unit -- scripts/performance-counters/runtime-evidence.counters.test.ts
npm run test:unit -- src/main/providers/pi-environment.test.ts src/main/providers/pi.test.ts
npm run performance:measure -- --out /tmp/scry-runtime-measure
```

本次本机原始结果：`/tmp/scry-perf-runtime-evidence-results/`。不上传。尚未安装、运行真实 App/Provider或收集 L3；需要低负载匹配测量及以后同场景≥30样本、≥2会话验证。
