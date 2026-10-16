# 2026-10-17 mac2：两个首轮优化的 L2 补证

## 结论与范围

用户授权在mac2执行。两个固定生产路径在同机、同Node、同依赖、同workload、串行比较下得到L2改善证据；**不是整个App、12秒目录查询或真实Provider的收益证明**。每侧只有五个fixture样本，不宣称统计显著性或日常p95。

上一轮本机高负载结果全部保留；没有改计时阈值或重试筛样。mac2这一组首次执行通过。

## 环境与冻结身份

- mac2：Apple M1，8核，darwin-arm64，Darwin 25.3.0。
- Node v24.18.0、npm 11.16.0、Vitest 3.2.7。
- 基线：`cafc418ebcb25718ad031b50bbf3ba03d7be9922`（测量已加入、生产优化尚未加入）。
- 候选：`ff5a4fd39ff81bced1372a5a8eb12dc07e7bcd83`。
- 通过git archive复制完整提交快照，不发送dirty工作区、node_modules、真实会话或userData；两份压缩源包的本机/远端SHA-256一致，另从archive元数据核对完整commit ID。
- 两侧共用一个隔离安装的依赖树；`npm ci --ignore-scripts --no-audit --no-fund --prefer-offline`，不运行安装脚本，不安装Scry App或启动真实Provider。
- lockfile、collector、timing runner完全相同，SHA-256见[原始证据](20261017-mac2-runtime-evidence.json)。没有修改测量代码、固定负载或生产代码。

## 方法与结果

通过mac2上的`timing-run.mjs`获取该主机的统一锁，在锁内先baseline、后candidate，分别启动独立Vitest进程。各侧同一固定负载重复五个fixture，保存全部样本及功能断言结果，不丢首样本。

| 固定负载（中位批耗时） | 基线 | 候选 | 减少 |
|---|---:|---:|---:|
| 一个真实Node，五次环境解析，包含首次冷探测 | 557.70 ms | 400.39 ms | 28.2% |
| 10000行暖usage账本，五次performance追加+stats读取 | 26.26 ms | 1.43 ms | 94.6% |

这不是单次查询耗时。五个fixture中的Node探针次数均5→1；账本重读次数均5→0、读取字节均4757290→0。减少的工作分别是四个版本子进程不再启动，以及五次整文件读取/解析不再发生；记录和返回计费内容不减少。

每侧2测试通过，断言生产返回的Node路径、计费聚合、corrupt计数、sourceBytes，以及额外真实子进程的计数敏感性。

`SCRY_TIMING_RUN`：label=`mac2-runtime-evidence`，8核，loadBefore=7.95、loadAfter=7.12、highLoad=false、exit=0、wallMs=12067。**负载通过既有检查，但接近8核阈值，并非完全空闲机器。** 本组是有限的受控场景证据，不外推到所有机器/规模。

## 现场与限制

- 原始归档、校验清单、源commit ID、锁输出、全部样本、counter和两侧测试日志已复制回本机：`/tmp/scry-perf-mac2-results/`。
- 结果归档本机/远端SHA-256均为`8818f75641195fe4a4f4169499ea87c6a14980d4f80e8492daf581a737411dad`。仓库中JSON仅保留离线合成基准数值和环境，不包含会话内容、远程地址或凭据。
- 远端仅使用新建的`/tmp/scry-perf-l2.HUE2Dj`隔离目录；传回证据并校验后清理该目录。npm的普通用户级下载缓存不做全局清理，避免删除其他工作缓存。
- 无remote现有项目改动，无真实`.scry`/transcript/DB写入，无App安装、发布、push或合入main。
- 不将candidate升级gating；尚无L3，需以后安装并同场景≥30样本、≥2会话验证。
- 后续仍是capability RPC分段和共享after-tree实验；本组没有测量它们，不能宣称12秒目录延迟已经解决。
