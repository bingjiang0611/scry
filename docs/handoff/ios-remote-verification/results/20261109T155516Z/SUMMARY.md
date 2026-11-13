# iOS remote local verification

Verdict: **fail**

| Rule | Required | Status | Detail |
|---|---|---|---|
| R1-checks | yes | fail | failed: ios-checks, install-mac |
| R2-netbench-clean:diag-order | yes | pass | failures=0 |
| R2-netbench-clean:wifi-auto | yes | pass | failures=0 |
| R2-netbench-clean:wifi-relay | yes | pass | failures=0 |
| R3-transport:diag-order | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-auto | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-relay | yes | pass | multiplexed, all capabilities |
| R4-relay-only | yes | pass | routes=relay |
| R5-direct | yes | fail | routes=relay advertised=172.18.0.1:47820,192.168.255.254:47820 openErrors=[{"lane":"bulk","route":"direct","error":"Connect timeout (900 ms)"},{"lane":"bulk","route":"direct","error":"Connect timeout (900 ms)"},{"lane":"control","route":"direct","error":"Connect timeout (900 ms)"}] |
| R6-catalog:diag-order | yes | pass | full=561.4ms (31 sessions) refresh=618ms |
| R6-catalog:wifi-auto | yes | fail | full=612.7ms (31 sessions) refresh=819.8ms |
| R6-catalog:wifi-relay | yes | fail | full=592.1ms (31 sessions) refresh=1666.7ms |
| R7-offline-fast | yes | blocked | scenario host-quit not run |
| I1-direct-vs-relay | no | info | warm median relay=623.5ms direct=663.6ms; cold median relay=1337.1ms auto=1337.5ms |
| I3-relay-path:mac-after-deploy | no | info | colos=PIT,ORD generations=heartbeat-aware median={"dns":2.8,"tcp":6,"tls":374.1,"upgrade":1564,"upgradeExcludingWait":964,"close":1564,"total":1564.1} |
| I3-relay-path:mac | no | info | colos=ORD,PIT generations=pre-heartbeat median={"dns":2,"tcp":5,"tls":361.1,"upgrade":853.6,"upgradeExcludingWait":null,"close":853.7,"total":853.8} |

| Scenario | Cold median/p90 ms | Warm median/p90 ms | Catalog full→refresh ms | History ms | Routes | Colos | Phase medians ms |
|---|---|---|---|---|---|---|---|
| diag-order | 3720.3/3720.3 | 695/930 | 561.4→618 | 1601.8 | relay | PIT,ORD | {"tcpMs":136.79125,"outerTLSMs":814.929625,"upgradeMs":1134.799834,"innerTLSMs":1879.958083,"pingMs":null,"totalMs":1879.968833} |
| wifi-auto | 1337.5/3419.9 | 663.6/1017.2 | 612.7→819.8 | 1769.8 | relay | PIT,ORD | {"tcpMs":7.840833,"outerTLSMs":374.490667,"upgradeMs":777.053708,"innerTLSMs":1308.645125,"pingMs":null,"totalMs":1308.659125} |
| wifi-relay | 1337.1/1677.5 | 623.5/795.9 | 592.1→1666.7 | 1776.5 | relay | PIT,ORD | {"tcpMs":7.38875,"outerTLSMs":388.816167,"upgradeMs":738.206792,"innerTLSMs":1327.889792,"pingMs":null,"totalMs":1327.900542} |
