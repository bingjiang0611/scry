# 日常记录分析

日常记录是 packaged App 在真实使用中写入的性能日志，位于 `~/Library/Application Support/scry/performance/`：当前文件 `performance-0.jsonl` 加 gzip 归档 `performance-<UTC>-<随机>.jsonl.gz`，归档总上限 64 MiB（按 2026-10-16 的记录速度约可保留 340 小时使用）。旧版 App 只保留约 20 MB（约 5 小时）；新版安装前的数据仍按旧方式轮转。

需要长期趋势时，把快照归档到 `~/scry-performance-archive/`（本机，不进仓库、不上传）。

## 先确认构建身份与优化是否生效

先读已有实验的交付状态，不把“源码已优化”“已构建”“已安装”和“实际运行”视为同一件事。

- App 版本号用于展示；完整 build ID 才是日志分组身份。相同版本号可能对应不同源码构建，Git commit 也不等于 build ID。
- 用安装回执、构建的源码/产物 manifest，以及该 App 启动后的 packaged 日志核对 `优化 commit → 构建 → 安装/实际运行 build`。当前 checkout、分支 HEAD、日志文件名或最新时间戳都不能单独证明这条映射；有 WIP 的构建须保留差异身份。
- 记录 App 版本、完整 build ID、安装时间与首次确认运行的时间/证据。缺失写 `unknown`，未安装明确写“未安装”；指出需核对的来源，不得为补字段擅自安装、运行真实探针或改动日常日志。
- 不改日志格式，不清空旧日志。复用原实验记录及机会日志；旧记录缺部署字段时不猜测，先按 `unknown` 处理。

| 情况 | 本轮如何使用日志 |
|---|---|
| 尚未确认当前运行 build，或 build→优化 commit 的映射不明 | 标 `unknown`；可保留按 build 的历史线索，但不能称为当前优化后的效果或当前热点排名 |
| 已知日志 build 不含某优化，而该优化已通过 L1/L2、尚待部署 | 对应热点标“待部署/生效复验”；不凭旧日志重复实现同一优化，也不判优化回归；独立的新假设仍可按爬坡流程验证 |
| 新 build 的同场景样本不足 | 标“证据不足”；新版观测只能作线索，不混入旧 build 补样本，不以缺样本记 0 |
| 已确认运行 build 包含优化，且同场景两侧各 ≥30 样本、≥2 会话 | 按 Provider、环境与 workload 匹配，并检查记录完整性后才做 L3 对比；不能只凭新 build 仍有慢点就判旧优化失败 |

当前慢点表只用已确认运行的 packaged build。旧 build 的表单独标“历史对照”，不得挤入当前优先级。同一 build 的不同模式、环境和 workload 也不混合；只采用 packaged 分组，不把开发/fixture 记录当日常数据。

## 步骤

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
DAY=$(date +%Y%m%d-%H%M)
ARCHIVE="$HOME/scry-performance-archive/$DAY"   # 本机归档，不进仓库，不上传
node scripts/performance-report.mjs snapshot "$HOME/Library/Application Support/scry/performance" "$ARCHIVE"
```

列出 build、模式与记录数（同时读取 `.jsonl` 和 `.jsonl.gz`）：

```bash
node --input-type=module -e "import('./scripts/performance-report.mjs').then(async m=>{const {records}=await m.readRecords(process.argv[1]);const c=new Map();for(const r of records){const k=r.build+' '+r.mode;c.set(k,(c.get(k)||0)+1)};console.log([...c])})" "$ARCHIVE"
```

核对以上证据后，明确选择当前 build，生成当前基线和排名。不要默认把快照中所有历史 build 都作为当前热点：

```bash
CURRENT_BUILD='替换为已确认运行的完整packaged-build-ID'
node scripts/performance-report.mjs baseline "$ARCHIVE" "$CURRENT_BUILD" "$ARCHIVE/current-baseline.json"
node .agents/skills/scry-performance-climb/scripts/journal-hotspots.mjs "$ARCHIVE/current-baseline.json"
```

需要历史对照时，另给旧 build 生成单独命名的基线并单独展示，不复用 `current-baseline.json`。两个 build 的发布后验收必须显式指定 baseline/candidate，确认候选 build 包含对应优化：

```bash
npm run performance:report -- "$ARCHIVE" <旧build完整ID> <新build完整ID>
```

`current-baseline.json` 只代表本次快照选定的构建。下次开始必须重新核对运行 build 与交付状态，不能仅复用该文件名或上次排名。

## 读结果时必须考虑

| 问题 | 怎么处理 |
|---|---|
| Σp50（p50 × 次数）大，但操作在后台 | 后台操作不直接让用户等，降低优先级；但会抢 CPU、拖慢事件循环，看 `eventLoopMaxMs` |
| `agent.first_text` 的 `durationMs` 很大 | 主要是模型耗时，不是 Scry 代码；但它的 `stage.*`（git 基线、进程启动、run 注册）是 Scry 工作，要单独看 |
| provider/workload 显示 `unmeasured` | 该 IPC 没有记录工作量维度，无法区分大仓库和小仓库；这是可补的观测缺口 |
| maturity 含 `single-session`、`short-recording` | 只是线索，不能当作结论或发布对比 |
| 机器负载 | 日志**不记录系统负载**，而这台机器常在 18–90。毫秒数偏高可能是负载造成的；用受控基准（经 `timing-run.mjs`）复现后再下结论 |
| 只有一个用户、一台机器、主要是 Pi | 不代表其他 Provider（尤其主路径 Claude）和其他用户 |
| 未观测的路径 | 输出 `unobserved paths`。没观测到不等于不慢，列为盲区 |
| p95/p50 大 | 长尾通常来自资源争用、锁、冷缓存、大输入；值得单独查 |

## 交付

报告开头写明选定的完整 build ID、App 版本、实际运行证据、样本时间窗，以及相关优化的合入/构建/安装状态；不明项写 `unknown`。历史对照另列 build 和时间窗，不隐去版本差异。

慢点表每行写：路径、操作、指标、p50/p95、样本数与会话数、是否阻塞用户、归属（Scry/Provider）、已有计数或基准覆盖（有/无）、相关优化是待部署还是已生效、与上次快照的趋势（若有归档）。最后列数据局限和盲区。
