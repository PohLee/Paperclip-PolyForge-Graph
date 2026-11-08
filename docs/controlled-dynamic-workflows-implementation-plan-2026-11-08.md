# PolyForge 受控动态执行与 Principal 改进闭环：五阶段实施计划

状态：待实施。本文记录实施范围、依赖和验收门槛，不代表功能已经完成。

阅读路径：第 5–9 节是五阶段任务；第 12 节给出拟实现的数据、接口和事务契约；第 13 节给出对应的 Given／When／Then BDD 验收规格。新增类型、命令和错误码均为设计提案，不是对当前 0.8.7 API 的描述。

编写日期：2026-11-08。讨论来源：[PolyForge动态工作流](https://chatgpt.com/c/6aed8949-1b70-83ec-997f-17e2ea055107)、[分析文章影响改进](https://chatgpt.com/c/6aefaadc-9978-83ec-bebb-f0a6e7ecd492)，以及本次对开发阶段、调度配置和 Paperclip Routines 的确认。

## 1. 基线与实施前提

已通过 GitHub 读取两个仓库的远端 `main`，并核对本地提交与工作区。以下是本计划编写时的固定基线；实施开始时若 main 前进，先检查差异并更新此表，不能继续假定旧聊天中的 0.8.6 是当前版本。

| 仓库／依赖 | 基线 | 说明 |
| --- | --- | --- |
| Core／Paperclip plugin | [`b22fdb97b34474a066c5ad330195a3611043a934`](https://github.com/PohLee/Paperclip-PolyForge-Graph/commit/b22fdb97b34474a066c5ad330195a3611043a934)，Core `0.8.7` | 本地 main 与远端一致，开始编写时工作区干净 |
| Packs | [`6ad0652828b3075b72e457e2afa1b0807dcd929e`](https://github.com/PohLee/Paperclip-PolyForge-Graph-Packs/commit/6ad0652828b3075b72e457e2afa1b0807dcd929e) | ADLC `0.3.2`、Marketing `0.0.4`、Creative Team `0.3.1`；本地与远端一致 |
| Paperclip SDK／开发 Host | SDK `2026.1023.0`；Compose 固定 Host `2026.1023.0` | SDK 声明可作为接口依据；实际 Host 行为仍须集成测试 |

项目尚未在生产运行，没有需要迁移的旧业务数据。允许同步修改 Core、Pack、Host 适配器、UI、schema 和开发测试夹具；不建设旧协议双轨、历史数据迁移或生产灰度方案。开发数据库若需重建，仅操作明确的可丢弃测试实例。

仍须保留版本不可变、运行快照、审计、并发校验和恢复语义：这些是新系统自身的正确性要求，不是历史兼容负担。已经发布的同一 `id@version` 不覆盖修改；新的协议使用新的版本。

本文基于源码和接口检查，没有重新执行构建、测试或真实 Routines。下文所有验收项均为实施时需要完成的工作。

## 2. 已确认的范围与边界

1. PolyForge 保持现有定位：以 Core、Domain Packs、可信 Host 执行工作契约与治理。
2. 允许已批准定义内的条件选择、并行、`foreach`、汇合、受限返工、Tool 执行和固定版本子 Workflow 调用。
3. Runtime Agent 不得修改 Graph、gate、验收标准或替其他角色批准。Planner 只能调用获准且适用的已发布 Workflow，组织层级本身不授予该权限。
4. Principal Agentic Engineer 可提出 Graph、Skill、Agent 文档、rubric 和检查规则的具体变更；必须经人工批准后发布，不能自行批准或直接修改正在运行的任务。
5. 不实现运行时任意生成 Graph 的准入入口，也不把任意 AI 生成计划接入 Work Plan。既有 Work Plan 继续组织注册过的 Workflow。
6. Retro 和改进提案分别设置自动调度，默认每日 Retro、每周提案；频率、执行时间、时区和启停可调整。关闭自动调度后仍能手动触发，开启时也能手动触发。
7. **自动调度唯一由 Paperclip Routines 负责。** PolyForge 提供 Workflow 入口、权限校验、去重、执行和证据；不使用自建 cron、轮询、`setInterval` 或 plugin jobs 另做同一业务调度。
8. 当前不建设通用部署平台。对实际接入的外部动作实现回执、幂等与未知结果核对；未接入的 merge／deploy 不宣称已执行或已验证。

### 2.1 职责划分

| 层 | 负责 | 不应承担 |
| --- | --- | --- |
| Core | 定义验证、实例状态、准入、证据身份、gate、预算、失效与修订 | 直接调用模型／工具、维护每日每周调度 |
| Pack | 领域 Workflow、适用性和验证规则、角色与技能、retro／提案模板 | 通过数据声明自行安装或授权可执行代码 |
| 可信 Host adapter | 验证真实身份、执行工具／Agent、采集回执、持久化派发与恢复 | 将模型自报当作外部事实，绕过 Core 的状态转换 |
| Paperclip Routines | 自动触发时刻、时区、启停、调度运行记录 | 自动授予 Graph 修改或发布权限 |
| PolyForge UI | 展示真实状态、证据、Routine 配置入口、人工决定和手动执行 | 保存另一套独立调度状态，伪装不支持的取消能力 |

## 3. 相对最新 main 的增量

| 最新实现已经提供 | 本计划复用位置 | 仍需增加 |
| --- | --- | --- |
| `task / decision / join / end`、`edge.when` 标签路由、静态并行、ALL-join | `src/core/engine.mjs`、`index.d.mts`、`contract.md` | 受限条件表达式、执行器契约、实例化与未执行原因 |
| 版本化产物、候选引用、验收覆盖、交付 head／review／approval 检查 | `src/core/evidence-contracts.mjs`、ADLC 工程 Graph | 统一候选与政策身份、可信回执、合并组合、影响失效 |
| delivery 预算、有限返工、持久化派发预约 | `delivery-limits.mjs`、`dispatch-admission.mjs`、`dispatch.mjs` | item／子流程继承、重试分类、外部操作账本 |
| 0.8.7 可信 Pack adapter 与 exact Pack／bundle digest 绑定 | `pack-host-support.mjs`、`trusted-pack-adapters.mjs`、`scripts/build.mjs` | 新执行模型接入同一边界；不另建绕过 adapter 的路径 |
| 运行重验证、`expectedRunDigest` 并发围栏、`hostValidationId` | `pack-runtime-recovery*.mjs`、`engine.mjs`、migrations 014/015 | 扩展到 item、子流程、修订及新证据模型 |
| intervention／improvement ledger | `src/core/intervention-ledger.mjs` | 跨 run 事实汇总、Agent 提案、独立人审与发布依赖 |
| 基本评估场景和 Host runner | `eval/golden-scenarios.json`、`src/host/check-runner.mjs` | reviewer 真值集、误报／漏检／有害建议及成本指标 |
| SDK 有 `routines.managed.get/reconcile/reset/update/run` | SDK `dist/protocol.d.ts`、`dist/host-client-factory.d.ts` | manifest 能力与声明、触发桥接、原生设置集成、实际 Host 验证 |

注意：当前 SDK 的 `routines.managed.update` 参数只包含 `routineKey`、`companyId` 和 `status`，不能假设它能直接修改 cron／timezone。Shared Routine 类型包含 trigger 的 `enabled`、`cronExpression` 和 `timezone`，但这不等于插件已拥有修改它们的接口。Phase 1 必须验证原生设置或受支持 API 的实际路径。

## 4. 阶段总览

| Phase | 可验收交付 | 前置依赖 | 风险 |
| --- | --- | --- | --- |
| 1 | 统一契约、权限、证据与恢复基础；完成 Routines 接口验证 | 最新 main | 高：基础语义错误会扩大后续返工 |
| 2 | 条件 + 单层 `foreach` + 逐项证据／汇合的完整动态流程 | Phase 1 | 高：实例状态、并发和完整性 |
| 3 | Tool／子 Workflow／Planner + Findings + Judge／评估 | Phase 2；评估样本可提前收集 | 高：执行权限和父子生命周期 |
| 4 | Paperclip Routines 驱动的 Retro／Principal 人审发布闭环 | Phase 1 的 Routines 验证，Phase 2/3 执行能力 | 中高：调度重复、提案质量和批准绑定 |
| 5 | 正式任务修订、跨能力恢复验证与开发交付验收 | Phase 1–4 | 高：在途任务和证据失效 |

主执行链：Phase 1 → 2 → 3 → 4 → 5。运行事件从 Phase 1 开始采集，不能等 Principal 上线再补。每阶段内按任务编号顺序提交可运行的增量；不先合入空接口后长期绕过验证。

## 5. Phase 1 — 统一契约、权限、证据与恢复基础

### 目标

建立一个能够确定“谁可以执行什么、检查了哪个版本、为什么允许推进、失败后如何恢复”的共同模型。复用 0.8.7 的可信 adapter 和运行摘要围栏。

### 实施任务

- [ ] **P1-01：固定契约与状态转换。** 在 `contract.md`、`index.d.mts` 明确定义任务执行器 `agent/tool/workflow` 与控制操作的关系。条件路由不授予批准权。定义节点模板身份与运行实例身份，为 item、子流程和修订预留显式字段；不继续依赖任意附加字段表达核心语义。
- [ ] **P1-02：实现准入与最低验证要求。** Pack 声明 Workflow 适用性、允许输入和必需控制；Core／Host 根据可信变更范围及政策计算 `requiredControls`。调用者不能用 `skipValidation`、自报低风险、选较弱流程或换角色移除必需控制。实现结束后再次核对实际变更范围。保留现有 manual／assisted／autonomous 模式，受保护控制在三种模式下都有效。
- [ ] **P1-03：统一候选、证据和批准引用。** 补齐候选的 repository、base/head、代码快照／组合身份、需求版本；证据绑定检查定义、执行器、来源、状态和候选；批准绑定候选、政策、动作与范围。已有产物身份可以被引用，不建立互相矛盾的平行账本。当前候选变更后旧证据仍可查询，但不能直接满足新 gate。
- [ ] **P1-04：实现确定性 Gate。** 分开 review assessment、verification evidence 和 gate decision。定义通过、返工、等待人工、需要重新规划、阻塞等结果；区分检查失败、工具错误、未运行、未知、不适用。硬条件失败不能被高分抵消。人工例外单独记载，不能把未验证改成测试通过。
- [ ] **P1-05：补齐恢复和预算。** 复用 delivery ledger 与 dispatch reservation；增加工具重试与语义返工的独立计数。外部操作使用稳定业务操作 ID，保存请求、回执及 confirmed-success／confirmed-failure／unknown；unknown 先查询核对，没有查询能力时阻塞等待处理。超时不自动证明动作未发生。
- [ ] **P1-06：保护批准依赖。** 运行绑定 Workflow／Pack、规则、rubric、Skill、Agent 文档及配置摘要、executor／adapter、模型配置身份。延续 exact Pack／bundle digest 校验和 `expectedRunDigest`；规则本身的修改按现行规则审查。文件变更不能在恢复时静默改变运行行为。
- [ ] **P1-07：建立事件与指标最小数据集。** 每个完成、失败、阻塞、返工、批准、外部动作记录 company/project/delivery/run/node/instance/attempt、版本和证据引用。将系统事实、Agent 解释、建议分开。记录执行时间、人工介入与成本来源；缺失费用标 unknown，不计为零。不逐 token 保存 Agent 内部过程。
- [ ] **P1-08：验证 Routines 集成路径。** 在固定 Host 上证明 managed routine 创建／复用、原生修改频率与时区、停用自动 trigger、手动执行及可追溯触发身份。确认 Routine 到 issue／Agent invocation 再到 Graph start 的真实链路；不能假设 Routine 能直接调用任意 plugin endpoint。记录鉴权、跨公司隔离、catch-up 和并发策略。若 SDK 不能编辑频率，通过 PolyForge 设置中的原生 Routine 入口完成；若 Host 缺少能力，明确需要的 Host／SDK 更新，禁止用自建调度器替代。

### 主要改动位置

- Core：`src/core/engine.mjs`、`evidence-contracts.mjs`、`delivery-limits.mjs`、`compatibility.mjs`、`index.mjs`、`index.d.mts`、`contract.md`。
- Host：`src/plugin/pack-host-support.mjs`、`pack-runtime-recovery.mjs`、`pack-runtime-recovery-store.mjs`、`dispatch*.mjs`、`store.mjs`、`worker.mjs`、`readiness.mjs`、`migrations/`。
- Pack：Packs 仓库 `packs/adlc/engineering-graphs.mjs`、`architecture-delivery-graphs.mjs`、`runtime/host-api.mjs` 与相关证据文档。同步检查 Marketing／Creative 的新协议适配。
- 新的准入、证据／动作账本模块按边界拆出，不把全部逻辑继续放进 `engine.mjs` 或 `worker.mjs`。

### 完成门槛

- [ ] C1 的迟到报告／批准无法推进 C2；目标 base 前进时重新核对被验证组合。
- [ ] 小参数修改仍满足政策要求的验证；无 findings 但没有执行必要检查时不能通过。
- [ ] 同时修改代码和审核政策的候选仍受现行政策约束；组织上级不能越权豁免。
- [ ] 换 Agent、重启、另建相关 run 不清空 delivery 预算；检查失败不能伪装为工具重试。
- [ ] 外部动作请求后崩溃且结果未知时不盲目重放；并发重复提交只产生一次效果。
- [ ] 0.8.7 的 trusted adapter、跨公司隔离和 stale host-validation 回归仍通过。
- [ ] Routines 接口验证有可复现记录，明确频率编辑路径、停用后手动运行行为及触发来源。

**风险控制：** 不承担旧数据迁移；集中处理状态语义和并发原子性。不能因为开发环境可重置就跳过重启恢复测试。

## 6. Phase 2 — 条件执行与一等 foreach

### 目标

交付“发现清单 → 分配逐项任务 → 独立证据 → 汇合 → 验收”的真实流程。首版支持单层、有限数量展开；不同时引入任意嵌套和自由循环。

### 实施任务

- [ ] **P2-01：受限条件表达式。** 支持引用允许的输入／已完成前序结果、比较、存在性、布尔组合；明确缺失、类型不符及 unknown 规则。禁止任意 JavaScript、网络访问或条件求值时调用模型。保存表达式版本、输入摘要、结果及原因，状态查询和恢复不重复评估外部模型。
- [ ] **P2-02：分支与汇合状态。** 记录 `not_selected` 和经证据证明的 `not_applicable`，并与 blocked／failed／cancelled 区分。ALL-join 根据冻结的激活分支集合等待；未知分支不被当作未选择。UI 展示未执行原因、证据和待完成集合。
- [ ] **P2-03：冻结展开清单。** 输入 manifest 包含版本、来源、稳定 item ID、输入引用和覆盖范围。验证上限、重复 ID、空集合及清单来源；空集合只有政策允许且来源完整性可证实时才可完成。执行中清单修改进入 Phase 5 的修订流程，不原地扩写已冻结清单。
- [ ] **P2-04：逐项状态与派发。** 增加 instance/item/attempt 身份、独立输入、产物与证据、持久化 claim 和恢复。逐项重试保留已成功项；item 间不能串用回执。并发、运行总数、时间和费用限制继承 delivery，并计入已有 dispatch slot。
- [ ] **P2-05：汇合与失败策略。** 首版必需项全部成功才接受；允许逐项重试或停止整个展开。提前停止要区分未派发、仍在运行和结果不再接纳。部分结果只作为不完整产物，不能伪装完成。清单覆盖按身份核对，不仅比较数量。
- [ ] **P2-06：完成动态示例和负载测量。** 添加模块分析示例 Graph、逐项视图和验收脚本。测试 0、1、重复项、37 项、上限及上限+1；测量多 worker 下 CAS 冲突、状态体积、延迟和恢复效果。只有测量表明整份 JSON 状态写入成为瓶颈时，再拆出 item／事件记录，不先重写全部存储。

### 主要改动位置

`src/core/engine.mjs`、`index.d.mts`、`contract.md`；新增受限条件与展开模块；`src/plugin/dispatch.mjs`、`dispatch-admission.mjs`、`store.mjs`、`ui-graph.jsx`、`graph-layout.mjs`；`examples/`、`tests/core/`、`tests/e2e/`，及 Packs 的示例／工程流程。

### 完成门槛

- [ ] 37 项中一项失败时整体不能完成；重试该项不重跑其余成功项。
- [ ] 关闭 worker 后恢复，不重复展开或丢失 item；晚到的旧 attempt 结果不能推进新 attempt。
- [ ] 不同分支组合、未选择分支、unknown 和空集合都得到正确的 join 结果。
- [ ] 并发 slot、delivery 预算和逐项证据在真实 PostgreSQL 下通过竞争测试。
- [ ] 有一条真实 Agent 示例提供全部 manifest 项的可核对产物；deterministic fixture 与真实模型结果分别记录。

**风险控制：** `foreach` 风险来自状态与完整性，不能仅在某个 Agent 内部启动多个子任务后对 Core 返回一个 success。原生 Host 不支持强制取消时必须如实显示在途执行，不能释放物理容量后误称已停止。

## 7. Phase 3 — 执行器、Planner 与可评估审查

### 目标

让动态任务能够通过可信 Tool、固定版本子 Workflow 和授权 Planner 执行，并使审查／模型判断可核实、可停止、可评估。

### 实施任务

- [ ] **P3-01：注册执行器。** 为 Tool／Agent／Workflow 声明版本、输入输出 schema、权限范围、执行／测试能力、回执、查询、重试和取消能力。远端 Pack JSON 只引用已安装的可信能力，不能携带任意命令获得执行权。缺少能力时 readiness 明确阻塞。
- [ ] **P3-02：子 Workflow 调用。** 实现固定版本的 call-and-wait 与独立 trigger。父子关联、调用输入、结果证据和预算持久化；限制深度、循环调用和总展开数。等待模式依据子 run 的真实终态与当前版本证据完成，独立触发不提供父任务的验收证明。
- [ ] **P3-03：Planner 准入。** 暴露注册流程调用入口，校验任务范围、Workflow 适用性、角色、输入、继承控制和项目／公司边界。区分请求动作、批准动作和执行动作；接收委派的工具／Agent 再次核验授权。继续复用 Work Plan 管理已注册流程。
- [ ] **P3-04：Finding 生命周期。** 实现稳定 ID、根因与触发条件、候选、严重性、依据、处置和修复验证。保留原始 finding，支持关联／去重／重新打开。先用独立 reviewer + 按需 verifier；增量复审覆盖 delta、原问题和受影响接口，不把作者接受建议当作真值。
- [ ] **P3-05：建立 reviewer／Judge 评估集。** 扩展 `eval/`：历史缺陷、正确改动、有害修复建议、权限／幂等／证据错配案例。隐藏答案；区分模型判断、静态确认、路径分析和真实复现。记录经确认误报、漏检、修复伤害、轮次、人工耗时和成本，按风险类型分组。
- [ ] **P3-06：接入 Judge／Jev 能力。** 实现 provider-neutral 评估执行器及选定 provider adapter。真实接入前核实其当时接口和能力。保存模型、rubric、输入版本、原始结果和阈值规则；结果先落盘，条件再读取。失败／过期／矛盾结果为 unknown；同一输入重评需有理由，不能抽样直到通过。Scorer 提供质量维度，Verdict 按政策综合，必需 gate 不能被分数抵消。
- [ ] **P3-07：更新领域流程与审查指导。** ADLC Design 固定验收和验证计划，Implementation 形成集成候选，Verification 针对同一候选核验。把可机械检查的反复问题落实到测试／runtime invariant；语义判断保留在 reviewer guidance。各 harness 明确是否执行 hooks、测试及脚本。

### 主要改动位置

Core 的准入／实例模块与 `company-control.mjs`、`work-plan.mjs`；Host 的 `pack-host-support.mjs`、`trusted-pack-adapters.mjs`、`worker.mjs`、`review-context.mjs`、`src/host/`；Packs 的 ADLC engineering／design-assurance graphs、`runtime/host-api.mjs`、roles／skills；`eval/` 与现有 evidence／host-validation 测试。

### 完成门槛

- [ ] 子 Workflow 错误、暂停、未知结果和过期证据不能让父任务提前成功；重复触发不重复建立相同子 run。
- [ ] 子流程不能重置预算或扩大权限；Planner 不能通过较弱流程规避必需验证。
- [ ] Tool 回执确实来自可信执行器，模仿回执字段的 Agent 输出不能代替。
- [ ] Finding 修复有当前候选证据；同一根因不会无限制造重复返工，复发问题可重开。
- [ ] provider 不可用时不伪造评估成功；模型变更可重跑评估并输出可比较结果。
- [ ] 至少一条真实 Tool + 子 Workflow 集成路径完成；Judge 如未获得实际 provider 运行证据，明确列为未验收，不以 mock 代替。

**风险控制：** 先使确定性流程可运行，再接入模型判断。通用模型输出只能作为规则输入，不能兼任批准身份。

## 8. Phase 4 — Paperclip Routines 与 Principal 闭环

### 目标

交付可配置、可停用、可手动触发的每日 Retro 与每周提案，并将具体变更送到人审与版本发布流程。

### 调度产品契约

| 配置／行为 | Retro | 改进提案 |
| --- | --- | --- |
| 默认自动调度 | 每日一次 | 每周一次 |
| 可调整 | 执行间隔／周期、时间、时区、自动开关 | 执行间隔／周期、时间、时区、自动开关 |
| 调度事实来源 | 对应 Paperclip Routine／trigger | 对应 Paperclip Routine／trigger |
| 手动入口 | 随时执行一次，可选时间范围 | 随时基于指定范围／记录生成一次提案 |
| 自动关闭后 | 不再自动发起；手动仍可用 | 不再自动发起；手动仍可用 |
| 关闭对在途任务影响 | 不自动取消已有任务 | 不自动取消已有任务 |

两个开关独立。设置页显示实际下一次执行时间、时区、上次结果与 readiness；不要只展示本地保存的期望值。具体初始时刻在首次设置时展示并允许调整；缺失公司时区时明确要求设置，不静默采用服务器时区。频率编辑优先使用验证过的原生 Routine 设置入口；只有接口支持时才内嵌编辑。

### 实施任务

- [ ] **P4-01：创建跨 Pack 的改进领域包。** 建议在 Packs 仓库新增 `packs/agentic-improvement/`，包含 Principal 角色、Retro／提案／人审流程、skills 与 schema。这是实施结构建议：该包分析不同领域执行证据，避免把公司级改进强耦合进 ADLC。将其注册到 catalog、构建、manifest 和可信 adapter 链路。
- [ ] **P4-02：管理两条 Routine。** 在 plugin manifest 声明 `routines.managed` 能力及两条稳定 routine key（建议 `polyforge:retro`、`polyforge:improvement-proposal`）。按公司 reconcile，保存关联 ID；重复安装／配置不创建重复 Routine，不 reset 用户已调整的调度。新建时默认启用每日／每周自动 trigger，但 Agent、预算或 Pack 不可用时显示 setup/readiness 阻塞，不绕过现有零预算与暂停默认值。
- [ ] **P4-03：实现可信触发桥接。** 按 Phase 1 验证的 Routine → issue／Agent invocation → Graph start 链路执行。Host 验证实际 Routine/run 来源及公司关系，记录 source、routine/run ID、周期窗口、触发者和 Graph run。Routine 触发本身不提升为 human-owner。禁止使用 plugin `jobs.schedule` 代替这两条业务 Routine；现有无关基础设施 jobs 不因此删除。
- [ ] **P4-04：配置和手动入口。** PolyForge 设置页读取原生 Routine 状态，提供频率／时区设置入口、独立启停、上次结果和立即执行。关闭自动应停用 schedule trigger；先验证是否允许继续 `managed.run`。如当前 Host 的停用状态禁止手动执行，手动按钮走同一个经授权的 Workflow 启动服务并记录 manual 来源，不能为了执行一次而重新开启自动调度。
- [ ] **P4-05：去重与重叠处理。** 传输重试按原生触发 ID 去重；同一公司、流程类型、窗口和在途工作按持久化执行锁合并，返回已有任务。人工指定新范围／新证据可创建新请求；相同已完成提案根据证据集合与问题身份判重。自动触发与手动触发重叠时不启动第二套相同工作；手动执行不移动下一次定时触发。missed-run/catch-up 策略由原生 Routine 执行并在 UI 说明。
- [ ] **P4-06：每日 Retro。** 冻结统计窗口和参与 Agent／任务清单；所有该窗口内有工作的 Agent 生成有来源的总结，无工作者记无活动，缺席／失败者记覆盖缺口。通过 foreach 汇总 blockers、失败、返工、人工纠正、检查和成本，系统事件为事实基础，不只采信 Agent 自述。未完成 Retro 不伪装完整。
- [ ] **P4-07：每周 Principal 提案。** 读取 Retro 和原始事件，合并重复问题；外部研究记录来源、版本和适用性。每份提案包含问题证据、根因假设、具体 diff、必需验证变化、评估结果、收益／成本、依赖摘要、发布及撤回方案。无足够材料输出 insufficient-evidence，无必要改进输出 no-change；不为满足周期强行产生修改。自动 Retro 关闭时允许引用已有记录，并明确覆盖范围与新鲜度。
- [ ] **P4-08：人审与版本发布。** 分离 Agent proposal 权限与 human approval／release 权限，扩展 intervention ledger 而非移除全部身份限制。批准绑定具体 diff、依赖摘要与评估报告；批准后内容变化必须重新批准。发布前再次比对批准内容与构建产物。Graph、Skill、Agent 文档、rubric 或 adapter 变化全部进入发布清单，新 run 使用新版本，已有 run 不热替换。按 0.8.7 exact adapter 机制重建／验证 Core bundle 与 Pack 配对，不能仅导入新 Pack JSON 就宣称可执行。

### 主要改动位置

`src/plugin/manifest.mjs`、`company-api.mjs`、`worker.mjs`、`ui-settings.jsx`、`ui-company.jsx`、`readiness.mjs`；新增 Routine bridge 和改进流程读模型；`src/core/intervention-ledger.mjs` 与审计／批准边界；Packs 新包、catalog、构建脚本、可信 adapter 和兼容性测试。角色／Skill 文档与运行权限同步交付。

### 完成门槛

- [ ] 新公司完成配置后有且仅有两条对应 Routine，默认每日／每周；重新 reconcile 不覆盖用户频率。
- [ ] 在原生设置修改周期、时区或开关后，PolyForge 展示同一真实配置；没有第二份调度事实来源。
- [ ] 分别关闭两个自动 trigger 后均无新自动运行，手动按钮仍能执行；不改变下一次定时计划、不取消在途任务。
- [ ] 定时与手动竞争、重复回调、worker 重启仅产生一次相同逻辑工作；跨公司触发被拒绝。
- [ ] Retro 参与 Agent 覆盖可核对；缺日志、失败 Agent、无活动和无改进均明确区分。
- [ ] Principal 只能提案；伪造人工身份、无批准发布、批准后改文件／rubric／Pack 均被拒绝。
- [ ] 使用真实 Paperclip Routine 完成一次触发到 Graph 的链路，并记录 native routine run 与 Graph run 的关联。
- [ ] 至少一次提案经评估、人审、生成新版本后，由新 run 使用；旧运行依赖保持固定。

**风险控制：** 调度本身风险低于发布授权。先核实原生行为，避免把关闭 Routine、关闭自动 trigger 与取消在途执行当成同一操作。调度可用不等于 Principal 已获批准权。

## 9. Phase 5 — 正式任务修订与整体验收

### 目标

在已批准规则内处理执行中新事实，正确识别受影响证据、在途操作和预算；完成五阶段共同的真实端到端验收。

### 实施任务

- [ ] **P5-01：任务修订记录。** 增加 revision ID、前后输入／范围／manifest、原因、事实来源、提出者与授权记录。修订可以调整任务范围、目标候选及输入；改变 Graph、gate、验收政策或依赖规则仍交由 Principal 发布流程。
- [ ] **P5-02：影响分析与失效。** 计算受影响节点、item、子 run、证据和批准；先采用保守失效策略，未证明可复用的结果重新验证。保留历史 attempt 和审批，不覆盖原记录。预算继续归属原 delivery，重规划不能获得新额度。
- [ ] **P5-03：在途操作围栏。** 修订先阻止受影响的新派发，再按 revision／attempt 拒绝旧回调。已执行外部动作进行状态核对，不能当作尚未执行；不支持原生取消的执行保持可见。必须换 Workflow 定义时显式停止／关联新 run，并记录已发生副作用与继承预算，不原地修改运行快照。
- [ ] **P5-04：修订 UI 与人工决定。** 显示具体范围 diff、失效清单、可保留结果、待核对动作与剩余预算。只有政策授权的人／角色可以应用修订；修改验收标准走单独治理变更。
- [ ] **P5-05：跨阶段验收与版本交付。** 更新 Core／所有受影响 Pack 的版本及 capability 声明，重新生成可信 adapter bundle 和 runtime artifact，完成 schema／类型／文档一致性检查。执行基础流程、动态流程、Routine 改进闭环及修订恢复的集成测试，保存版本与摘要匹配的验收记录。

### 主要改动位置

Core 的实例／失效／准入模块、`engine.mjs`、`work-plan.mjs`、`company-control.mjs`；Host 的派发、运行校验、动作回执及 UI；Packs 的修订契约、工程流程和改进流程；`scripts/runtime-artifact.mjs`、`scripts/build.mjs`、Packs 构建与兼容性脚本。

### 完成门槛

- [ ] 从一个模块扩展到多个模块形成新修订；旧清单覆盖证据不自动证明新范围完成。
- [ ] 修订后旧 item／子 run 回调不能推进新修订；未受影响结果只有满足可复用规则才保留。
- [ ] 已发生的外部动作保留记录并完成核对；换 run／重规划不清空预算。
- [ ] 删除独立 review 或降低验收要求的请求被识别为治理变更，不能通过普通任务修订完成。
- [ ] 完整流程通过：需求与验证计划 → 条件／foreach → Tool／子流程 → 独立验证 → gate → Retro → 人审提案 → 新版本运行。
- [ ] 全部必需用例有真实结果，失败、跳过、缺 provider 和未验证项目均明确列出，不以“总测试通过”掩盖集成缺口。

**风险控制：** 正式修订是最高风险部分之一，因此最后实施。开发环境不需要旧数据迁移，但运行期间仍会出现旧证据和在途副作用，必须处理。

## 10. 测试与交付要求

### 10.1 每阶段的执行方式

1. 将任务编号与改动文件、测试场景关联；相关 Core／Pack 接口同步提交，保持可运行。
2. 对状态、授权、并发和外部副作用使用公共接口级正反用例，不只测试内部辅助函数。
3. 通过定向测试后再跑相关完整套件；只在新增改动或失败需要时重复扩大测试。
4. 每阶段输出一份验收记录：提交 SHA、Core／Pack／adapter 摘要、测试命令、通过／失败／跳过数、真实 Host／provider 证据、未完成项和下一阶段前置条件。
5. 不要求兼容历史开发数据库；要求从干净数据库初始化成功，并能恢复本阶段自身产生的运行状态。

### 10.2 已存在的测试／构建入口

在 Core 仓库使用 Node `>=24.11.0`；依赖需按 lockfile 安装。以下是现有命令，新增场景需接入这些套件或明确新增脚本：

```powershell
npm run test:core
npm run test:e2e
node --test tests/plugin/*.test.mjs
npm run build
git diff --check
```

`npm run build` 当前依赖相邻 `Paperclip-PolyForge-Graph-Packs` 源码并构建可信 adapter；构建和验收必须记录两个仓库的确切提交，不能仅记录 Core 版本。

PostgreSQL 验收复用 `tests/helpers/postgres-*.mjs`，显式设置 `POLYFORGE_RUN_POSTGRES_TESTS=1`、测试数据库连接和 `POLYFORGE_TEST_POSTGRES_MODULE`。例如现有恢复测试入口：

```powershell
node --test tests/e2e/pack-runtime-postgres.test.mjs tests/e2e/temporary-agent-postgres.test.mjs
```

未配置 PostgreSQL 导致的 skipped 不算持久化验收通过。新 foreach、Routine bridge 和修订的竞争场景也须纳入真实 PostgreSQL 测试。连接信息不写入计划或验收报告。

在 Packs 仓库运行 `npm run build:adlc`、`npm run build:marketing`、`npm run build:creative-team`，为新增 improvement Pack 增加相应构建入口。复用 `scripts/test-compatibility.mjs` 对固定 Core source artifact 执行全量行为测试：先用 `--print-digest true` 计算摘要，再指定 `--core-artifact`、`--core-digest`、`--core-version`、`--full-suite true`。运行前验证 fixture 与各包版本均指向本次候选。

真实 Host 使用现有开发 Docker 验收脚本模式，新增条件／foreach、子 Workflow、Routines 和修订场景。浏览器核对设置变更、未执行原因、逐项状态及人工批准对象。SDK mock、Core 单测、真实 PostgreSQL、真实 Host 和真实模型／工具证据分别报告。

### 10.3 必须覆盖的跨阶段反例

| 反例 | 预期结果 |
| --- | --- |
| Agent 称“只改一点”，选择较弱 Workflow | 准入或验收拒绝缺失的 required controls |
| 旧候选报告晚到、新 base 与旧 head 组合变化 | 旧证据不得错误授权新候选／组合 |
| 条件输出 unknown、空清单来源不完整 | 阻塞／保守路径，不视为全部完成 |
| foreach 一项失败，其他项完成 | 保留成功项，整体未验收，只重试授权项 |
| 子流程重启、换 Agent、再规划 | delivery 预算持续计量 |
| 工具请求后崩溃，是否执行未知 | 先核对外部状态，不盲目重发 |
| 定时与手动同时触发同一 Retro | 返回同一在途工作，保留各请求记录 |
| 自动 trigger 关闭 | 不产生新自动任务，手动入口仍可用 |
| 提案批准后修改 Skill、rubric 或 adapter | 原批准失效，重新评估与批准 |
| 任务修订时旧 execution 仍运行 | 在途可见，旧结果不能推进新修订 |

## 11. 范围控制与后续扩展

五阶段均以交付当前明确需求为目标，不承诺生产上线、自动部署或自主放宽治理。以下能力不阻塞本计划验收，待真实数据证明收益后另立任务：

- 任意层级 foreach、自由循环、运行时任意生成 Graph。
- 多 reviewer 集群、复杂自动 finding 聚类、跨候选精细证据复用。
- 根据事故自动收紧审批及自动恢复宽松策略；当前先记录必要事件和指标，宽松策略不能自行恢复。
- 通用部署／补偿平台、全局存储重构、每个 Agent 微步骤持久化。

风险评估不计生产停机、历史数据迁移和旧 Pack 双轨兼容。主要控制对象是状态与权限正确性、真实执行证据、实现复杂度和后续返工。完成每阶段门槛后再扩展下一阶段，避免出现多套互相冲突的准入、证据和恢复规则。

## 12. 技术设计细化

本节是实施起点。可以在实现中调整内部命名和文件划分，但不能削弱 BDD 描述的可观察行为。schema、命令、错误码最终写入 Core contract／类型与 Pack schema 后，以这些正式契约为准。

### 12.1 模块边界与唯一事实来源

| 拟新增模块 | 输入与输出 | 状态所有者／集成位置 |
| --- | --- | --- |
| `src/core/workflow-definition.mjs` | 验证定义、引用、允许输入和静态依赖，返回规范化定义与摘要 | 注册 Pack 时调用；不执行工具 |
| `src/core/workflow-admission.mjs` | 可信 actor/context、Workflow、父任务控制 → 准入结果及原因 | Core 转换前调用；Host 提供实际权限和变更观察 |
| `src/core/candidate-evidence.mjs` | 候选、证据、政策 → 适用证据、缺失项、失效原因 | 使用同一 Core State；不与现有 artifact ledger 各存一份事实 |
| `src/core/conditions.mjs` | AST + 冻结输入 → 三值结果、读取引用、原因 | 纯函数；结果由引擎原子保存 |
| `src/core/foreach.mjs` | manifest + 模板 → instance 集合、待执行项、汇合证明 | Core State；Host 仅领取已准入实例 |
| `src/core/workflow-invocation.mjs` | 固定版本调用、子 run 事件 → 调用关系／父节点可用结果 | 与现有 Work Plan／delivery 共享身份和授权 |
| `src/plugin/executor-registry.mjs` | 执行器 ID／版本 → 可信执行、查询和能力描述 | 仅注册可信本地 adapter；沿用 exact bundle digest |
| `src/plugin/routine-bridge.mjs` | 可信 Routine 或人工请求 → 唯一逻辑任务／已有任务 | 原生 Routine 管时间；Core 持有启动意图和去重关联 |
| `src/core/improvement-proposals.mjs` | 运行证据、提案版本、批准 → 提案生命周期 | 与 intervention／decision ledger 关联 |
| `src/core/task-revisions.mjs` | 当前任务、修订 diff → 影响集与新 revision | Core 原子提交；不调用外部执行器 |

以上文件名为建议。实际可以合并规模较小的模块，但每项事实只能有一个可写来源。跨存储的读模型可以缓存，不作为批准、预算或完成状态的权威。

### 12.2 身份、摘要和最小数据契约

使用现有 company／project／delivery／run 隔离边界。新增引用先定义为不可变对象，再在具体存储中选择 JSON 或专表。以下为 TypeScript 设计草案；实现必须有等价的运行时验证。

```ts
type Digest = string; // 规范格式 sha256:<64 hex>；复用并规范现有 canonical hashing
type VersionRef = { id: string; version: string; digest: Digest };
type Scope = { companyId: string; projectId: string; deliveryId: string };
type InstanceRef = {
  runId: string;
  taskRevision: number;
  nodeId: string;       // 定义里的模板 ID
  instanceId: string;   // 普通节点也有 instance ID
  itemId?: string;      // foreach 才存在
  manifestRef?: VersionRef;
};
type AttemptRef = InstanceRef & { attempt: number; phase: 'work' | 'review' };

type Candidate = Scope & {
  ref: VersionRef;
  requirementRef: VersionRef;
  artifactRefs: VersionRef[];
  code?: {
    repository: string;
    baseSha: string;
    headSha: string;
    treeDigest: Digest;
    validationTarget: 'head' | 'merge-combination';
    mergeCombinationDigest?: Digest;
  };
};
type ControlRequirement = {
  id: string;
  definitionRef: VersionRef;
  source: 'policy' | 'mode' | 'protected-scope' | 'inherited' | 'assessment';
  applicability: 'required' | 'not_applicable' | 'unknown';
  applicabilityEvidenceRefs: VersionRef[];
};
type CheckEvidence = {
  ref: VersionRef;
  subject: VersionRef;              // exact candidate
  controlRef: VersionRef;
  result: 'pass' | 'fail' | 'error' | 'not_run' | 'unknown';
  execution: AttemptRef;
  executorRef: VersionRef;
  observedAt: string;
  sourceReceiptRef: VersionRef;     // Host 验证过的来源；字段存在本身不证明真实
};
type Approval = {
  id: string;
  subject: VersionRef;
  policyRef: VersionRef;
  dependencyDigest: Digest;
  gateDecisionId: string;
  action: string;
  targetScope: Scope & { environment?: string };
  approvedBy: string;              // 从可信 human context 取得
  approvedAt: string;
  expiresAt?: string;
};
type GateDecision = {
  id: string;
  subject: VersionRef;
  policyRef: VersionRef;
  verdict: 'PASS' | 'REWORK' | 'WAIT_HUMAN' | 'NEEDS_REPLAN' | 'BLOCKED';
  usedEvidenceRefs: VersionRef[];
  missingControlIds: string[];
  reasons: { code: string; ref?: string }[];
};
```

约束：

- `instanceId` 由 run、taskRevision、nodeId、manifest 身份与 itemId 的规范元组决定；不采用数组下标或未转义字符串拼接。重试只增加 attempt，不改变该 revision 下的 instance 身份。
- 新 revision 的未受影响结果通过显式复用记录指向原证据，不伪造一份“新执行”。同一 itemId 携带不同输入摘要时不能当作同一已完成任务。
- `code` 对非代码产物可缺省；代码交付必须验证该字段。需要合并组合检查时 `mergeCombinationDigest` 必填；base 变化即使 head 不变也重新确定适用证据。
- 同一 ID／version 不允许更换内容摘要。对象键顺序规范化；数组顺序默认有语义，集合类字段先按契约规范排序。算法版本变化必须显式升级。
- `requiredControls` 取基础政策、运行模式、受保护范围、父级继承与附加评估的并集；模型不得删除已有控制。不适用必须有已批准规则和证据，不能以省略字段表达。
- `PASS` 表示必需技术条件已满足，不自动授予 merge／deploy／publish 权限。人工豁免保存独立的 exception authorization，保留原检查未通过状态；策略允许继续也不能改写为“全部检查通过”。
- 实际使用的 Skill／Agent 文档／模型配置必须匹配运行依赖清单。无法读取原始固定配置时阻塞或显式创建新版本，不读取最新文件后沿用旧摘要。

### 12.3 命令边界、错误与并发前置条件

下列名称是拟新增的应用服务命令；具体映射到现有 `graph`／`company-command` API，由实现时确定。它们不是新增 HTTP 路径的承诺。请求 body 不接受 actor、company 身份或可信 Routine 来源覆盖；这些来自 Host context。

| 命令 | 必需业务输入 | 授权／前置条件 | 返回或拒绝 |
| --- | --- | --- | --- |
| `admit-workflow` | workflowRef、目标范围、input、父任务引用 | Planner 或明确授权人；适用性、schema、父控制满足 | admission ID、requiredControls；或 `WORKFLOW_NOT_APPLICABLE` |
| `freeze-manifest` | node/instance、manifestRef、items、coverageReceipt | 获派执行者；当前 revision；来源可信、数量有效 | 冻结清单；或 `INVALID_MANIFEST` |
| `complete-instance` | AttemptRef、artifacts、evidence、receiptRefs | 当前 checkout／execution、attempt、revision、Host validation 匹配 | 已提交结果；或 `STALE_EXECUTION`／`UNTRUSTED_EVIDENCE` |
| `invoke-workflow` | parent AttemptRef、workflowRef、mode、input | 已准入；预算及递归深度允许 | invocation ID、childRunId／启动意图 |
| `request-improvement-run` | retro/proposal、window、范围、请求 ID | 手动用户授权，或 Host 验证的 Routine invocation | 新 run、已有 run，或启动中的 intent ID |
| `submit-improvement-proposal` | evidenceSetDigest、patchRef、dependencies、evaluationRefs | Principal proposal capability | 不可变 proposal version；不产生批准 |
| `approve-improvement` | proposalRef、releaseManifestDigest、评估引用、原因 | 授权人类；当前 proposal／评估摘要一致 | 绑定具体内容的 approval |
| `publish-approved-improvement` | proposalRef、approvalId、candidateReleaseRef | 已授权发布执行者；实际构建 bytes 与批准清单相符 | publication receipt；或 `APPROVAL_SUBJECT_MISMATCH` |
| `propose-task-revision` / `apply-task-revision` | baseRevision、diff、证据、预期影响摘要 | 提案权限与应用权限分离；不包含治理降级 | 新 revision／影响报告；或 `GOVERNANCE_CHANGE_REQUIRED` |

所有有副作用命令要求 `idempotencyKey`。处理顺序：验证可信身份与作用域 → 查找同作用域已提交的相同请求 → 读取当前状态并验证前置条件 → CAS 提交状态、决策、幂等结果及执行意图。相同 key、相同业务请求重放原结果；同 key 不同业务请求返回 `IDEMPOTENCY_CONFLICT`。`expectedRunDigest` 是并发前置条件，不计入业务请求指纹，沿用 0.8.7 已提交请求的重放语义。

执行状态不匹配返回 `STALE_EXECUTION`；纯并发摘要冲突返回 `STALE_RUN`，重新读取并验证后才能重试。失败的状态转换不留下半完成节点、虚假批准或预算消费；如需记录被拒请求，写独立诊断日志，不能改变 Graph 的验收状态。

### 12.4 执行意图、外部动作与预算的事务边界

**Core 转换与外部调用之间不做“假事务”。** 不能先调用工具，再仅靠最后一次写库证明安全。

1. 在一次 Core CAS 中保存通过准入的 invocation／operation intent、稳定业务操作 ID、预算预约、派发唯一键和事件。首次创建就关联 run、revision、instance、attempt。
2. Host 在合法 invocation scope 中领取意图，再通过可信执行器执行；沿用现有 dispatcher／recovery 入口，不在普通读取接口或裸 timer 发起外部写入。
3. 需要数据库派发槽时，使用现有原子预约机制。若意图和槽不能同事务提交，先提交意图，再幂等预约槽；恢复按持久化意图补齐，绝不能因某一步超时重建业务操作 ID。
4. 外部调用成功后写入回执，并以当前 revision／attempt／hostValidation 围栏提交结果。写回失败后先查询已有操作结果，不直接再次执行。
5. 工具不支持幂等或按业务 ID 查询时，结果未知必须停在核对状态。系统不承诺跨任意外部服务的 exactly-once；可保证的是持久化意图、重复请求抑制和不盲目重放。

| 操作状态 | 允许下一步 | 禁止行为 |
| --- | --- | --- |
| `prepared` | 领取并派发；取消尚未派发意图 | 未预约预算就执行 |
| `dispatching` | 绑定 Host execution／外部 request ID | 网络超时后认定未执行 |
| `unknown` | 查询、对账，或等待授权人工核对 | 直接生成新操作 ID 重试 |
| `confirmed_success` | 复用回执并完成当前有效实例 | 再次执行相同业务动作 |
| `confirmed_failure` | 政策允许时用稳定业务身份做有限工具重试 | 把测试失败当基础设施失败重跑到绿 |

语义返工产生新候选并消耗返工额度；同一操作的传输重试不重新计算业务动作次数，但实际工具执行次数和真实成本必须累计。预算申请与预约在 dispatch 前完成，结算按唯一回执计一次；未明结果的占用不随超时释放。若 provider 无可靠成本或强制停止能力，显示未知成本／无法强制终止，不宣称已实现绝对费用上限。

Graph 的“停止接受结果”和物理 execution 的“已经终止”分别记录。新增实例调度不能只因为 Graph stopped 就释放仍运行的物理占用；需 Host 终态或核对结果。此规则同样适用于 `foreach` fail-fast、子流程停止和任务修订。

实例状态至少分开两个维度：`executionStatus` 描述 pending／reserved／running／succeeded／failed／unknown／cancelled；`acceptanceStatus` 描述 pending／awaiting_self_review／awaiting_supervisor_review／accepted／rework_required／invalidated。这些是拟规范化字段，应与现有 `nodeStates.status` 集中映射，不由 Host 与 Core 各自推断。

| 事件 | 执行状态变化 | 验收状态变化／必要约束 |
| --- | --- | --- |
| 获得派发预约 | pending → reserved | 保持 pending，不视为已经执行 |
| 绑定真实 Host execution | reserved → running | 保持 pending |
| 提交有效产物／回执 | running → succeeded | 进入规定自审／独立审查，或经契约检查后 accepted |
| reviewer 要求修改 | 保留本 attempt 的执行终态 | rework_required；授权后建立下一 attempt |
| 调用超时且外部状态不明 | running → unknown | 阻塞验收与盲目重试 |
| 修订使结果失效 | 保留物理执行事实 | invalidated；旧成功不再证明当前任务完成 |
| 请求取消 | 仅记录 cancelRequestedAt | 确认取消前不声称 executionStatus 为 cancelled |

Condition 的 not_selected／not_applicable 是路径适用性结果，单独携带规则与证据；不能把它们混入 executionStatus 的 succeeded。UI 的“已完成”以 acceptanceStatus 为 accepted 且证据仍适用于当前 revision 为准。

### 12.5 条件、foreach 与子 Workflow 的具体语义

建议首版使用显式 AST，不执行表达式字符串：

```json
{
  "op": "all",
  "args": [
    { "op": "eq", "left": { "ref": "input.changeKind" }, "right": { "literal": "code" } },
    { "op": "eq", "left": { "ref": "nodes.assess.output.requiresSecurity" }, "right": { "literal": true } }
  ]
}
```

- 运算符首版限定 `eq/neq/gt/gte/lt/lte/exists/all/any/not`；不做字符串与数字隐式转换。引用仅访问白名单输入与当前 revision 已完成的前序结果，拒绝原型链与任意对象遍历。
- `all(false, unknown)=false`，`all(true, unknown)=unknown`；`any(true, unknown)=true`，`any(false, unknown)=unknown`；`not(unknown)=unknown`。`exists` 对已知完整对象中的缺键为 false，对上游尚未完成或来源不可信为 unknown。
- unknown 分支按发布策略等待事实、走已定义保守路径或升级；不得默认视为 false。保存 condition record 后，重复读取不产生新评估或外部调用。
- 首版 `foreach` 是控制节点，内部引用一个已批准 task 模板；每个 item 实例化该模板。复杂多步骤 item 由 Phase 3 的 workflow executor 表达，首版拒绝嵌套 foreach。
- manifest 包含 `sourceRef/sourceDigest/items[{itemId,inputRef}]/coverageReceipt`；`maxItems` 和 `maxConcurrent` 为有限正整数，上限由 Core 限制。首版的具体默认值在 Phase 2 负载试验后写入统一配置与测试，不散落硬编码。
- manifest 冻结和 instance 集合创建在同一 CAS 中完成；同摘要重放读取原集合，不同摘要不能更新冻结集合。空集合要求 `allowEmpty` 政策与可信完整性证明同时成立。
- 首版 foreach 必需 item 必须全部完成；不把 failed/cancelled 当完成。条件产生的 not-selected 分支可以不参与分支 join，但不能借此删除 foreach 清单中的必需 item。
- ALL-join 的预期集合来自已确认的分支选择与冻结 manifest；尚未确定的上游分支仍会阻止提前汇合。汇合证明列出每个 expected ID 及被采用的产物／证据版本，重复结果不增加完成数。
- 子 Workflow 调用键取父 instance、父 attempt、call-site；传输重试复用键，语义返工可创建新调用但继承同一 delivery 预算。父转换不得依据调用工具返回的 `success:true`，只依据子 run 的有效接受状态及满足调用契约的版本化交付。

### 12.6 Routines、Retro 与提案的执行契约

**原生配置是唯一事实来源。** 本地持久化 Routine ID、key、观察到的 revision 和运行关联；cron、时区、启停及下一次触发的本地副本仅为展示缓存。自动触发接纳前重新读取原生状态；停用后到达但尚未接纳的自动请求被拒绝，已接纳的运行继续。跨系统不存在原子关停时，UI 必须显示已接纳的在途任务。

```ts
type ImprovementRunRequest = {
  kind: 'retro' | 'proposal';
  scope: { companyId: string; projectIds: string[] };
  window: { startUtc: string; endUtc: string; timezone: string }; // [start, end)
  requestId: string;
  evidenceSnapshotDigest: string;
  workflowRef: VersionRef;
  // 来源和发起身份由 Host 构造，不信任请求 body。
  source: { kind: 'routine'; routineId: string; routineRunId: string }
        | { kind: 'manual'; humanActorId: string };
};
```

- 自动窗口使用原生触发时间／记录与配置时区计算已结束统计区间，不能用重试到达的当前时间移动窗口。manual 使用明确选择的区间；内部存 UTC 半开区间，展示保留时区。每周提案引用已结束的 Retro 区间；迟到事件作为后续补充材料，不改写旧摘要。
- **传输去重：** Routine 用可信 routineRunId，手动用认证用户 + requestId；同 ID 改输入拒绝。
- **在途互斥：** company + kind + 规范 project 集合 + window 唯一。定时／手动和不同 workflow 版本都不能在同一范围同时启动重复任务；返回当前工作及其固定版本。不同 scope／window 的工作还受公司预算／并发限制。
- **完成后判重：** 同证据集合和同流程版本返回已完成结果；显式新证据或新版本可以创建后续任务并关联前次结果。提案以问题根因／目标变更及证据集合关联历史，不能简单以自然语言标题判定重复。
- 关闭自动 Retro 不关闭提案；提案可读取已有记录并报告覆盖与新鲜度。手动执行不修改 Routine trigger 的状态或下次触发时间。原生重试／补跑和 DST 规则由 Paperclip 处理，bridge 只根据真实 invocation 去重，不维护补跑计时器。
- Retro 的分母是冻结的“窗口内有工作记录的 Agent／任务”清单。无活动、总结缺失、执行失败分别统计；覆盖不全可产出 partial 报告，但不得伪装 complete。提案是否允许采用 partial 报告由固定政策决定，并携带覆盖缺口。

提案生命周期建议为 `draft → evaluated → awaiting_human → approved → published`，另有 rejected／superseded。变更后的 diff 生成新 proposal version；已有 approved 版本保留审计，但不能授权新版发布。

`ReleaseManifest` 最少列出 proposalRef、各仓库 base/head、patchDigest、所有变更文件内容摘要、Pack／Workflow／Skill／Agent 文档／rubric／adapter 依赖、评估报告摘要和目标作用域。构建产物另有 actual digest 与构建来源回执。发布执行器验证两者对应关系；不得仅用人工填写的包版本字符串代替 bytes 校验。

### 12.7 修订与结果复用

`TaskRevision` 包含 `runId/baseRevision/newRevision/reason/sourceEvidence/diff/impactDigest/authorityDecisionId`。propose 阶段只生成影响报告；apply 阶段在 CAS 内重新计算并核对 impactDigest，原子替换 current revision、失效适用证据／批准、冻结新清单并围住旧派发。

首版结果复用条件为：输入摘要、依赖产物、候选／检查目标、control definition、执行器依赖和政策适用性全部不变，且没有已知失效事件。满足时写 `reuseRecord{fromEvidenceRef,toRevision,ruleRef,reason}`；任何一项未知则重新验证。执行历史保持不可变。

变更范围和治理变更分开校验；删除必需 review、降低验证政策或更换未批准 Workflow 不属于普通 revision。相关新 run 由可信 Host 继承 deliveryId，不接受 Agent 自填新 deliveryId 绕过预算。

### 12.8 BDD 落地约定

第 13 节是行为规格，当前尚未生成 `.feature` 或实现 step definitions。继续使用现有 `node:test`，不为存放规格引入 Cucumber 依赖。每条测试名包含场景 ID；Scenario Outline 的每一行是一个独立测试。

| BDD 集合 | 关联任务 | 建议测试位置（均为待实现） |
| --- | --- | --- |
| P1 | P1-01–P1-08 | `tests/core/workflow-admission.test.mjs`、`candidate-evidence.test.mjs`；扩展 `host-validation-fence.test.mjs`、Host receipt／恢复测试 |
| P2 | P2-01–P2-06 | `tests/core/conditions.test.mjs`、`foreach.test.mjs`；`tests/e2e/foreach-postgres.test.mjs` |
| P3 | P3-01–P3-07 | `tests/core/workflow-invocation.test.mjs`、`review-findings.test.mjs`；`tests/e2e/executor-host.test.mjs`、Judge adapter 测试 |
| P4 | P4-01–P4-08 | `tests/core/improvement-proposals.test.mjs`；`tests/e2e/routine-bridge.test.mjs`、`routine-postgres.test.mjs`；真实 Routine 验收脚本 |
| P5 | P5-01–P5-05 | `tests/core/task-revisions.test.mjs`；`tests/e2e/revision-recovery.test.mjs`；跨阶段真实 Host 验收 |

测试 fixture 统一使用 C1/C2、公司 A/B、revision 1/2、attempt 1/2、可信与伪造 actor；注入固定时钟。并发用 barrier 控制两个 worker 在读后／写前竞争，不靠 sleep 猜测时序。外部副作用测试分别记录 requestCount、effectCount、receiptCount，避免只断言“返回成功”。故障注入覆盖 intent 前后、外部响应前后、回执写入前后和重验证之后。

## 13. BDD 验收规格

采用 Gherkin 的英文关键字与中文业务描述。`@core` 可使用 MemoryStore；`@postgres` 必须使用真实 PostgreSQL；`@host` 必须验证 adapter 与鉴权；`@native` 必须调用真实 Paperclip；`@provider` 必须有真实执行器／模型回执。标签可组合，不能用低层 mock 的通过替代较高层验收。

### 13.1 Phase 1 — 治理、证据与恢复

```gherkin
Feature: P1 自动推进必须具有当前有效的证据和授权

  @P1 @core @host
  Scenario: BDD-P1-01 满足全部控制的候选可以进入获准下一步
    Given 公司 A 的 C1 固定需求、政策和执行依赖
    And 所有必需控制均有可信执行器针对 C1 提交的 pass 证据
    And 当前 actor 对下一步动作持有符合政策的有效授权
    When Core 计算 gate 并提交下一步转换
    Then 保存 verdict 为 PASS 的 GateDecision 及所用证据引用
    And 下一步只被派发一次且引用 C1 和该授权

  @P1 @core
  Scenario Outline: BDD-P1-02 自报低风险和模型高分不能代替必需检查
    Given 当前政策要求 C1 提供 regression 检查
    And 实现者称只是小参数修改且 reviewer 没有 findings
    And Scorer 给出最高质量分
    When regression 的状态为 "<status>" 时请求验收
    Then gate 不得为 PASS 且原因包含 regression 未满足
    And 不派发需要该 gate 的下一步
    Examples:
      | status  |
      | missing |
      | fail    |
      | error   |
      | not_run |
      | unknown |

  @P1 @core @host
  Scenario Outline: BDD-P1-03 验证目标变化后旧证据不能误放行
    Given 对 repository R、base B1、head H1 的 C1 已有报告和批准
    When "<change>" 后收到 C1 的迟到回执
    Then 保留旧回执作为历史但不用于当前目标的 gate 或批准
    And 返回当前目标需要重新满足的控制
    Examples:
      | change                                      |
      | 当前候选变成代码不同的 C2                    |
      | head 仍是 H1 但必需合并组合的 base 变成 B2    |

  @P1 @core @host
  Scenario: BDD-P1-04 修改审核政策的候选仍按现行政策审核
    Given 现行政策要求独立 review 和人工批准政策变更
    And 待审候选同时修改业务代码并删除该 review 规则
    When Planner 选择轻量 Workflow 并传入 skipValidation
    Then 准入拒绝该输入或不适用 Workflow
    And 该候选仍需满足现行独立 review 和人工批准要求
    And 不产生弱化后的授权记录

  @P1 @core @postgres
  Scenario: BDD-P1-05 已经完成 Host 重验证后拒绝旧验证上下文
    Given worker W1 持有运行摘要 D1 和 hostValidationId V1
    And worker W2 已完成重验证并提交 D2 和 V2
    When W1 用 D1 和 V1 提交候选或批准
    Then 返回 STALE_RUN 或 STALE_EXECUTION
    And 当前运行、批准和预算没有部分提交

  @P1 @core @postgres
  Scenario: BDD-P1-06 重试和重新规划不能重置 delivery 预算
    Given delivery D 的语义返工额度已经耗尽
    When worker 重启并改用另一个 Agent 或相关子 run 请求继续返工
    Then 请求仍使用 D 的原账本并被阻塞或升级
    And 测试 fail 不能被归类成工具超时获得额外重试
    And 不启动新的执行也不把耗尽解释成验收通过

  @P1 @host @postgres
  Scenario: BDD-P1-07 外部成功但回执写入前崩溃不会重复副作用
    Given 业务操作 O 已保存 intent 且外部执行器已经完成一次效果
    And worker 在回执提交前崩溃导致本地状态为 unknown
    When 恢复流程以 O 查询外部状态并得到可信成功回执
    Then 绑定已有回执并完成仍有效的实例
    And effectCount 为 1 且不生成替代 O 的新业务操作 ID

  @P1 @host
  Scenario: BDD-P1-08 未知结果无法查询时等待核对
    Given 操作 O 的请求超时且 provider 不支持幂等或结果查询
    When 请求自动恢复 O
    Then O 保持 unknown 并显示需要核对的原因
    And 不再次执行 O 且不释放尚未确认结束的物理占用

  @P1 @core @host
  Scenario: BDD-P1-09 身份与回执字段不能由请求者自证
    Given 公司 A 的 Agent 请求 body 声称自己是 human-owner
    And body 包含声称来自可信 runner 的成功回执
    When 它尝试批准公司 B 的任务
    Then 按 Host 的真实身份和公司作用域拒绝请求
    And 不接受伪造回执且不写入公司 B 的运行状态

  @P1 @core
  Scenario: BDD-P1-10 人工例外不会伪造验证通过
    Given 必需检查为 unknown 且政策允许授权人类为指定动作批准例外
    When 授权人类提交绑定 C1 和该动作的例外决定
    Then 原检查仍显示未验证且 gate 不被改写成全部检查 PASS
    And 只有政策明确覆盖的动作可依据独立例外授权继续
    And 其他候选或动作不能复用该例外
```

### 13.2 Phase 2 — 条件、展开与汇合

```gherkin
Feature: P2 动态展开保持可核对的覆盖范围与逐项执行身份

  @P2 @core
  Scenario Outline: BDD-P2-01 条件采用三值逻辑
    Given 条件输入已经冻结且包含 true、false 和 unknown
    When 计算 "<expression>"
    Then 保存条件结果 "<result>" 及输入引用
    And 计算过程不调用模型或工具
    Examples:
      | expression          | result  |
      | all(false, unknown) | false   |
      | all(true, unknown)  | unknown |
      | any(true, unknown)  | true    |
      | any(false, unknown) | unknown |
      | not(unknown)        | unknown |

  @P2 @core
  Scenario: BDD-P2-02 分支尚未确定时 ALL-join 不提前完成
    Given 分支 A 已完成且分支 B 的条件因证据缺失为 unknown
    When 查询可执行节点并尝试推进汇合
    Then 汇合仍被阻塞且 B 不被记作 not_selected
    When 可信证据使 B 的固定条件为 false
    Then 保存 B 的 not_selected 原因并可重新判断汇合
    And 再次查询读取已保存结果而不重复调用评估器

  @P2 @core
  Scenario Outline: BDD-P2-03 空清单必须同时满足政策和完整性证明
    Given manifest 的 items 为空
    And allowEmpty 为 "<allowed>" 且 coverageReceipt 为 "<coverage>"
    When 冻结 manifest 并判断展开结果
    Then 结果为 "<outcome>"
    Examples:
      | allowed | coverage | outcome             |
      | true    | trusted  | 可记录合法零项完成  |
      | true    | missing  | 拒绝或阻塞          |
      | false   | trusted  | 拒绝                |

  @P2 @core @postgres
  Scenario: BDD-P2-04 重复 ID 和超限清单不会部分展开
    Given manifest M 含重复 itemId 或 item 数超过允许上限
    When 两个 worker 请求冻结 M
    Then 返回 INVALID_MANIFEST
    And 不保存部分实例集合、不预约执行预算、不派发 item

  @P2 @core @postgres
  Scenario: BDD-P2-05 部分失败只重试失败项
    Given manifest M 固定 37 个必需 item 且其中 36 项已接受
    And 第 37 项的 attempt 1 失败
    When 授权重试第 37 项并以 attempt 2 提交有效结果
    Then 前 36 项的执行次数和证据版本不变
    And 汇合证明恰好覆盖 M 的 37 个 item 身份
    And attempt 1 的迟到回调不能覆盖 attempt 2

  @P2 @core @postgres
  Scenario: BDD-P2-06 并发冻结与派发在重启后仍只有一份实例
    Given 两个 worker 同时读取尚未展开的同一 manifest
    When 它们竞争提交实例集合并且一个 worker 在提交后重启
    Then 仅有一份完整实例集合和每个 attempt 的唯一派发意图
    And 实际在途预约数不超过 delivery 的并发上限
    And 重复成功回调不增加完成项数或重复结算预算

  @P2 @host @postgres
  Scenario: BDD-P2-07 停止展开不会假装已经取消原生执行
    Given item A 失败触发停止且 item B 已在不支持取消的 Host 上运行
    When 系统停止展开
    Then 不再派发未启动的 item
    And B 显示仍在执行但其结果不再用于本次验收
    And 在 Host 确认 B 结束前保留相应物理占用记录
```

### 13.3 Phase 3 — 执行、委派与审查

```gherkin
Feature: P3 调用执行器与子 Workflow 不改变授权和验收边界

  @P3 @core @host
  Scenario: BDD-P3-01 可信 Tool 和子 Workflow 形成有效交付
    Given 父实例获准调用固定版本的子 Workflow 且剩余预算足够
    And 子 Workflow 使用已注册 Tool 完成检查并产生可信回执
    When 子 run 满足自己的 gate 和父调用的交付契约
    Then 父实例引用子 run 的当前产物和证据继续
    And 父子实际消耗都计入同一 delivery

  @P3 @core @host
  Scenario: BDD-P3-02 子流程一句 success 不能让父任务通过
    Given 父实例使用 call-and-wait 等待子 Workflow
    And 工具响应 success 为 true 但子 run 仍等待人工或缺少证据
    When 父实例请求完成
    Then 父实例保持 waiting 或 blocked
    And 不创建虚假的验收证据

  @P3 @core @postgres
  Scenario: BDD-P3-03 子调用传输重试复用身份且受深度限制
    Given 父 attempt 的 call-site 已经建立 invocation I 和 childRun C
    When 同一请求重复到达且 worker 在响应前重启
    Then 恢复后返回 I 和 C 而不新建第二个子 run
    When C 尝试超过已批准调用深度或形成被禁止的递归
    Then 在派发前拒绝该调用且不能重置 delivery 预算

  @P3 @host
  Scenario: BDD-P3-04 委派不能扩大权限或加载任意执行器
    Given 请求方没有目标动作权限而接收 Agent 持有更广的工具权限
    When 请求方通过该 Agent 或远端 Pack 声明请求执行目标动作
    Then 接收入口依据任务授权再次校验并拒绝越权
    And Pack 数据不能安装任意脚本或替换可信 adapter

  @P3 @core
  Scenario: BDD-P3-05 独立触发的子任务不构成父任务验收证明
    Given 父任务独立触发另一个已注册 Workflow
    When 子任务已创建但尚未提供本次父任务要求的检查
    Then 父任务可记录触发回执但不得把它计作缺失检查的 pass
    And 父任务的其他必需控制仍然有效

  @P3 @core
  Scenario: BDD-P3-06 Finding 修复与复发以证据判断
    Given finding F 已在 C1 确认且 C2 声称修复了 F
    When 作者接受 reviewer 建议但没有提供修复验证
    Then F 保持待验证修复而不是已解决
    When 后续可信验证确认修复且新候选 C3 再次出现同一根因
    Then 可重新打开 F 并保留 C1、C2、C3 的观察历史

  @P3 @core @provider
  Scenario: BDD-P3-07 Judge 故障与过期评估不能解除必需控制
    Given C1 的 Judge 结果已保存且当前候选变为 C2
    When provider 超时或返回 C1 的高分结果
    Then C2 的评估为 unknown 或 stale 且必需检查保持不变
    And 相同 C2 输入没有新证据或允许的重试原因时不得反复评估到通过
    And provider 回执与真实测试结果分开保存

  @P3 @core
  Scenario: BDD-P3-08 评估集不向 reviewer 泄漏答案
    Given 样本包含修复前代码、需求、当时上下文和独立保存的已知根因
    When 构造 reviewer 输入并计算结果指标
    Then reviewer 输入不包含已知根因或最终修复答案
    And 作者是否采纳建议不自动决定 finding 真值
    And 缺失费用显示 unknown 而不是零成本
```

### 13.4 Phase 4 — Routines 与 Principal 闭环

```gherkin
Feature: P4 Paperclip Routines 触发可配置的 Retro 与人审提案流程

  @P4 @native @host
  Scenario: BDD-P4-01 首次设置有两条默认 Routine 且重复设置不覆盖用户配置
    Given 公司 A 已配置时区、可执行 Agent、预算和 improvement Pack
    When 首次配置改进闭环
    Then 原生 Retro 自动 trigger 默认每日一次且提案自动 trigger 默认每周一次
    And 两条 Routine 均具有公司 A 的稳定管理 key
    When 用户修改频率后再次执行 reconcile
    Then 仍只有这两条对应 Routine 且用户配置被保留

  @P4 @native
  Scenario: BDD-P4-02 原生频率和时区变更反映到设置页
    Given PolyForge 显示原生 Routine 的当前配置
    When 用户在受支持的设置入口修改频率、时刻和时区
    Then PolyForge 重新读取并展示实际原生配置与下一次触发时间
    And 不写入另一套可独立生效的 cron 或计时器

  @P4 @native @host
  Scenario Outline: BDD-P4-03 关闭自动后仍可手动触发
    Given "<kind>" 的自动 trigger 已关闭且不存在相同范围的在途任务
    When 原定触发时刻经过并收到一个尚未接纳的延迟自动请求
    Then 不创建新的自动 Graph run
    When 授权用户选择范围并点击立即执行
    Then 同一 Workflow 启动服务创建一个 source 为 manual 的 run
    And 自动 trigger 保持关闭且手动操作不修改原定调度配置
    Examples:
      | kind     |
      | retro    |
      | proposal |

  @P4 @native @host
  Scenario: BDD-P4-04 关闭调度不取消已接纳任务且两个开关独立
    Given Retro R 已接纳并开始执行且提案自动 trigger 仍开启
    When 用户关闭 Retro 自动 trigger
    Then R 继续执行且 UI 显示它是已接纳的在途任务
    And 提案 Routine 仍按原生配置触发
    And 后续提案可以读取已有 Retro 并显示其覆盖范围和新鲜度

  @P4 @postgres @host
  Scenario: BDD-P4-05 定时与手动竞争只建立一个逻辑工作
    Given 定时和手动请求指向同一公司、流程类型、项目集合和时间窗口
    When 两个 worker 同时提交启动意图且一个在提交后崩溃
    Then 仅有一个持久化启动意图和最终 Graph run
    And 两个请求都关联该工作并保留各自来源
    And 恢复后返回同一工作且不重复消耗启动预算

  @P4 @host @postgres
  Scenario: BDD-P4-06 Routine 来源不能由 payload 冒充
    Given 公司 A 的普通 Agent 在 payload 填入公司 B 的 routineRunId
    When 它请求启动每周提案
    Then Host 依据真实 invocation 拒绝伪造或跨公司来源
    And 不授予 human-owner、不创建公司 B 的启动意图

  @P4 @native @host
  Scenario: BDD-P4-07 延迟投递和时区边界不移动统计窗口
    Given 原生 Routine 在配置时区生成一次可验证的计划执行记录
    And 该请求跨过日期边界后才到达 bridge
    When bridge 处理请求并随后收到相同原生执行 ID 的重投
    Then 两次请求使用同一个 UTC 半开统计区间及证据快照
    And 不按到达时间另建新窗口或第二个 run
    And 夏令时和错过执行的补跑时刻由原生 Routine 决定

  @P4 @core
  Scenario: BDD-P4-08 Retro 覆盖缺失不能伪装全部完成
    Given 冻结参与清单包含窗口内有工作记录的 Agent A、B、C
    And A 已总结、B 执行失败、C 没有提交总结
    When 汇总该窗口 Retro
    Then 报告为 partial 并逐项列出 B 和 C 的缺口
    And 不把它们当作无活动 Agent 或从分母删除
    And 后续提案遵守是否允许采用 partial 的固定政策

  @P4 @core
  Scenario: BDD-P4-09 无新证据不强行产生重复提案
    Given 已完成提案记录了问题根因和证据集合摘要 E1
    When 相同流程版本再次收到相同范围及 E1 的请求
    Then 返回已有结果或明确 no-change 而不创建相同变更提案
    When 所选范围根本没有足够证据
    Then 输出 insufficient-evidence 并列出缺失材料

  @P4 @core @host
  Scenario: BDD-P4-10 Principal 不能自行批准或发布
    Given Principal 已提交带具体 diff 和评估报告的 proposal P1
    When Principal 请求批准 P1 或直接执行发布
    Then 按真实 Agent 身份拒绝且 P1 仍未获人类批准
    And 不修改当前 Pack、Skill 或 Agent 运行文档

  @P4 @core @host
  Scenario Outline: BDD-P4-11 批准后内容变化必须重新审批
    Given 授权人类已批准 P1 的 release manifest 摘要 M1
    When 发布前 "<change>"
    Then 返回 APPROVAL_SUBJECT_MISMATCH 或等价的依赖不一致错误
    And 原批准保留审计但不授权变更后的内容
    Examples:
      | change                             |
      | 修改 Skill 文件但保持同一个版本号   |
      | 修改 Agent 文档或 Judge rubric     |
      | 替换实际 adapter bundle bytes      |
      | 修改 Pack 内容或目标发布作用域     |

  @P4 @native @host
  Scenario: BDD-P4-12 批准内容与构建一致时发布新版本
    Given 实际构建内容与已批准 release manifest 相符且评估通过
    When 授权发布执行者发布该候选并启用新版本
    Then 保存人类批准、构建来源和 publication receipt 的关联
    And 新 run 使用新版本及匹配的可信 adapter
    And 现有 run 仍引用原依赖且没有被热替换
```

### 13.5 Phase 5 — 任务修订与整体验收

```gherkin
Feature: P5 新事实可修订任务范围但不能静默降低完成标准

  @P5 @core
  Scenario: BDD-P5-01 范围扩大产生可核对的新 revision
    Given revision 1 只包含模块 A 且 A 已有完整证据
    When 授权用户基于新事实应用增加模块 B 的修订
    Then 创建 revision 2 并保存原始 diff、理由和影响摘要
    And B 的检查显示未满足且 A 的证据不能证明 B 已完成
    And 原 revision 的执行历史保持可查询

  @P5 @core @postgres
  Scenario: BDD-P5-02 影响分析后状态改变必须重新计算
    Given 修订提案基于 revision 1 和影响摘要 I1
    And 在应用前另一个有效命令改变了相关输入或证据
    When 使用旧前置条件应用修订
    Then 拒绝提交并要求重新读取及计算影响
    And 不出现部分失效的批准或半份新 manifest

  @P5 @host @postgres
  Scenario: BDD-P5-03 在途旧回调不能推进新修订
    Given revision 1 的 item A 已经派发且修订 2 已原子生效
    When revision 1 的 execution 回调成功
    Then 保留该回调用于历史和外部动作核对
    And 不把 revision 2 的 A 标记为完成
    And 不因回调的传输重试重复计费或产生新业务动作

  @P5 @core
  Scenario Outline: BDD-P5-04 结果复用有明确适用性证明
    Given revision 1 的证据 E1 曾满足控制 K
    When revision 2 的相关输入、候选目标、依赖和规则 "<condition>"
    Then 对 E1 的处理为 "<result>"
    Examples:
      | condition               | result                            |
      | 全部一致且无失效事件    | 建立显式 reuseRecord，不伪造新执行 |
      | 有一项变化              | 失效并重新验证                    |
      | 有一项无法确认          | 阻塞复用并重新验证或补齐事实      |

  @P5 @core @host
  Scenario: BDD-P5-05 普通修订不能删除验收 gate 或获取新预算
    Given 当前任务要求独立 review 且 delivery D 的预算接近耗尽
    When Agent 提交删除 review 并改用新 deliveryId 的修订
    Then 返回 GOVERNANCE_CHANGE_REQUIRED 或授权错误
    And 当前 gate 保持有效且相关工作继续使用 D 的账本
    And 如需修改治理规则应创建 Principal 提案并经人审发布

  @P5 @native @host @provider @postgres
  Scenario: BDD-P5-06 五阶段真实端到端闭环
    Given 干净开发数据库和固定版本的 Core、Packs、Host、执行器
    When 完成条件选择、foreach、Tool 检查、子 Workflow 和独立 review
    And 中途一次重启及一次范围修订均按契约恢复
    And 原生 Routine 触发 Retro 与 Principal 提案并由人类批准发布
    Then 每一步均可从 run、instance、attempt 追溯至候选和真实回执
    And 新任务使用新发布版本而旧任务不被热替换
    And 报告分别列出实际 Host、provider、PostgreSQL 结果及任何未验收项
```

### 13.6 将规格转成测试的完成标准

- 每条场景在验收报告中标记 `implemented/pass`、`implemented/fail`、`blocked` 或 `not-implemented`；未实现与跳过不能统计为 pass。
- 正常路径必须断言输出证据及允许的下一步；拒绝路径同时断言“不应发生的副作用”，包括无新增批准、无部分实例、无越权写入、无额外工具效果。
- 竞争测试至少包含两个独立执行上下文；数据库竞争不能只在一个进程的内存 mutex 内模拟。
- `@native`／`@provider` 没有可用依赖时记录具体 blocker；不能移除标签后以 mock 结果满足阶段门槛。
- Routines 的具体 API 名称、关闭状态和原生事件映射在 P1-08 核实后更新技术契约；保持本节用户可观察行为不变。如果现有 Host 无法满足，记录明确依赖升级，不能偷偷增加 PolyForge 调度器。
