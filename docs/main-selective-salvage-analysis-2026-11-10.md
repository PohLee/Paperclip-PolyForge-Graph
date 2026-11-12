# main 选择性抽取计划：Terra 分析与 Sol 审查结论

分析由 GPT-6.1 Terra High 完成，独立审查由 GPT-6.1 Sol High 完成；主代理于 2026-11-11 合入下列分级与事实修正。独立审查原文见 [Sol 审查报告](main-selective-salvage-review-2026-11-10.md)，其中 T 行号引用的是审查前的 Terra 报告。

## 结论

**可以进入 Phase 0；完整实施需先明确范围并落实既定预检；当前不能发布或认定 S1 + V1 已通过。** 计划避免整分支合并、保留官方 API 和不放宽证据规则的方向自洽。确认的文本矛盾是 S2/S3 的推荐地位与阶段必做冲突。延期 S4 的挂载方案已有源码通路，但真实 Host 上的加载与配置生命周期尚待证明；V1 的具体图与 fixture 契约也尚未落实。后两者是原计划已有的实施/验收检查，不是新发现的遗漏，更不证明 S1 不可行或必须冻结所有独立工作。本次未发现应阻止 Phase 0 的生产安全、数据损坏或核心不变量问题；这不构成全面安全背书，身份保护和工件完整性仍须实测。

基线：Graph `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`；Packs `6ad0652828b3075b72e457e2afa1b0807dcd929e`，两者实际 HEAD 与计划一致。经 Sol 核查，Graph 无 tracked 差异，但有两个未跟踪文件：输入计划和 `tests/plugin/routine-bridge-status.test.mjs`；Packs 完整状态输出为空。计划来自主 checkout 的未提交文件，本报告未修改它。路径约定：未加前缀为 Graph 基线；`Packs/` 指固定 Packs checkout。计划行号指输入计划。

## 优先问题与最小修订

| 等级 | 证据及影响 | 最小修订/判定 |
|---|---|---|
| **中：范围冻结需消歧** | 计划 44–52 行称 S2/S3 为建议、最小 S1+V1；169、176–181、188、286 行却要求完成 S2/S3、拆分提交，并用“不混用两个 checkout”作为 Phase 2 出口。 | 明确分支：S2/S3 未选时阶段、BDD、提交和最终记录均标记延期，不成为合并门槛；S1+V1 仍须记录固定源码、候选 digest、部署依赖并证明所选候选可靠，不能声称已完成 S3 的双 root 验收。将 S3 升为必要项需用户批准；此矛盾不阻止 Phase 0。 |
| **既定验收待补操作证据：S4 延期部署** | `src/plugin/catalog.mjs:10-37,81-95,119` 已支持包根 `polyforge.runtime.json.packEntries`；manifest 与 worker 使用同一 loader，存在现有部署通路。`src/plugin/manifest.mjs:5-14` 会吞掉 catalog 加载异常，仍可导出只有 CEO 的 manifest。`package.json:11-18` 不含 runtime 配置；`compose.e2e.yml:38-47` 的源码挂载与环境变量不足以证明真实安装包的加载。 | 操作化计划 52、63、137、288 行的已有要求：记录实际安装包根、只读 Packs 路径、sidecar 提供及升级后重供方式；清除开发机 fallback，并比较完整预期三包角色/技能、worker catalog 和 adapter 身份。错误配置须使验收失败，不能只断言非空。配置不在 tarball 中不代表部署不可行，也不应强制实现 S4。 |
| **既定 V1 预检发现：旧脚本不能原样用** | `Packs/packs/adlc/index.mjs:5-8,63-64` 聚合图；`engineering-graphs.mjs:16,53` 有 implementation/verification `0.1.6`，但 ADLC 图中无旧 `ui-ux-design`；`scripts/e2e.mjs:10,115-117,133-146` 和 `tests/e2e/e2e.test.mjs:9` 仍依赖旧图与角色假设。 | 按计划 204–206、270 行指定 pack/id/version、声明终态、权限、输入及输出证据来源，再有限适配 fixture。原样旧 E2E 不能作为完成证据，但不证明没有合法图，也不阻止所有 S1 局部实施。无法满足原契约则如实报告 V1 未完成。 |
| **条件风险：S4 inventory 升级兼容（原计划已覆盖）** | `scripts/runtime-artifact.mjs:6-8,62-80` v2 按本地 verifier 的精确文件集合比对；若仅扩大 inventory 而不改策略，新旧组合会相互拒绝。`runtime-preflight.mjs:55-69`、`upgrade-runtime.mjs:23-57` 使用该机制。 | 按计划 132 行明确 verifier 来源、格式策略与预期接受/拒绝行为，再定向验证；新旧组合矩阵是可选检查方式，不要求新增双向兼容。**不阻止整体延期 S4**。 |
| **声明边界提醒：完整性不等于来源认证** | verifier 不覆盖 `node_modules`、外部挂载 Pack、部署配置或所有 tarball 内容（`scripts/runtime-artifact.mjs:6-7,28-47,72-91`）；同包 metadata 摘要不是签名。manifest 外部 `semver` 见 `scripts/build.mjs:23-35`、`src/plugin/catalog.mjs:5`。 | 保留计划已有的 registry/integrity、运行依赖、固定输入与候选摘要检查；不将摘要描述为任意恶意重写认证，也不据此新增签名系统或判为安全阻断。 |

## S1–S4 证据和改动面

### S1：官方版本与公共接口

- `package.json:21-29` 固定 SDK `2026.1023.0`、声明 `semver`，默认测试只含 `tests/core`、`tests/e2e`；参考分支 plugin 测试不会自动进入 main。`src/plugin/manifest.mjs:45-96,115-149` 是旧 Host 门槛、capabilities、公开 routes/tool schema 的核对基准。升级不能只比较安装状态，还要逐项比较 routes、工具、schema、capability 和实际调用；若某项官方确实不支持，按计划 77、265–266 行明确单列并取得相应范围决策，不应默默删除。
- `scripts/check-worker-rpc.mjs:18-45` 用 `worker_smoke` 和 15 秒超时；参考 commit `9e6d2e5` 使用 `plugin_worker_smoke` 与 `minimumHostVersion: '0.3.1'`，这是可追踪的参考实现，不足以独立证明目标官方 loader 的要求。升级必须保留错误输出/超时并对实际 tarball 做独立依赖解析检查：worker bundled 不等于 manifest 隔离可加载。
- 三份 Compose 当前 pin 旧镜像；`compose.real.yml:19-20` 确实覆盖 command 并引用 `tsx` 和 `server/dist/index.js`。必须读取**目标 digest 对应镜像元数据**确定 ENTRYPOINT/CMD、路径和 bootstrap，而不是从参考推断。`compose.e2e.yml:20-35` 的 authenticated 模式通过主机 loopback 暴露端口，但容器内绑定 `0.0.0.0`；不能原样改为 `local_trusted` 却只检查宿主端口。Context7 当前官方文档指出 local_trusted 是 loopback-only，但返回 master 而非目标版本，不能证明目标镜像行为。
- `src/plugin/manifest.mjs:20-27,34-41` 现有托管角色在 fixture 环境设置时全局采用 process，其他情况显式 `codex_local` 偏好。计划“只对隔离测试 Agent 使用 Process”应落实为仅在隔离 Host 的 fixture 配置，并对产品 provisioning 的行为做基线差异比较；不要把官方新建 Agent 默认值直接等同于现有 manifest 声明。`scripts/e2e.mjs:163-169` 已使用 run ID 读取 heartbeat，不能据此断言受分页上限影响。
- 参考 `af960c9:package.json` 确有两个日期版本依赖及 bundleDependencies；这只证明参考分支配置，不能代替目标 registry 的 tarball/integrity、实际传递依赖或 npm pack 结果。

### S2：Windows 修复可独立选择

`da74478405e72277d17ea755e0a47eb0a70fffce` 确实只涉及计划指定的两个文件；其 diff 在两个保存位置共用 `writeJsonAtomically`，UUID 同目录临时文件，win32 的 EPERM/EACCES 才延迟 10/20/40/80/160 ms 重试，其他异常抛出；`finally` 忽略 unlink 错误，因此“临时文件被清理”是需验证的期望，并非对所有文件系统错误的无条件保证。并发业务写不具 CAS。没有实际模拟 Windows/读者并发，不能声称修复已验证。

### S3：固定来源不自动解决部署

`scripts/build.mjs:5-6,17-20` 编译时静态引用相邻 ADLC/Creative 数据；`src/plugin/trusted-pack-adapters.mjs:4-13` 另有可执行 host-api 静态 import；`src/plugin/pack-host-support.mjs:55-64` 以 id/version/规范化 pack digest 匹配可信 adapter，不一致可阻断 governed graph。固定数据源而不重定向可执行 import 不够。参考 `9e6d2e5:scripts/trusted-pack-imports.mjs` 仅对指定 importer 和四个具体模块映射，符合局部移植思路；`e1ca1a1` 自身不包含该 helper。即便 S3 完成，运行时 catalog 仍由配置/fallback 加载，须单独固定和核验部署来源；日志中 Graph/Packs SHA 与 dirty 状态亦应以实际构建源及构建方式提供，不假定任意 fixture 必有 Git 元数据。

### S4：snapshot 为可选、整体处理

参考提交 `50d1d98` 嵌入 manifest，`4ac2e2b` 增加 worker catalog snapshot，`c4d9747` 将其纳入 artifact；这些是分段参考，不证明移植后的统一数据源、优先级、force reload 或升级兼容。当前 `catalog.mjs:52-78,108-118` 已用新 worker 实现源码 force reload；新 snapshot 方案也须对部署源变化重新读取而非模块缓存。`Packs/packs/adlc/index.mjs:201-202` 的 `release.digest` 用自身字段加入前的普通 `JSON.stringify(pack)`；`src/plugin/trusted-pack-adapters.mjs:15-17,25-33` 的 adapter digest 则对完整对象使用 canonical JSON。两种摘要目的及输入不同，不能互换或改写既有 release 语义。

## V1 静态候选、差异与身份

可调查但**未证明可完成**的最小候选是 `adlc/request-triage@0.2.0`：`Packs/packs/adlc/lifecycle-graphs.mjs:13-29` 只有一个任务、review、一个 decision 和三个终态，需 `source_request`，不是零成本 hello-world。`assess-request` 产出 `triage_report`、`request_brief`，存在 triage-report output contract；`Packs/packs/adlc/runtime/host-api.mjs:109-130` 要求受管 artifact 的 payload 与 envelope 的 id/version 相符并调用 validator。旧 `scripts/e2e-fixture-agent.mjs:294-305,431-452` 对 decision 硬编码旧节点列表，通用 submit 不提供 `payloads` 或 triage-report 专属输出；不能原样完成该图。`scripts/fixture-contract-inputs.mjs:1-7` 只给 implementation/verification 专属输入。需要在隔离 fixture 中以真实合约允许的合成请求、可追溯的本地事实和明确未知项构造输入/输出，并依据真实规则选择合法 decision 或由授权人执行；审查 validator、review、decision 的所有必需内容后才能判定是否可行。不要把需要外部核实的重复检查、真实业务结果伪造成已观察事实。

替代路径也非现成简单：`implementation@0.1.6` 需要 design identity、计划、执行及候选证明（`engineering-graphs.mjs:16-36`）；`verification@0.1.6` 有固定候选和 QA 前独立同 Agent 子任务要求（同文件 53–66 行；`Packs/packs/adlc/index.mjs:140,168`）；Marketing `acquisition-plan` 要认证发布 handoff（`Packs/packs/marketing/graphs.mjs:7-15`），不应捏造发布以通过。存在这些图不等于其中任一条已满足 V1。

身份方面，fixture 从 Host 注入 token、Agent、run 构建 bearer/header 并 checkout（`scripts/e2e-fixture-agent.mjs:7-12,203-215`）；`src/plugin/worker.mjs:153-162` 将 Host actor 映射到 executionId，`src/plugin/pack-host-support.mjs:28-36,90-105` 比较受信 actor。请求 body 的伪造 actor 不能替代 Host 身份；旧 E2E 的伪造 actor 断言仅覆盖 owner start（`scripts/e2e.mjs:144-148`），**不等于** BDD-V1-02 的错误 Agent/错误 run 对活动 attempt 的负向提交、状态不变、合法重试无重复派发均已验证。测试记录应避免泄露 token/cookie，保留 IDs、响应类型与状态差异。

## 有限实施顺序和审查检查点

1. 可以进入 Phase 0：固定两个输入、记录未提交文件与公共 API/图/角色/技能/migration 基线，同时由用户确认是否只选 S1+V1。对不选的 S2/S3/S4 明确延期，不扩大范围。
2. 按原计划静态预检一个满足原契约的 V1 路径、预先声明的合法终态、fixture 证据与身份负向测试。未证明可完成时不得承诺 V1 通过，也不因此冻结所有独立的 S1 局部工作。
3. 做 S1 精确 SDK/Host pin、依赖、真实入口和 API 兼容的小改动；用隔离包+显式部署挂载证明 manifest、worker、catalog 与 adapter，而不是依赖源码 checkout。再按计划执行有界真实 Host V1 和必要受影响回归。
4. 仅在明确选中时独立实现/验证 S2 和 S3；仅在成本允许且 S3 已完成时整体做 S4，按选定格式策略验证 verifier/inventory 的接受与拒绝行为，不承诺新旧双向兼容。最终按实际通过/失败/跳过拆分记录；不把本报告或静态证据计作运行通过。

## 外部事实、验证状态及 Sol 复核清单

- Context7 查询 `/paperclipai/paperclip` 返回 master 的 manifest 规范和 local_trusted 文档（<https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md>、<https://github.com/paperclipai/paperclip/blob/master/docs/deploy/deployment-modes.md>），未提供 `2026.1106.0` 的版本化证据。计划的 registry integrity、镜像 digest、镜像真实 server version/入口、目标 capability 全清单、namespace、Runner 默认值、heartbeat 限额、受限环境传递机制均**未独立核验**；依赖官方目标版本实际包、镜像或固定 release 源证实。
- Sol 可从：计划 44–52/166–181/278–290；`manifest.mjs:5` 与 `catalog.mjs:20–37,81–119`；Packs 的 ADLC 聚合及 triage wrapper；旧 E2E 脚本；`runtime-artifact.mjs:6–8,62–80` 与 `runtime-preflight.mjs:55–69`、`upgrade-runtime.mjs:23–57` 独立复核。特别区分“问题已证实”“路径需要证明”和“外部未知”。
- 本次只有静态文件、固定 commit、只读 Git 状态和 Context7 文档查询；**未运行测试、构建、npm install/pack、Docker、模型、升级或真实 Host**，没有创建数据库/归档，未修改其他文件、未提交或合并。上述候选可行性、隔离加载、错误身份拒绝和任何正式验收均未通过验证。
