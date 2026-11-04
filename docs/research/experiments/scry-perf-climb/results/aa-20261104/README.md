# A/A 校准（2026-11-04）

同一台机器、同一份工作区副本，基线和候选都用 `0ae5cf95` 的 recorder 与 `0.2.8` 的 uploader，`--phases recorder,hookwrap --pairs 2 --rounds 7`。

- 机器：Apple M1 / 8 核 / 16 GiB / macOS 26.3.2 / Node v24.18.0 / git 2.50.1
- 工作区：`rn-shell`（1564 个跟踪文件，10 个子仓库），副本在 `~/scry-perf/climb/workload/rn`
- 结论：**NO CLEAR CHANGE** — 变好 0（计数 0，耗时 0），变差 0（未豁免 0），计数不稳定 0，无明确变化 81，测不到 8
- 计数（L1）四次运行完全相同：轮次开始 28 次 git 调用、结束 47 次（脏工作区场景 68 次）
- 记录摘要 `ed4ea3…` 四次相同；`hookwrap` 每轮上传 74/74 条记录

结果文件按 20 KB 单文件门禁压缩存放（原始 JSON 每份 60–81 KB），解压后就是 `perf-bench`/`perf-ab` 的原样输出：

```sh
for f in *.gz; do gunzip -k "$f"; done
node ../../../../scry-rollout-check/perf-ab.mjs --base baseline-2026-11-04T06-07-50-013Z.json baseline-2026-11-04T07-13-38-405Z.json \
  --cand baseline-2026-11-04T06-29-45-902Z.json baseline-2026-11-04T06-51-39-448Z.json \
  --phases recorder,hookwrap --calibration AB-2026-11-04T07-30-40-178Z.json --out .
```

| 文件 | 内容 |
| --- | --- |
| `AB-2026-11-04T07-30-40-178Z.md.gz` / `.json.gz` | `perf-ab` 的判定与逐项对比 |
| `BASELINE-2026-11-04.md.gz` / `.json.gz` | 四次运行用 `perf-compare` 合成的基线；后续 A/B 用 `AB-*.json` 作 `--calibration` |
| `baseline-*.json.gz` | 四次原始运行 |

两点说明：

- 本轮 A/A 之前修掉了两个测量缺陷（见 `fix(perf-bench): keep the copy intact and reach the fake transport from the uploader`）：`hookwrap` 阶段恢复副本时受只读目录影响会留下 985 个跟踪文件缺失，让后续每次运行都在不同的工作区上测量；uploader worker 收不到假传输层设置，导致所有上传在身份阶段失败（0/26）。修好后同一份 A/A 两次同侧运行的计数与摘要才一致。
- 报告里原先记为 `confirmed via <传输变量名>`，那会把真实变量名带进公开结果。该字段不是指标，已改为 `confirmed`，并在 harness 里只打印到控制台（单独提交）；本目录的 `fakeTransport` 已按此整理。
