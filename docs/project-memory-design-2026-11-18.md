# Project Memory（Project Brain / dev-graph）设计提案

日期：2026-11-18　状态：提案，待确认后实施

## 1. 目标与不做的事

为每个 Project 提供一份**隔离的、长期的、可追溯的开发记忆**。任何 Agent 在改代码之前必须先查询它，并且当改动与已确认的决定、契约冲突时，由系统（而不是 Agent 自己）决定放行、警告、还是转人工。

记忆负责五类内容：

| 类别 | 记什么 | 例子 |
| --- | --- | --- |
| Decision | 项目决定、原因、被谁确认、何时被替代 | “count_amount 小数位限制为 3” |
| Change | 代码变动历史：谁、何时、改了哪些符号、为什么、关联哪个决定/Run | “Feb：加 3 位小数限制” |
| Contract | 需求 spec / 行为契约：公式、不变量、示例、保护等级 | “总价 = qty × unitPrice × (1+tax%)；小数位 ≤ 3；locked” |
| Context | 项目背景、术语、约束、非功能要求 | “金额一律不得用 float” |
| Architecture | 符号/模块/测试及其调用关系（代码图） | “`invoice.total()` 调用 `count_amount`” |

**不做**：不是聊天记录库；不是向量搜索优先的“语义记忆”；不让 Agent 直接改写权威记录；不跨 Project 共享。

## 2. 核心原则

1. **Project 隔离是硬边界**：所有表以 `(company_id, project_id)` 为主键前缀，Store 接口没有“跨项目查询”方法。与现有 Delivery 账本（company + project + delivery）的键一致。
2. **确定性优先，LLM 只做建议**：是否改了公式、是否改了签名、谁调用了它，都用 AST 指纹、契约示例、调用图判断。LLM 只负责把“差异”归类成解释，永远不能批准。
3. **追加式 + 双时态**：记录只追加，不覆盖。每条有 `valid_from/valid_to`（现实中何时生效）和 `recorded_at`（何时记下），才能回答“3 月时当时的规则是什么”。哈希链保证不被悄悄改写（沿用 Pack 完整性绑定的做法）。
4. **信任分层**：`human_approved` > `graph_accepted` > `agent_observed`。只有前两层能构成“契约/决定”，Agent 写入的内容只能是 `observation`，不能阻止或放行任何事。这是防“记忆投毒”的关键。
5. **权威在库，仓库里只有投影**：数据库中的追加日志是唯一权威；在仓库生成只读的 `.polyforge/memory/*.md` 让人在 PR 里看得到。Agent 改投影文件不产生任何效力，且这些路径是受保护路径（改它们本身触发人工确认）。

## 3. 数据模型

节点（Node）与边（Edge）两张主表 + 一条事件日志，其余都是物化视图。

```
memory_events      (company_id, project_id, seq, type, payload, actor, trust, prev_hash, hash, recorded_at)  -- 唯一权威，追加
memory_nodes       (company_id, project_id, id, kind, version, body jsonb, valid_from, valid_to, status, trust)
memory_edges       (company_id, project_id, from_id, to_id, rel, valid_from, valid_to, source_commit)
memory_code_index  (company_id, project_id, commit_sha, symbol_id, file, span, signature_hash, ast_fingerprint)
```

`kind`：`decision | change | contract | context | symbol | module | test | spec_doc`

关键边：

| rel | 含义 |
| --- | --- |
| `constrains` | decision/contract → symbol（这个决定约束哪个符号） |
| `supersedes` | 新 decision/contract → 旧的 |
| `modifies` | change → symbol |
| `motivated_by` | change → decision / bug / graph run |
| `verifies` | test → symbol / contract |
| `calls` / `imports` | symbol → symbol（来自代码索引，每个 commit 重建） |

**Contract 的结构**（决定了能否被机器检查，是整个设计的核心）：

```yaml
id: contract:count_amount
symbol: src/billing/amount.ts#count_amount
version: 3
protection: locked            # locked = 任何行为变更都要人工; guarded = 警告; open = 仅记录
formula: "quantity * unitPrice * (1 + taxPercentage/100)"
invariants:
  - { id: dp-limit, rule: "result has <= 3 decimal places", decision: decision:D2 }
examples:                      # 可执行的黄金样例，Guard 会对新代码实际运行
  - { in: [2, 10.0, 10], out: 22.0 }
  - { in: [1, 0.3333333, 0], out: 0.333 }
ast_fingerprint: sha256:...    # 当前已批准实现的归一化 AST 指纹
approved_by: { kind: human, id: ..., decision_record: ... }
```

symbol_id 用 `路径#名称` + 签名哈希，并做 rename 检测（同 commit 内删除+新增且 AST 相似度高则视为改名，边与契约迁移），避免重构后记忆“失联”。

## 4. 与 PolyForge 现有机制的对接

不新建平行体系，复用已有概念：

| 现有 | 复用方式 |
| --- | --- |
| Decision Record（append-only，可被 supersede） | 自动镜像为 `decision` 节点；人类通过 Decision Handoff 批准的变更，同时产生新的 Contract 版本 |
| Product decision（feature 范围 + 引用校验） | 保持不变，Memory 引用其 ID，不重复存 |
| Context Snapshot / Shadow 上下文 | 增加 **Memory Brief**（见下），随快照一起交给 Shadow/Temporary Agent，且只含本 Project |
| Decision rule（`requiredEvidence`、`requiresHuman`） | 新增证据类型 `memory_guard`；实现类决定规则要求该证据，Guard 为 `block/require_human` 时 `requiresHuman` 生效 |
| Dispatch admission | 派发实现类节点前，先附 Memory Brief；Brief 缺失则拒绝派发 |
| Delivery / 完成的版本化 Artifact | 节点验收后触发 **Ingest**：写 Change 记录、更新代码索引、重算边 |

放置位置：`src/core/memory/`（与宿主无关的引擎 + `MemoryStore` 接口，另带内存实现供测试），`src/plugin/memory-store.mjs`（Postgres 实现，`migrations/017_project_memory.sql`），Worker 注册两个工具：`memory-query`（只读）、`memory-propose`（只能提交 observation 或契约变更提案）。

## 5. 三个运行时动作

### 5.1 Memory Brief（改之前读）
输入：任务涉及的文件/符号（来自计划或 diff 预估）。输出（有 token 预算，确定性遍历，不依赖向量检索）：

- 命中的 active Contract + 保护等级
- 约束这些符号的 Decision（含原因与替代链）
- 最近的 Change 时间线（谁、为什么）
- 直接/间接调用者、关联测试
- 已知 bug 与“曾被拒绝的改法”（防止同一错误反复出现）

### 5.2 Contract Guard（提交前判）
对候选 diff 做确定性检查，输出 `allow | allow_with_notes | require_human | block`：

1. 受影响符号 → 取 active Contract
2. AST 指纹是否变化？未变 → allow
3. 变化 → 运行 Contract `examples` 与已关联测试；不变量静态/属性检查
4. 示例失败或公式变化 → `block` 并发起 Decision Handoff（原生人类决定卡）
5. 示例全过、仅扩展（新增带默认值的可选参数等）→ 按保护等级给 `allow_with_notes` 或 `require_human`
6. **测试变更同样过 Guard**：削弱断言、删除 case、放宽期望值，等同于对其所验证契约的改动
7. 对受保护路径（`.polyforge/memory/**`、契约文件）的改动一律 `require_human`

结果写入 Run 的证据（`memory_guard`），Agent 无法绕过：Graph 的决定规则要求该证据。

### 5.3 Ingest（改之后写）
节点被接受后：解析 diff → 更新代码索引 → 写 Change（关联 Run、Decision、commit）→ 重算 `calls/verifies` 边 → 如有人类批准的契约变更则发布新 Contract 版本并将旧版 `valid_to` 封口。Agent 在过程中的发现（“这个函数有精度问题”）只作为 `observation` 入库，待人确认后才升格。

## 6. 影响面（Blast Radius）计算

给定被改符号 S：

- `callers`：沿 `calls` 反向遍历，深度可配（默认 3），标注直接/间接、是否跨模块、是否导出为公共 API
- `tests`：沿 `verifies` 找测试；没有测试覆盖的 caller 标 `untested`
- `contracts`：callers 自身若有 Contract，也一并受影响
- `unknown`：动态调用/反射/跨语言边界无法静态确定的部分，**明确标为 unknown**，不假装完整

风险分 = f(扇入数、最大深度、跨模块数、无测试 caller 数、涉及 locked 契约数、变更类型)。变更类型权重：纯内部实现 < 新增可选参数（带默认值）< 新增必填参数/改签名 < 改返回值语义 < 改公式。输出同时给出**建议的最小修改集**（需要更新的 caller 列表，附 `文件:行`）和需补的测试。

## 7. 五个场景走查

| 时间 | 事件 | 记忆里发生什么 | 系统结论 |
| --- | --- | --- | --- |
| Jan | 新增 `count_amount(quantity, unitPrice, taxPercentage)` | Ingest 写 Change C1；人类批准的需求形成 Contract v1（公式、示例）、`protection: locked`；符号入索引 | 建立基线 |
| Feb | 发现小数缺陷，加 3 位限制 | Change C2 `motivated_by` Decision D2（原因：精度缺陷）；Contract v2 加入不变量 `dp-limit`，旧版封口；公式指纹更新 | 经人批准的契约升版 |
| Mar | 另一单元测试期望 5 位，得到 3 位，失败 | Brief 命中 D2 与 `dp-limit`。若 Agent 移除限制：指纹变化 + 示例 `0.3333333→0.333` 失败 → `block`。若 Agent 改测试期望：测试验证的是 locked 契约，且新期望与不变量冲突 → 也被拦；系统建议“该测试已过时，应按 D2 修正为 3 位”，并带出 D2 的原因与日期 | Agent 得到正确方向：修测试，不动代码；若坚持需人工 |
| Apr | Agent 想把公式改为 `qty * unitPrice - tax` | AST 指纹变化，黄金示例失败，Contract 要求 locked → `block`，自动开 Decision Handoff 卡，展示旧公式、新公式、示例差异、影响面 | 禁止；人类否决则写入 “被拒绝的改法”，防重复提出 |
| May | 新增 `discountPercentage` 参数 | 签名哈希变化 → 计算 blast radius：列出所有 callers、哪些按位置传参、哪些未被测试覆盖、涉及哪些契约；若设为带默认值 0 的末位可选参数，示例全部通过，风险低 | `require_human`（契约扩展）并附完整影响报告；批准后 Contract v3 与全部 caller 更新计划一并入库 |

## 8. 权限与隔离细节

- 所有读写必须携带 `(company_id, project_id)`，由 Worker 从受信上下文取得，不接受 Agent 参数传入；Shadow/Temporary Agent 的 Brief 由父 Run 的 Project 决定。
- Pack 不能读写 Memory 存储，只能在 `decisionRules` 中声明需要 `memory_guard` 证据。
- 删除 Project 即级联删除其记忆；支持单 Project 导出（含哈希链校验）。
- 日志哈希链断裂 → Guard 一律 `block` 并报警，而不是“尽力而为”。

## 9. 实施分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 事件日志 + Node/Edge Store（内存 + PG）、Decision/Contract/Context/Change CRUD、镜像现有 Decision Record、Memory Brief 手动注入派发、隔离测试 | 跨 Project 读取为不可能；哈希链篡改可检出；Brief 出现在派发里 |
| P1 | 代码索引（先 TS/JS，语言适配器可插拔）、调用图、影响面报告 | 对 count_amount 场景给出正确 caller 清单与风险 |
| P2 | Contract Guard：AST 指纹、黄金示例执行、测试变更检测、`memory_guard` 证据、接入 Decision Handoff | 场景 Mar/Apr/May 端到端用例全部通过 |
| P3 | 从 git log 与 `docs/` 回填历史、`.polyforge/memory` 只读投影、UI 面板（时间线 + 影响面图）、可选语义检索 | 回填后能回答“某行为为什么是这样” |

## 10. 风险与待确认

1. **语言范围**：P1 先做 TS/JS（本仓库和多数目标项目）；Python 等需另写适配器。是否一开始就要多语言？
2. **摩擦**：`locked` 过多会让 Agent 频繁卡住等人。默认建议：新契约 `guarded`，只有人明确标记的才 `locked`。
3. **调用图盲区**：动态分发、反射、运行时拼接无法静态确定，只能标 `unknown`；高风险符号建议靠测试覆盖补足。
4. **契约从哪里来**：Jan 的初始 Contract 需要人（或经人批准的 Agent 提案）编写。冷启动时可由 Agent 从代码+测试起草，但必须人确认才升格。
5. **与 Agent 环境的边界**：Guard 只对经过 PolyForge Graph 的变更有强制力；直接绕过 Graph 在仓库里提交的改动，需要 Ingest 时检测出“未经 Guard 的 commit”并标记。是否需要配套 git hook / CI 检查？
