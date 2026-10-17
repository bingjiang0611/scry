# 2026-10-17 Pi 只读能力探测：去掉无必要的 EOF 宽限等待

## 结论与边界

第三个爬坡实验：在四类只读响应全部收齐后，立即请求探测子进程TERM，仍等待确认退出后才返回结果。对**EOF后仍有空闲句柄**的固定负载，L1和mac2 L2成立。

这不是常驻服务交付，也不证明真实12秒目录等待已解决。对于原本EOF即快速退出的CLI可能几乎没有收益；有复杂TERM处理器的真实CLI仍需单独验收。不修改运行/fork关闭路径、超时数值、trust、模型/权限选择或capability刷新语义。

## 发散与收敛：十个视角

|视角|方向|结论|
|---|---|---|
|根本不做|已完成只读探测不等待无writer的EOF宽限|本次实验，先计数再改生产|
|只做一次|复用Node版本与重叠capability probe|Node已做；重叠probe原本已有，不重复造缓存|
|提前做|安全runtime预热|先测真实启动占比、资源加载与失效语义，不直接扩池|
|推迟做|返回后再关闭子进程|否决：不能让未确认退出冒充完成，不能把成本移出计数窗口|
|换地方做|把等待挪worker|否决为本次优化：不减少等待且可能只隐藏计数|
|更便宜|对已完成offline/no-session读发TERM并确认退出|复用现有terminate/close，不新建生命周期层|
|少做几次|合并四类目录请求或分离按需请求|需先测真实响应成本；当前保留4类完整证据|
|先显示|带时间的缓存目录先显示|未实施；需要展示/失效合同，不能把陈旧选项当当前runtime|
|数据结构|revisioned capability snapshot|尚无稳定native reload证据，不新增第二事实源|
|换架构|常驻provider-specific capability actor|真实启动/配置加载主导时再决策，本次不以模拟数据证明它必要|

选中此项因为源码有明确750ms等待，离线夹具可通过真实子进程和空闲handle复现；不需要调用真实模型或放宽安全边界。

## 冻结负载、提交与测量

- 测量先单独提交：`1456e3580a907b4eb8dd36270b10c3a93c5ede65`。
- 生产优化：`afd8f033b72b162e88d1d5291877707526c3dfe8`。
- collector：`scripts/performance-counters/pi-probe.counters.test.ts`；从既有lifecycle测试提取共享`pi-rpc.fixture.ts`，原22个生命周期测试不删断言。
- 固定负载：offline/no-session RPC、一个真实本地Node子进程、4类请求、EOF后有一个真实空闲TCP server handle。无sleep模拟延迟；等待来自生产关闭实现。每侧5个独立fixture。
- profile显式固定测试Node/HOME，不运行开发机login shell或真实Provider。阶段环境时间不代表真实自动Node发现成本；后者已由独立Node环境指标测量。
- 被动观察spawn、4类stdout响应、close和750ms关闭timer到期。计数与计时覆盖到probe Promise返回，不把关闭移到返回后。
- 校验四类原始响应、请求数、offline/no-session参数、TERM cleanup receipt及PID已不存在；不可通过丢数据或提前返回变快。

## mac2 L2：独立阶段中位数

Apple M1 / 8核，Darwin25.3.0、Node24.18.0、Vitest3.2.7。同机、同lockfile、同fixture、同collector与依赖树，锁内baseline→candidate顺序运行。每侧5样本，不称统计显著性或日常p95。

|阶段/指标|基线|优化|
|---|---:|---:|
|环境准备（固定测试Node）|0.14 ms|0.05 ms|
|spawn到第一个响应|869.45 ms|867.16 ms|
|四类响应的到达跨度|0.60 ms|0.67 ms|
|最后响应到确认子进程close|761.07 ms|2.26 ms|
|probe总耗时|1630.84 ms|870.19 ms|
|关闭宽限timer到期次数|1,1,1,1,1|0,0,0,0,0|
|RPC子进程数|1,1,1,1,1|1,1,1,1,1|
|响应数|4,4,4,4,4|4,4,4,4,4|

总耗时中位数减少约46.6%，约760.65ms。各阶段为独立中位数，不保证逐项严格相加。四个响应的独立到达时间和所有原始样本见[JSON证据](20261017-pi-probe-close.json)。

`SCRY_TIMING_RUN`：8核，负载2.24→2.13，highLoad=false，exit=0，wallMs=19928。第一轮配对成功，没有筛除或重跑样本。

**工作去了哪里**：一次没有必要的EOF等待被真正删除，不是后台执行、少读一个目录或缩短超时。首响应启动阶段约0.87秒基本未变，不能把总耗时下降归因为启动优化。

## 正确性、失败记录与验证

- `withPiRpc`仍await close。只有成功完成所有只读查询的probe提前请求TERM；失败probe、运行与fork保留原有关闭路径。
- 新回归：TERM被忽略时继续持有进程，确认对该pid发TERM/KILL、四个响应完整且pid已不存在后才返回。既有workspace/profile隔离、fresh refresh、初始化早停、坏wire、持久化边界等测试保留。
- 本机focused28测试通过；typecheck/build通过。全量33个计数obs：1 better、30 unchanged、2 gating pass、3 macOS CPU指令candidate缺失，无worse。
- **本机首轮全量并非通过**：3263断言通过、4 opt-in跳过，但Vitest worker报`onTaskUpdate`通信超时，exit=1。调查时主机load约15.23/10核；未证明根因，也不把它擅自标成既有失败，原日志保留。若需要本机全量绿，后续由agent在低负载复核框架通信问题，不加超时或skip。
- **mac2首轮全量2失败**：归档快照仅git init、没有HEAD，导致依赖git HEAD的performance-measure集成测试失败；Node元数据失效测试5秒超时，其fixture复制/首次启动完整Node，但断言只需替换文件身份与响应协议。
- 纠正验证现场：在隔离快照中建立本地commit供集成测试使用（不push、不接触现有项目）；元数据fixture保留真实Node用于首次并发/缓存检查，替换部分使用受控小脚本和真实文件stat/utimes。保留全部路径/计数/失效断言，不加timeout、不删断言、不skip，未改任何performance workload。
- **mac2最终全量3263 passed / 4原有opt-in skipped / 0 failed**。最终三个生产/测试文件SHA-256逐一与本机待提交文件核对一致；fixture/collector在两侧保持相同。没有把mac2通过冒充本机全量通过。
- `performance:propose`仅将新candidate的grace-expiries基线1→0，guard通过；既有Git gating8/11不变，不升级门禁。

## 来源、限制与下一步

基线为冻结测量提交；mac2候选先用该快照+冻结patch`ccab9ed9...`构建，最后只有上述元数据unit fixture作了修正，未改变被测producer/collector/RPC fixture或测量数据。最终生产文件哈希与`afd8f03`相同，完整身份/原始样本/验证摘要见JSON。

原始归档SHA-256：`21fe82cd7a2137eca3f772ff3155f2a8b329858c15e3171c48aae66a77668239`，本机/远端一致。本机现场在`/tmp/scry-rpc-profile-results/`；传回核验后清理mac2新建的`/tmp/scry-rpc-profile.ZZ00nQ`。没有改既有项目、真实记录、App、采集格式或保留策略。

未运行真实Provider/真实App交互/L3，不把空闲句柄case外推到所有CLI；真实12秒等待的启动/模型目录/扩展成本仍需后续授权场景验证。本次会话已完成三个优化实验，按skill收尾。下一轮由agent先为方案二的turn+session共享after-tree补真实finalization计数和固定大仓库负载，再验证语义/性能；不直接删除双重revision保护或提前提交recorder。
