# Recorder fixture完成与清理：并行对照

## 批准范围

维护者批准独立PR修复测试缺陷：等待真实delivery完成；超时/取消先结束并join本fixture创建的子进程及异步测试体，再删除临时目录。不加sleep、不自动重试、不扩大时限，不修改产品实现、持久化合同或权限策略。

## 实现与区分实验

- daemon路径使用现有`await daemon.close()`，它join recovery/delivery；transport ACK、`daemon.closed`或best-effort drain均不是callback完成屏障。非daemon managed路径保留原生产API默认的await delivery合同。
- 输出检查同时核对真实record sequence和持久化`ackedThrough`/`notifyBacklog`，不是只看文件是否存在。
- 新socket门控回归先证明ACK/drain之后仍然ENOENT，再释放callback、等待close；exit 0必须ACK成功，exit 23即使写出文件也必须被拒绝。无计时sleep。
- POSIX fixture使用独立进程组，取消只向本fixture登记的组发信号。join已登记child的close和仍在执行的测试体后，才允许共享workspace清理。重复取消幂等，已取消fixture不能再spawn。
- 真实Node与shell阻塞stdin/子孙进程回归，以及无关进程存活控制，均使用握手而非sleep。

## 本机并行前后对照

基线：`2e10e2f6eb09d647789b47b9dfc196b1ddb62660`。修复在独立worktree，未改全局worker数。各次均为macOS arm64，10逻辑核；仅最终一轮属于最终候选代码，不把中间失败替换为成功。

命令（经仓库timing-run全机锁）：

```sh
npm run test:unit -- src/cli/managed-tool-hooks.test.ts src/core/turn-recorder/commit-environment.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=<evidence.json>
```

| 版本 | 结果 | wrapper墙钟 | load before→after | highLoad |
|---|---|---:|---|---|
| 修复前首轮 | 21/22；1个managed Claude测试超时 | 47032ms | 15.10→16.61 | true |
| 初次修复首轮 | 20/24；4个managed hook超时，部分取消出现kill EPERM | 49671ms | 18.17→14.84 | true |
| 幂等取消版（202a8788） | 24/24 | 44301ms | 10.86→11.90 | true |
| 评审后聚合取消错误版 | 21/24；3个managed hook达5秒时限 | 55653ms | 28.91→24.59 | true |

初次取消实现会在timeout和afterEach路径重复发信号；最终候选用显式幂等状态阻止二次signal，真实回归核对仅一次signal。最终一轮未出现EPERM，但不能仅凭一次通过就断言解释了全部既有EPERM或未来不再超时。环境均高负载，不能把墙钟差当作性能改善或单因素因果证据。

附加检查：`npm run test:unit -- src/cli/fixture-processes.test.ts --maxWorkers=1`，评审修订后4/4通过；`npm run typecheck`通过；`git diff --check`通过。开发中的helper参数化/context及时限失败原日志保留，没有抬时限或跳过断言。

原始日志/JSON留在本机`/tmp/scry-approved-followups/`，对应`delivery-before.*`、`delivery-after.*`、`delivery-after-final.*`、`delivery-final-process-regressions.log`和`delivery-final-typecheck.log`。未上传私人性能记录。

## 评审后的取消失败路径

[PR #66评审](https://github.com/bingjiang0611/scry/pull/66#discussion_r4548522191)确认单个组EPERM会跳过后续组。修订为先尝试所有已登记组，join child及测试体后再抛AggregateError。新回归对第一个组注入EPERM，证明第二个组仍收到信号；第一个组尚未退出时close保持pending，stdin EOF让它真实退出后，错误才汇总返回。只恢复“遇错立即throw”一行的负对照确定失败；恢复修复后4项回归通过。没有把权限错误当成已退出，也不重试信号。

一次新增回归开发轮出现2项失败：旧的双Node启动到5秒时限，前一测试异步finally恢复spy影响后一测试。现在afterEach显式join该回归自己的测试体；保留Node/shell父进程、真实存活子孙、256KiB阻塞stdin和无关进程控制，用POSIX fd3阻塞的shell leaf替代多余的第二次Node启动。没有缩小输入或删除行为断言、扩大时限。

最新两文件并行轮仍有3个5秒超时；commit-environment全部通过，无EPERM/ENOENT/AggregateError清理失败。负载28.91→24.59，不能宣称已解决所有超时或把它直接归因于负载。原始资料增加delivery-after-review.*、delivery-review-typecheck.log、delivery-group-error-joined-regressions.log及delivery-group-error-negative.*。若信号真实被拒绝且进程不退出，清理仍须等待/失败，不删除仍可能使用的目录。

Linux结果在独立PR的CI中单独观察；本机通过不等于Linux验收。修改仅为fixture/test及本文，不产生App/CLI运行产物，因此未构建安装App、未发布CLI。自查确认没有改默认超时、重试、Provider授权、trust/fingerprint或产品delivery实现。
