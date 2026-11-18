# 回归 main：官方 SDK 升级与独立改动抽取计划

状态：仅计划，尚未执行代码抽取、依赖升级、测试或合并。编写日期：2026-11-10。

## 1. 决策与交付目标

停止将 `controlled-dynamic-workflows` 作为待合并版本推进。Graph 与 Packs 以各自 main 为产品功能基线，只抽取能独立解决现有问题的改动。原五阶段动态工作流计划不再是本轮交付目标，不能将其待办自动带入本计划。

目标是：维持 main 的现有 Graph／Pack 契约，使用官方 Paperclip SDK 与镜像 `2026.1106.0`，修复独立的 Windows 文件写入问题，并按成本选择改善构建来源一致性和独立安装能力。

硬边界：

- 不 merge、squash 或批量 cherry-pick 整条实验分支；后续实施从 Graph main 新建小分支。
- 不修改 Paperclip 源码，不使用定制 SDK tarball、私有 Host API 或自编译 Host。
- Packs 维持 main；不升级到实验分支的 ADLC `0.3.8`、Creative `0.3.4`，不引入 Agentic Improvement Pack。
- 不引入新的 Graph 节点类型、执行器、调度器、状态机、数据库表或 provider 系统。
- 不把实验分支的整包 admission 阻断策略带回 main，也不通过放宽 main 已有授权／证据规则来使测试通过。
- 项目没有旧生产数据；本计划不建设生产迁移或双轨兼容。测试仅使用明确可丢弃的隔离实例。
- 实验分支的 foreach／Finding 残留无需继续删除才能完成本计划；它们不进入 main。保留 Git 历史作为参考，不在本轮删除分支或清理他人工作区。

## 2. 固定基线与官方版本

| 对象 | 固定值 | 用途 |
| --- | --- | --- |
| Graph main | `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，Core `0.8.7` | 实施起点 |
| Packs main | `6ad0652828b3075b72e457e2afa1b0807dcd929e` | 唯一配对的产品 Pack 来源 |
| main 的源码 Pack | ADLC `0.3.2`、Marketing `0.0.4`、Creative `0.3.1` | 不混入实验 Pack；历史已安装版本仍按 main 原有 catalog 规则处理 |
| Graph 参考分支 | `9e6d2e5ac62e3869bbcd5692062b99931bbf7ebc` | 只读参考、挑选局部改动 |
| Packs 参考分支 | `c313cf4407ad289b2523a696abb102691fa6c5f9` | 只读参考，不作为构建输入 |
| 目标 npm SDK | `@paperclipai/plugin-sdk@2026.1106.0` | 精确版本，不使用 `latest`、`^` 或 `~` |
| SDK 的 shared 依赖 | `@paperclipai/shared@2026.1106.0` | 已安装的官方 SDK 声明此精确依赖；应用直接引用时也使用同版本 |
| 官方 Host release | `v2026.1106.0`，commit `d69631b01b9c658f80bf8bed389863dce82643e1` | 官方发行基线 |
| 官方镜像 | `ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da` | 采用已核验的完整 image pin；执行时再次检查本地 image identity |
| 插件 Host 版本门槛 | 官方镜像向 loader 报告的 server version 为 `0.3.1` | `minimumHostVersion` 与发行标签属于不同版本空间，不能填成日期版本 |

main 目前使用 SDK／镜像 `2026.1023.0`。升级官方基线是本计划的必要工作，不需要合入动态工作流体系才能完成。

编写时，官方 [v2026.1106.0 release 页面](https://github.com/paperclipai/paperclip/releases/tag/v2026.1106.0) 标记该版本为 Latest。本计划固定该版本；若实施时已有更晚发布，不自动扩展升级范围。已读取的本地官方 npm 安装元数据和参考分支 lockfile 均为 `2026.1106.0`；本次网页工具未能读取 npm registry JSON，实施时仍须用包管理器核对来源和 integrity，不能把本地元数据当作一次新的线上 registry 验证。

版本注意事项：官方 Git 源码中的 package version、npm 发布版本、Host loader version 可能不同。不得将源码树的 SDK `1.0.0` 或 shared `0.3.1` 误写为这里要安装的 npm 版本。

## 3. 抽取清单与优先级

| ID | 改动 | 优先级／成本 | 采用方式 | 与其他项的关系 |
| --- | --- | --- | --- | --- |
| S1 | 官方 SDK／镜像 `2026.1106.0` 及最小兼容修复 | P0，必要，中 | 在 main 上重做局部变更 | 独立于实验 Core；最终验收必须覆盖 |
| S2 | Windows 检查结果 manifest 原子写入重试 | P1，建议，低 | 优先评估单提交抽取 | 可独立交付；不依赖 S3／S4 |
| S3 | 显式固定 Packs 构建来源，统一数据和可执行 adapter 来源 | P1，建议，中低 | 抽取思路与小型构建 helper | 是 S4 的前置；不变更 Pack 内容 |
| S4 | 自包含 Pack catalog、manifest 和 runtime artifact 完整性 | P2，可延期，中 | 在 main 结构上移植必要部分 | 必须与 S3 配套；有成本压力时整项延期 |
| V1 | 官方镜像上的最小真实 Graph 生命周期验收 | 必要验收，非新增产品功能 | 复用 main fixture／脚本，限制场景 | 不得以安装成功替代执行完成 |

最小交付是 **S1 + V1**；推荐增加 **S2、S3**。S4 有明确部署价值，但不应成为维持官方版本兼容的无限期阻塞项。若延期 S4，继续使用明确的 Packs 部署挂载，并在交付说明中保留这一前提。

### S1：官方发布基线与兼容调整

**价值**：遵守官方 Host 底线，让 main 在指定官方版本上安装和运行；不承接实验功能。

来源参考：`af960c9`；`scripts/check-worker-rpc.mjs` 的 namespace 修正；参考分支 `tests/plugin/host-sdk-pairing.test.mjs`。`af960c9` 含大量实验功能删除及新 snapshot 迁移，**禁止整提交 cherry-pick**。

实施步骤：

1. 将 `package.json` 的 SDK 精确改为 `2026.1106.0`，由包管理器更新 `package-lock.json`，核对 registry 来源和 integrity。shared 随 SDK 精确解析；仅在直接导入或打包需要时显式列入应用 dependencies。
2. 检查实际 tarball 中 manifest／worker 的外部依赖。确保离开开发机的 `node_modules` 后仍能加载；采用 bundling 或随包依赖的现有机制，不建立新插件加载框架。`semver` 是当前 manifest/catalog 的运行时依赖，不能漏打包。
3. 将 `src/plugin/manifest.mjs` 的 `minimumHostVersion` 调整为与官方 loader 一致的 `0.3.1`，并用真实安装验证。保留 main 的工具列表、输入 schema 和 capability 范围；不复制参考分支新增的 revision／improvement／issue-source 参数。
4. 核对 main manifest 中每个 capability 均在官方 SDK 的能力清单中。若有不支持的调用，先定位其对应的现有功能；仅修复官方 API 用法，不添加 Host 方法或自定义协议。
5. 更新 `compose.e2e.yml`、`compose.enhancement.yml`、`compose.real.yml` 的 image pin，并查找活动脚本中残留的旧版本假设。历史文档可保留明确标注的旧记录。
6. 特别检查 `compose.real.yml`：main 覆盖了启动 command，硬编码 `tsx` 与 `server/dist/index.js`。官方新镜像改用预编译启动包，不能只换 image tag 后继续假定旧路径可用。优先使用官方入口；若需初始化既有凭据挂载，只保留最小 bootstrap，再调用经镜像元数据确认的官方命令，不复制或改造 Host 启动代码。
7. 核对 worker RPC 初始化的 namespace 约束，采用官方允许的 namespace（参考 `plugin_worker_smoke`）；同时保留初始化超时和错误输出。
8. 检查现有代码／脚本对 Agent 默认 adapter 的断言。官方在符合条件的平台将新 Agent 转到 Paperclip Runner；不得继续全局断言 `codex_local`。依实际平台、官方响应和配置检查行为；Process adapter 只用于隔离测试，不能替换产品的正常 Agent 配置。
9. 检查现有 heartbeat history 查询是否依赖无限结果。官方该接口默认返回 200、最多 1,000 条；优先按已知 run ID 获取精确记录。只有实际调用受影响时才修复，不新增历史扫描子系统。
10. 新测试应进入现有 `tests/core`／`tests/e2e`，或显式纳入测试命令，避免增加了测试文件却未被 `npm test` 执行。

上述 Runner、预编译启动包、heartbeat 查询上限来自 [官方发布说明](https://github.com/paperclipai/paperclip/releases/tag/v2026.1106.0)。这些是兼容检查点，不是新增产品需求。

涉及文件主要为 `package.json`、`package-lock.json`、三份 Compose、`src/plugin/manifest.mjs`、`scripts/check-worker-rpc.mjs`，以及确认受影响的少量测试／启动脚本。预期不修改 `src/core/engine.mjs` 的状态转移，不新增 migration。

风险与边界：medium risk，主要在安装、启动、打包及官方响应差异。若某项现有能力确实缺少官方接口，记录准确 API 与受影响功能，按用户已确定的取舍取消该能力的交付；不要为其补建 Host，也不能把所有无关 Graph 一起封锁。影响必须在最终差异表中单独列明。

### S2：Windows 原子 manifest 写入

**价值**：修复检查进程保存／确认结果时遇到短暂文件占用的失败；直接服务现有 main 的 check runner。

来源：`da74478405e72277d17ea755e0a47eb0a70fffce`，仅涉及：

- `src/host/check-runner.mjs`
- `tests/core/check-runner.test.mjs`

实施步骤：

1. 先查看该提交与 main 的差异及依赖；可以局部抽取该提交，不引入其他分支提交来解决冲突。
2. 保留同目录唯一临时文件，避免多个写入方共用一个 `.tmp` 路径。
3. 仍以 rename 为唯一提交点；仅对 Windows 的 `EPERM`／`EACCES` 做有限重试，使用参考实现的 10、20、40、80、160 ms 延迟。
4. 非共享冲突错误立即抛出；超出次数后抛出原始失败。清理本次临时文件，不触碰其他写入方文件。
5. 保存 manifest 与 acknowledge 都走相同的原子写入方法；保留已有状态与结果语义。

验收：瞬时共享冲突后写入成功；重试耗尽仍失败；非 Windows／非目标错误不重试；读者不会看到半个 JSON；临时文件被清理。测试应覆盖行为和失败边界，不只断言 helper 被调用。

限制：这只改善文件原子替换和短暂占用，**不提供跨进程 CAS，不防止业务层丢失更新，也不扩大 FileStore 的单写者保证**。不要把它演变成文件锁系统。

### S3：固定 Packs 构建来源

**价值**：防止“从 worktree A 读 Pack 数据，却从相邻 checkout B 编入执行 adapter”，并避免构建依赖开发机的目录布局。

来源：`e1ca1a1` 的显式来源选择；参考分支 `scripts/trusted-pack-imports.mjs` 和对应测试。后者应按文件／逻辑抽取，不能为获得 helper 整批引入后续执行器提交。

实施步骤：

1. `scripts/build.mjs` 支持 `POLYFORGE_PACKS_SOURCE_DIR`，解析为确定的绝对目录。交付构建显式提供该值；本地开发可以保留 main 的相邻目录默认值。
2. 从这一个 root 导入 main 的 Pack 数据、catalog、角色、技能，以及 ADLC／Creative 的可执行 host adapter。
3. 移植只覆盖已可信模块的 esbuild import 重定向：仅允许指定 importer 与明确模块映射。不要把它泛化成任意 Pack JavaScript 动态加载入口。
4. 构建日志记录 Graph SHA、Packs SHA／是否 dirty、各 Pack id/version/digest；最终验收产物必须来自固定且无未记录修改的输入。
5. 路径错误、缺少 adapter 或数据／执行来源不一致时，构建失败。显式指定了错误目录，不能静默回落到另一份 checkout。
6. 维持 main 的 Pack 契约与版本；不硬编码检查 Agentic Improvement 角色、技能或包是否存在。

关键文件：`scripts/build.mjs`、小型 trusted import helper、必要的 `src/plugin/trusted-pack-adapters.mjs` 来源处理与构建测试。

验收：使用两个内容可辨识的本地 fixture root，显式选择 B 后，manifest 数据、Pack digest 和编入的 adapter 必须全部来自 B。改用 A 或保留相邻 A 都不能污染结果。测试不需要 Docker 或模型。

### S4：自包含 catalog 与完整性绑定（可整体延期）

**价值**：官方 worker 环境不必继承开发机环境变量或挂载相邻 Packs 源码；同一个 tarball 的 manifest、catalog 和 adapter 能保持一致。

来源：`50d1d98`、`4ac2e2b`、`c4d9747`；参考 `tests/plugin/built-manifest-no-env.test.mjs`。这些提交依赖实验分支上下文，采用局部移植，不机械 cherry-pick。

实施步骤：

1. 由 S3 的单一 root 生成 `dist/packs-catalog.json`，包含序列化 Pack 与确定性 digest；构建阶段把同一 catalog 嵌入 manifest 的角色／技能声明。
2. 复用 main 既有 canonical JSON／SHA-256 语义；如需共享，提取无领域逻辑的小 helper。不要为了一个 digest 导入 `candidate-evidence.mjs` 或整套验证体系，也不要改变 main 既有 Pack `release.digest` 算法。
3. 在 `loadCatalog` 中明确解析优先级：显式参数／部署配置优先；未显式配置时读取随包 snapshot；开发模式缺少 snapshot 时才使用原来的 fallback。snapshot 损坏、重复 id/version 或 digest 不符必须报错，不能静默切换到相邻旧包。
4. 无运行时 Packs 环境变量、无相邻 checkout 时，manifest 与 worker 均可加载 main 的角色、技能和 catalog。`force` reload 必须重读当前部署源，不能继续返回旧模块缓存。
5. 将 `dist/packs-catalog.json` 纳入现有 runtime artifact 文件清单和 digest 校验，并核对 `npm pack` 的实际内容与运行依赖。
6. 新候选包含了额外的必需 artifact 文件，必须检查 main 的升级／preflight 是否接受此 inventory 变化。若涉及 artifact 格式变化，明确版本与旧候选的拒绝行为；不虚报 v2 结构完全兼容，也不为本项目无生产数据场景建立复杂迁移层。
7. 改写参考测试中的 `agentic-improvement` 断言，用 main 的 ADLC／Marketing／Creative 角色和技能；保留来源一致性、无环境加载、篡改拒绝这些测试目的。

关键文件：`scripts/build.mjs`、`src/plugin/manifest.mjs`、`src/plugin/catalog.mjs`、`scripts/runtime-artifact.mjs`、相关打包／升级测试和必要 package 元数据。

风险：medium，catalog 来源选择和 artifact inventory 是真实兼容边界。不要只合入 manifest 内嵌部分却声称 runtime 已自包含。若成本超出预期，整体延期 S4，保留 S3 的显式源码挂载方式，并继续完成 S1 的官方兼容验收。

## 4. 明确不抽取的内容

| 内容 | 排除理由 |
| --- | --- |
| foreach Core、回执、恢复实现及其 SQL／保护层 | main 没有该实验功能，无需把“新增后再禁用”的复杂度带回 |
| Native Routine bridge、自动 Retro／提案、Agentic Improvement Pack | 原核心目标已退出交付，不能通过“顺带抽取”复活 |
| plugin-owned Tool／Workflow executor、统一物理容量与 lease 子系统 | 新架构能力，不是 SDK 升级所必需 |
| 新 workflow admission、Candidate approval、验证 provider 体系 | 与实验 Pack 深度耦合；会改变现有 Graph 的可启动性与结果语义 |
| `dispositioned` 状态及其 Work Plan／通知修复 | 这些修复依赖本轮新增状态，不是已证明的 main 缺陷 |
| task revision、选择性证据复用、Finding／Judge 状态 API | 不属于 main 维护与官方兼容最小范围 |
| 新的 Issue source snapshot 数据模型和 migration 018 | 如 main 出现独立可复现的上下文缺陷，另立局部修复；本轮不预先引入 |
| 实验分支的 Creative graph 删除与整包 blockedGraphIds | main 保持原有 Pack 范围；不能只升级新 Pack 而不承接其 Core／provider 依赖 |
| migration 016–019 与对应恢复测试 | main 未采用这些功能，无需新增这些表 |
| 旧五阶段计划、实验测试数量与手动安装记录作为验收结论 | 可以引用经验，但不能替代 main 新候选的验收 |

## 5. 四阶段执行顺序

### Phase 0：冻结小范围与基线

- [ ] 检查两个 main 是否前进；若前进，只核对新增差异并更新 SHA，不自动恢复旧计划。
- [ ] 从 Graph main 创建独立实现分支，例如 `codex/main-official-sdk-salvage`；优先复用可用 checkout。Packs main 作为只读配对输入。
- [ ] 记录已有未提交文件，尤其 `.audit/` 和遗留测试，不能把它们混入提交或批量删除。
- [ ] 记录 main 的图、角色、技能、公开工具、capability 与 migration inventory；作为防止功能偷偷增删的对照。
- [ ] 在配对环境执行一次必要的基线检查。对已有失败区分环境与功能，不以“让旧测试全绿”为名重建历史验收系统。

出口：明确固定输入、允许变更清单和现有失败。没有新增产品能力。

### Phase 1：必要兼容与独立修复

- [ ] 完成 S1：SDK／镜像、启动入口、manifest Host version、namespace／Runner 等实际兼容点。
- [ ] 独立完成 S2，单独提交，避免文件写入修复与 SDK 升级互相耦合。
- [ ] 执行对应 focused tests、构建及 worker RPC 初始化检查。

出口：官方版本上的包可以安装；Windows 修复可单独审查／回退。此时只标记“安装就绪”，不标记真实 Graph 执行已验收。

### Phase 2：构建一致性与可选打包

- [ ] 完成 S3，并用分离的源目录证明 adapter 与数据一致。
- [ ] 在成本允许时完成 S4；若延期，明确保留的部署挂载要求，不阻止 S1／S2／S3 独立交付。
- [ ] 用固定 main Packs 构建一次候选 tarball，记录 SHA-256、输入 commit 和 Pack digests。
- [ ] 检查 diff 没有实验 Core 能力、admission blocklist 或新 migration。

出口：一个输入可追溯的候选包，不混用两个 Packs checkout。没有改变 main 的工作流定义来适配测试。

### Phase 3：有限、真实的验收与提交拆分

- [ ] 执行 V1，覆盖下节定义的生命周期，保存准确阶段结果。
- [ ] 对最终候选运行一次受影响回归集；修改后的失败只重跑对应检查。记录 skipped，不计作通过。
- [ ] 独立审查来源边界、公开 API／Pack 范围和官方版本兼容；若继续采用此前分工，开发／验证用 GPT-6 Luna High，审查用 GPT-6 Sol High。
- [ ] 提交拆分为：官方基线兼容、Windows 修复、构建来源固定、可选自包含打包。验证脚本随相关提交，避免一个大提交重新制造原分支的问题。
- [ ] 更新 main 面向使用者的版本、部署前提与已验证范围；原五阶段计划标为历史，不继续展示成当前待实施任务。

出口：各改动可独立审查；只有对应验收通过的改动才进入合并候选。本计划本身不执行 merge 或 push。

## 6. V1 与 BDD 验收规格

### 6.1 测试层次

| 层次 | 必须证明 | 不能声称 |
| --- | --- | --- |
| 单元／模拟 | 原子写入、来源一致性、digest 拒绝和现有状态转移 | 官方 Host 已执行 Agent |
| 包级隔离检查 | tarball 在隔离目录可加载；manifest／worker／catalog 一致 | 真实 Graph 已完成 |
| 官方镜像集成 | 安装、初始化、Pack 选择、角色配置 | 仅凭安装成功就完成 E2E |
| 真实 Process Agent 生命周期 | Host 派发、checkout、带真实身份的 callback、Graph 达到预期终态 | 真实模型推理质量或外部业务效果 |

优先复用 main 的 `scripts/e2e.mjs`、`scripts/e2e-fixture-agent.mjs` 和现有 contract inputs，只保留一个必要 Graph 的测试路径。必须先确认固定 main catalog 中确实存在所选 graphId/version，输入和输出能满足当前契约；不能直接相信旧脚本中 `ui-ux-design` 等名称或以前的完成记录。

V1 使用一个现有、无需付费模型或新外部 provider 的 Graph。若旧 fixture 不能完成该图，先定位具体契约差异；不为过测试新增产品 Graph、关闭验证、伪造发布／指标证据。无法达到终态时必须报告“生命周期验收未完成”，不能删掉失败步骤后把测试改名成成功 E2E。

### 6.2 Given／When／Then

**BDD-S1-01：官方包与 Host 版本空间**

- Given SDK／shared 从官方 registry 解析为 `2026.1106.0`，Host 为固定官方镜像。
- When 构建并安装候选插件。
- Then loader 接受正确的 Host semver 门槛，worker 在有限时间内初始化，manifest capability 均为官方支持项；不要求任何定制 Host API。

**BDD-S1-02：官方启动与 Agent 默认值**

- Given 官方预编译镜像及明确部署模式。
- When 启动测试实例并创建临时测试 Agent。
- Then 入口与 bind 配置有效；`local_trusted` 只走容器内部 loopback，或采用完整 authenticated 配置；不硬编码所有平台都必须返回 `codex_local`。
- And 只对该隔离测试 Agent 使用官方支持的 Process adapter，正常产品 provisioning 默认值不被修改。

**BDD-S2-01：短暂共享冲突与失败边界**

- Given 已有完整 manifest，Windows rename 短暂返回目标共享错误。
- When runner 保存新结果或 acknowledge。
- Then 有限重试后读到完整新 JSON；此前仍是完整旧 JSON；本次临时文件被清理。
- And 非目标错误／耗尽重试会向调用方报告失败，不无限等待，不声称并发事务保证。

**BDD-S3-01：数据与执行 adapter 来自同一 root**

- Given 相邻 checkout A 与显式配置 B 有不同的可辨识 Pack 数据和 adapter 内容。
- When 构建选择 B。
- Then manifest、catalog、Pack digest、可信 adapter 全部绑定 B；无效 B 导致失败，不回退 A。

**BDD-S4-01：没有相邻 checkout 的真实安装包**

- Given 只解压候选 tarball，并移除测试进程的 Packs 环境配置，外部源码不在可访问目录。
- When 官方 Host 加载 manifest、启动 worker、读取 catalog 并 force reload。
- Then main 的预期角色、技能、Pack 版本可见且一致；所需运行时依赖全部可解析，不隐式访问开发 worktree。

**BDD-S4-02：snapshot 篡改**

- Given 已构建的 catalog 或其 id/version/digest 被修改。
- When 验证 artifact 或读取 catalog。
- Then 拒绝损坏／重复的候选，不从旧路径静默恢复；artifact inventory 变动的兼容行为有明确结果。

**BDD-V1-01：真实 Host 的最小 Graph 闭环**

- Given 固定官方镜像、可丢弃数据库、候选 tarball、main 配对 Pack，以及已确认存在的最小可完成 Graph。
- When 已授权 owner 启动该 Graph，Host 创建实际任务并唤醒 Process fixture。
- Then fixture 使用 Host 注入的 Agent／run 身份 checkout 并通过插件提交当前 attempt 的结果；需要的 review／decision 按该图原有规则执行；Graph 达到声明的终态。
- And 记录图版本、Graph run、Host run、派发次数和终态；不直接写数据库来制造完成，不仅验证 GET 状态成功。

**BDD-V1-02：身份错误不能推进**

- Given 上述活动任务和当前 attempt。
- When 使用错误 Agent 或错误 run 身份提交同一结果。
- Then 插件拒绝请求，Graph 状态与已记录结果不改变；随后合法身份仍能按既有幂等规则工作，不重复派发。

**BDD-SCOPE-01：main 功能范围不被实验策略改变**

- Given Phase 0 保存的 main 配对 catalog 与公开 API inventory。
- When 安装新候选。
- Then 未引入实验 Pack、全包 blockedGraphIds、foreach／revision／Routine 新命令或 migration 016–019；现有图的可用性前提没有被悄悄新增。
- And 若官方接口确有缺口导致某个现有功能被取消，单列该差异与官方依据，不将它描述为“全部范围保持不变”。

## 7. 控制预算与停止扩张

1. 先做静态预检再开 Docker：核对版本、官方入口、bind、角色命名、图 ID、adapter 配置和必需输入，避免再次用运行测试发现明显旧假设。
2. 默认不调用付费模型；真实 Process Agent 测试与真实 LLM 验收分别报告。后者不在本计划内。
3. 每项 focused tests 一次，新增修改只重跑受影响项；完整基线／最终回归各有明确目的，不无变化反复跑全套。
4. 同一候选先运行一次有界 Docker 验收；只有查明原因并修复后才重试。同一阻塞连续两次仍未解决时，记录证据并停止该候选验收，不继续换场景试到成功，也不将门槛缩成安装成功。
5. 在 `finally` 清理本次带唯一标识的容器、网络和临时目录；失败时先保留阶段日志。不能对已有开发实例或未知卷做清理。
6. 如果 S4 需要引入新的 Core 体系或广泛升级兼容层，则延期 S4。若 S1 本身无法只靠官方接口完成，报告准确受影响能力及取消范围；不回头修改 Paperclip。
7. 缺少 Docker、必要工具或合法身份时，报告环境阻塞；跳过的集成检查不作为发布通过证据。

## 8. 最终交付与合并门槛

最终交付记录应包含：

- Graph／Packs 输入 commit、官方镜像 digest、npm SDK／shared 解析来源、候选 tarball digest。
- S1–S4 分别标注已完成／延期／未通过；列出实际修改文件及保留的部署前提。
- 基线与候选的 Graph／API／migration 差异，以及所有有意取消的功能。
- focused／回归／包级／真实 Host 测试分别记录通过、失败、跳过和终态，不能合并成一个不区分层次的测试数字。
- Windows 修复与打包／SDK 变更的独立提交；不存在为了抽取便利而引入的实验 Core 依赖。

合并门槛：S1 的官方兼容与 V1 的真实生命周期通过；拟纳入的 S2／S3／S4 通过各自验收；独立审查无未解决的阻断问题。S4 延期本身不阻止其余部分合并，但必须使用并说明显式 Packs 部署路径。

main 的 Core／插件候选版本在发布准备时选择未使用的新版本，并同步 package、manifest、CORE_RUNTIME 和 artifact。保留 main 的能力集合，不能因借用实验分支的 `0.8.8` 号码而暗示已实现动态工作流；若该号码已用于不同候选，选择下一个未使用版本。Packs 内容与版本在本计划中不变。

本计划不要求继续完善被淘汰分支，也不把此前已经投入的开发成本当作合并理由。只为 main 的官方兼容、可复现构建和明确独立缺陷支付后续成本。
