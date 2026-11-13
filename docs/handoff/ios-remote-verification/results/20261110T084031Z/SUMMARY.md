# iOS remote local verification

Verdict: **incomplete**

| Rule | Required | Status | Detail |
|---|---|---|---|
| R1-checks | yes | pass | no failure introduced by this branch; known-baseline: ios-checks (logs/control-base-ios-checks.tail.txt) (fails on the base too, not a pass) |
| R2-netbench-clean:wifi-auto | yes | pass | failures=0 |
| R2-netbench-clean:wifi-relay | yes | pass | failures=0 |
| R3-transport:wifi-auto | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-relay | yes | pass | multiplexed, all capabilities |
| R4-relay-only | yes | pass | routes=relay |
| R5-direct | yes | blocked | the Mac advertised no LAN/overlay address: it is not on a local network the phone can share (check the LAN listener with lsof before accepting this) |
| R5b-no-blocking-unproven-route:wifi-auto | yes | pass | failed direct attempts on the open path=0 |
| R5b-no-blocking-unproven-route:wifi-relay | yes | pass | failed direct attempts on the open path=0 |
| R6-catalog:wifi-auto | yes | pass | confirmed 3/3; full=1232.8ms (33 sessions) refresh median=818ms of 3 |
| R6-catalog:wifi-relay | yes | pass | confirmed 3/3; full=592.9ms (33 sessions) refresh median=634.9ms of 3 |
| R7-offline-fast | yes | pass | samples=2 timed=2 allHostOffline=true slowestMs=1855.4 sample={"error":"Mac 当前不在线（中继未看到它的连接）：可能已休眠、断网或 Scry 未运行。唤醒 Mac 后会自动重连。","event":"offline-probe","hostOffline":true,"label":"wifi-auto","ms":1855.4} |
| I1-direct-vs-relay | no | info | warm median relay=1095ms direct=923.3ms; cold median relay=1716.6ms auto=1958.4ms |
| I3-relay-path:mac | no | info | colos=PIT,EWR,ORD generations=heartbeat-aware median={"dns":1.9,"tcp":5.7,"tls":536.2,"upgrade":941.7,"upgradeExcludingWait":941.7,"close":941.8,"total":941.9} |

| Scenario | Cold median/p90 ms | Warm median/p90 ms | Catalog full→refresh median ms | History ms | Routes | Colos | Phase medians ms |
|---|---|---|---|---|---|---|---|
| wifi-auto | 1958.4/3747.5 | 923.3/1334.6 | 1232.8→818 | 4475 | relay | PIT,EWR | {"tcpMs":8.046417,"outerTLSMs":615.431,"upgradeMs":1018.076959,"innerTLSMs":1937.390625,"pingMs":null,"totalMs":1937.403041} |
| wifi-relay | 1716.6/3060.4 | 1095/1437.2 | 592.9→634.9 | 2595 | relay | PIT,EWR | {"tcpMs":8.42325,"outerTLSMs":675.19175,"upgradeMs":1085.343917,"innerTLSMs":1711.337,"pingMs":null,"totalMs":1711.351834} |
