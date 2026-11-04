# 最终对比（2026-11-04，不可用作结论）

最初基线（`0ae5cf95` + uploader `271ab07`）对最终候选（`38686164` + 同一 uploader），`--phases recorder,hookwrap --pairs 2 --rounds 7`，A/A 校准 `../aa-20261104/AB-2026-11-04T07-30-40-178Z.json`。

```sh
for f in *.gz; do gunzip -k "$f"; done
node ../../../../scry-rollout-check/perf-ab.mjs \
  --base baseline-2026-11-04T13-16-39-929Z.json baseline-2026-11-04T15-50-42-278Z.json \
  --cand baseline-2026-11-04T13-54-54-633Z.json baseline-2026-11-04T14-31-48-679Z.json \
  --phases recorder,hookwrap --calibration ../aa-20261104/AB-2026-11-04T07-30-40-178Z.json --out .
```

`perf-ab` 的输出是 **REGRESSION**：变好 32（计数 30，耗时 0），变差 2（未豁免 2），计数不稳定 2，无明确变化 77，相同 37，测不到 8。

## 这次会话为什么不能当结论

| 现象 | 数字 | 说明 |
| --- | --- | --- |
| 变差项都在轮次开始 | `recorder / daemon fast path / clean, 5 tools / turnStart` 1198.2 → 1530.9 ms；同场景脏工作区 1176.5 → 1513.1 ms | 本轮改动只碰轮次**结束**的候选发现，不可能让开始变慢 |
| 同侧运行自身跨度大于差值 | `turnStart`（5 tools）四次分别是 1440.7 / 955.7（基线）与 1546.2 / 1515.6（候选） | 基线两次相差 485 ms，任何 2v2 比较都会被顺序和噪声决定 |
| 会话被负载门槛打断 | 最后一次运行 `base 2` 先等了两轮（load 9.31、9.06），第三次检查仍 4.56 ≥ 4 而中止；该运行随后单独补跑 | 补跑与 `cand 2` 相隔约 80 分钟，中间还有一次负载峰值 |
| `hookwrap` 计数同侧不稳定 | `wrapped / gitCalls.stop` 候选侧 36 与 52 | 包装路径里 uploader 排空带进不同数量的 git 调用，与 recorder 改动无关 |

能确定的部分：计数在四次运行里完全一致——`gitCalls.stop` 47 / 47 → 36 / 36，`gitCalls.total` 75 / 75 → 64 / 64，脏工作区 68 / 68 → 57 / 57、96 / 96 → 85 / 85。

## 结论

这次会话不满足“结论可复核”的条件，需要在一个安静窗口重跑同一组 4 次运行。保留改动的证据以受控会话 `../index-reuse-20261104/` 为准：结论 IMPROVED、变差 0、计数 16 项一致变好、`stop` 1285.3 → 1021.9 ms（−20.5%，p ≈ 7e-6）。
