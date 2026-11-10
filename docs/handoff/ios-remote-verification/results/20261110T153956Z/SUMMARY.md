# iOS remote local verification

Verdict: **fail**

| Rule | Required | Status | Detail |
|---|---|---|---|
| R1-checks | yes | fail | failed: install-mac, netbench-wifi-relay |
| R2-netbench-clean:wifi-auto | yes | pass | failures=0 |
| R2-netbench-clean:wifi-relay | yes | fail | failures=1 |
| R2-netbench-clean:wifi-relay2 | yes | pass | failures=0 |
| R3-transport:wifi-auto | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-relay | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-relay2 | yes | pass | multiplexed, all capabilities |
| R4-relay-only | yes | pass | routes=relay |
| R5-direct | yes | fail | routes=relay advertised=192.168.0.100:47820 openErrors=[{"lane":"control","route":"direct","phase":"upgrade","error":"Connect timeout (900 ms)"},{"lane":"bulk","route":"direct","phase":"upgrade","error":"Connect timeout (900 ms)"}] |
| R5b-no-blocking-unproven-route:wifi-auto | yes | pass | failed direct attempts on the open path=0 |
| R5b-no-blocking-unproven-route:wifi-relay | yes | pass | failed direct attempts on the open path=0 |
| R5b-no-blocking-unproven-route:wifi-relay2 | yes | pass | failed direct attempts on the open path=0 |
| R6-catalog:wifi-auto | yes | pass | confirmed 3/3; full=1293.8ms (28 sessions) refresh median=1331.6ms of 3 |
| R6-catalog:wifi-relay | yes | pass | confirmed 3/3; full=1538.8ms (28 sessions) refresh median=816.6ms of 3 |
| R6-catalog:wifi-relay2 | yes | pass | confirmed 3/3; full=720.7ms (28 sessions) refresh median=715.7ms of 3 |
| R7-offline-fast | yes | fail | samples=3 timed=3 allHostOffline=true slowestMs=3277.6 sample={"error":"Mac 当前不在线（中继未看到它的连接）：可能已休眠、断网或 Scry 未运行。唤醒 Mac 后会自动重连。","event":"offline-probe","hostOffline":true,"label":"wifi-auto","ms":2354.3} |
| I1-direct-vs-relay | no | info | warm median relay=1435.5ms direct=1121.4ms; cold median relay=2771.3ms auto=3383.3ms |
| I3-relay-path:mac | no | info | colos=ORD,PIT generations=heartbeat-aware median={"dns":2.1,"tcp":7.4,"tls":713,"upgrade":1156.9,"upgradeExcludingWait":1156.9,"close":1157,"total":1157.1} |

| Scenario | Cold median/p90 ms | Warm median/p90 ms | Catalog full→refresh median ms | History ms | Routes | Colos | Phase medians ms |
|---|---|---|---|---|---|---|---|
| wifi-auto | 3383.3/4760 | 1121.4/3377.7 | 1293.8→1331.6 | 11024.3 | relay | ORD,PIT | {"tcpMs":8.741917,"outerTLSMs":978.488916,"upgradeMs":1626.333416,"innerTLSMs":2695.942542,"pingMs":null,"totalMs":2695.95675} |
| wifi-relay | 2771.3/4064.3 | 1435.5/2967.5 | 1538.8→816.6 | 19770.6 | relay | ORD,PIT | {"tcpMs":8.717417,"outerTLSMs":634.662584,"upgradeMs":1833.571958,"innerTLSMs":2761.60925,"pingMs":null,"totalMs":2761.619208} |
| wifi-relay2 | 1802.9/2565 | 1024.1/1365.2 | 720.7→715.7 | 10807 | relay | ORD,PIT | {"tcpMs":8.897583,"outerTLSMs":420.866834,"upgradeMs":1097.050209,"innerTLSMs":1759.982042,"pingMs":null,"totalMs":1759.994167} |
