# 受控集合与读取权投影

本页从 [program-ir.md](program-ir.md) 按职责拆分；原阶段证据与未完成项保持不变。

## 动态 map 与显式 collect

`map`使用`{kind,blockId,items:expression,item:localName,key:[field,...],maxItems,body}`。maxItems省略时为4096；这是冻结、可见的整批拒绝边界，不是截断条数。Native调用的最坏预算为maxItems×body预算；若过于保守，须在确认前声明真实允许的上限，而非运行时少做部分任务。

- 派发前校验完整逻辑集合、唯一有限标量key以及≤4096/已确认maxItems。重复key、超限或未知来源不派发子项；封口的空输入才产生合法空结果。
- 每项执行真实子程序，拥有独立scope和输入指纹；body私有绑定不会逃逸。共享slots/根1000 Agent预算仍由原Runner控制，未创建另一个executor。
- 同时活跃的map fiber有界，任何一项完成即可补位。已测试慢a未完成时，b的verify完成并准入c，不等待整页结束；不是先扫完全部再统一复核。
- 父结果为宿主mint的集合描述符及typed metadata，manifest保留全部key/index/state/settled/result reference。业务unknown和物理settled分开；unknown时停止新项准入，未执行项仍pending，不伪装成功或丢掉。
- manifest为独立、内容寻址的`.collection.json`，受现有8MiB记录限制，不复制每项原始输出；普通数据值仍限4MiB。已验证4096项、超过4MiB的纯引用/状态清单可独立保存并冷读。
- Native JSON schema和literal不能mint集合权限；形似描述符的普通对象不是受控引用。cold load校验manifest存在、hash、workflow、count、slot结构及封口状态。

`collect`使用`{kind:"collect",blockId,items:expression}`，显式读取已封口集合，产生保留全部outcome的有界数组；失败项没有伪造value/0/null，仍有状态和错误。它可紧随其直接依赖的已知、已settled失败map读取摘要；unknown不会因collect推进。执行失败与partial报告可用性分开，不把失败结果改成completed。

map也可读取受控集合：必须沿用`key:["key"]`；只为活跃fiber读取该项payload。需要重分组时先显式collect；collect展开超过4MiB则失败并保留原引用，不声称完整展开。更大的分组/投影需要后续流式引用操作，不能调大普通value上限绕过。

嵌套字段的host读取权投影及受控集合的按项group/filter现已支持，范围如下。完整失败/修订依赖恢复尚未完成，不据此宣称全部map/循环/恢复合同通过。

本阶段14文件172项focused、Node/web types及build通过；关闭重复key预检后1项失败（已发出1次本应禁止的调用），按SHA256恢复后11项通过。首次fixture表参数、误删同内容hash的另一个artifact、回调/联合类型推断失败均保留于证据说明；未删除断言或放宽超时。只读证据：`~/.local/state/rotom/verification-evidence/workflow-m3-map.Yvzbbh/`。这些是生产Runner/临时文件存储加Provider test double，不是完整App或真实账号验收。

### 嵌套 collection 的读取权投影

- known value 可携带 main 专用 `collectionFields: [{path, collection}]`，只保存普通 JSON 内各个受控集合的准确位置。根受控集合仍使用原 `collection` 字段；二者不混用，不从 literal、Agent JSON 或看似相同的 descriptor 推断读取权。
- outcome 的 `value`、parallel 对象、collect 数组和 field 投影保留/重定位这些位置。普通数组的 concat、group/unique、filter/partition 也保留读取权，包括 predicate 中读取成员集合的 count；改变数组位置时按显式索引映射，不逐项扫描整个 authority 列表。
- durable value 逐条校验同一 workflow、非空路径、唯一位置与准确 descriptor；最多4096条，深度64，metadata及整体持久文件仍受8MiB边界约束。冷读核对引用 manifest 的存在、hash、count及sealed状态，同一次读取去重相同引用。不存在的manifest不能仅凭缓存 descriptor 继续报告计数；子项实际输出仍按需要加载。
- 已有普通JSON不补发读取权。旧版本若已保存了没有 sidecar 的嵌套 descriptor，它仍是普通数据；需要显式重建受控产出，不能凭当前磁盘内容猜测历史授权。
- 此投影增量当时不包括host collection的streaming group/filter；后续实现见下一节。嵌套manifest校验有额外I/O；尚无相应collector，不宣称更快。若受控测量证明校验是热点，应增加绑定单次已验证读取快照的resolver，不能用跨读取缓存假定文件仍持久存在。
- 当前源码：11文件/140项focused测试、Node/Web types、build和生产preload/main→Service→Runner→Interpreter场景通过；新增嵌套map/collect真实使用0与false、预算/Provider调用均为0。未修复bundle在相同生产场景明确报“map来源必须是已提交数组或受控集合引用”。这是离线生产接线证据，不是完整M3、真实SDK或断电验收。

### 受控集合的按项 group/filter

- 表达式仍只有同一个解释实现。generator只为group/unique/filter/partition发出封闭的host读取请求，由原Control owner解析；普通数组/纯值仍走同一语义，没有新增可执行语言或模型调度器。bind、branch、map、collect和loop各阶段均使用此入口。
- source必须有main读取权且sealed；literal/model descriptor不授予读取权。清单仍整体限8MiB/4096项，payload一次读一项，数据总量可超过普通JSON值4MiB。group/unique的members为受控集合，保留全部原成员和原索引；保留的group keys累计先受4MiB约束，最终普通group数组也按4MiB检查。
- filter/partition均保留matched/rejected/unknown三组及原索引/理由；各组为受控集合。源outcome的state、settled、key和error不改写。predicate unknown是分类明确的unknown组，不伪造一个未知native副作用。
- 新增清单valueRef只引用main保存的纯变换数据，不是Agent/SystemStep效果收据，不能与frame reference同时声明。冷读仍核对workflow/hash/实际文件，缺失不返回空值。嵌套集合读取权经派生行持久化保留。老版本不认识此附加字段时应拒绝，不靠删字段兼容。
- 派生行先持久化，后写各分组manifest，最后由原控制帧提交。停止在按项边界检查，不发布部分结果；未引用的immutable数据不授权继续或派发。纯产物身份绑定冻结program/input scope，不绑定controller generation；负控证明错误绑定generation会使恢复的消费者inputKey不一致，修复后不同进程复用准确原引用且派发为0。
- 新增合同覆盖4.5MiB总payload、一次一个live item read、0/false、失败/unknown、未sealed、停止、冷读/缺失数据、保留key边界、嵌套predicate/读取权及同类collection union。当前4文件/52项focused、types/build、workflow UI与完整生产conversation IPC通过；新模板/集合步骤的Provider增量为0（完整conversation另有21次离线fixture调用，非真实账号）。
- 组合回归仍非全绿：首轮12文件/156项有4项原process恢复用例5000ms超时；generation修复后12文件/157项为156通过、原loop跨进程用例1项5000ms超时。原5项随后单独通过；冻结旧实现5项也通过；不能据此认定首败原因或关闭组合门禁。受控phase诊断当前/旧实现均约2.1s，只证明当时该场景，不证明历史超时源于负载。
- 尚无对应performance collector；必需measure仍unavailable，不宣称更快。完整failed/revised恢复、check/classifier和其余M1–M6仍缺。证据见m1-m6台账。
