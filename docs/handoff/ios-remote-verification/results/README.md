# 本机验证结果索引

每个目录是一轮 macOS 宿主与 iPhone 13 的验证（L2：只代表当时的机器、网络和负载）。这些是历史记录，**不是当前版本的验收证据**。

| 轮次 | 证据 | 判定与边界 |
|---|---|---|
| 1 | [报告](20261109T155516Z/REPORT.md) · [原阅读版](20261109T155516Z/SUMMARY.md) | fail。发现 VPN/隧道地址被广播、未确认的直连阻塞打开，以及旧阶段判定的问题。随后要求基线豁免必须有对照日志，并新增 R5b 检查打开路径不被失败的直连拖住。 |
| 2 | [报告](20261110T033802Z/REPORT.md) · [规则判定](20261110T033802Z/acceptance.json) · [场景统计](20261110T033802Z/summary.json) | fail。广播与打开路径问题已修。R5 因不在同一 Wi-Fi 阻塞；唯一失败的必需项 R7 为离线答复 2.77–3.48 s，超过 3 s；门限未放宽。 |
| 3 | [报告](20261110T084031Z/REPORT.md) · [规则判定](20261110T084031Z/acceptance.json) · [场景统计](20261110T084031Z/summary.json) | incomplete。relay 宽限改为有近期 host 活动时才等待，手机收到首条 lane 的离线答复即可返回；R7 实测 1.37–1.86 s。R1 有基线对照并获豁免；R5 因网络前提阻塞。冷开失败由维护者决定只记录，不计入本轮通过判定。 |
| 4 | [报告](20261110T153956Z/REPORT.md) · [规则判定](20261110T153956Z/acceptance.json) · [场景统计](20261110T153956Z/summary.json) | fail（历史最后一轮）。同一 Wi-Fi 下手机能学到 Mac 局域网地址，但直连仍超时；R2 冷开卡顿复现，失败记录在 TCP 阶段完成之前停止；R7 有一个样本 3.28 s；`install-mac` 因机器过载中断。维护者决定不执行第五轮，带遗留风险合并，见 [TASK.md](../TASK.md) 的第四轮结论。 |

第一轮保留原 `SUMMARY.md`，因为旧格式的 catalog 刷新值不能由现有脚本从 JSON 原样重建；第二至第四轮以已提交的 JSON 为准。

## 第三轮冷开失败的归因更正

重跑通过不能抹去前两次 `wifi-relay` 冷开失败。第一次有 5/5 失败的原始日志；第二次的次数来自事后记录，未独立核实。`I/O on closed channel` 和约 31.1 s 的总时长不支持「host leg 陈旧」或「内层握手超时」的归因；它们与三次外层建连超时加退避相符，但具体卡点未查明。再次复现时，应保留失败那一次的 `logs/netbench-<场景>.failed-<时间>.tail.txt`，对照 TCP、外层 TLS、WebSocket 升级的分阶段计时。在确认证据前不改超时或重试次数。

过往执行步骤和完整核验意见见 [Git 历史](https://github.com/bingjiang0611/scry/blob/3f4afcab2b2f756aa253b2e6c680d3d483bec55a/docs/handoff/ios-remote-verification/ROUNDS.md)。已提交结果经过 `experiments/remote-g0/verify/redact.mjs` 脱敏；时延和失败证据未改动。
