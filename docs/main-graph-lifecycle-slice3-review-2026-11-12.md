# V1 最小 Graph 生命周期独立审查（2026-11-12）

## 最终结论：本候选、本固定 Graph 的 BDD-V1-01/02 通过；不等于发布通过

只读核验第 4 个隔离 DB 的实际阶段证据、Graph 状态快照、执行/清理摘要，并与冻结 driver/fixture 严格断言对照后，**接受候选 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7` 的 `adlc@0.3.2 / request-triage@0.2.0` V1**：Graph `68be9a9a-f2aa-4c4e-8de4-973902335896` completed，needs-info / triage-needs-info；work、supervisor、decision 三条真实 Host run 均 succeeded；活动 attempt 上错误 Agent 403 拒绝、Graph/decisions 不变、合法提交与幂等重放及三 phase 唯一派发断言通过。此结论来自实际执行证据，不是沿用静态预检或只认打印常量。

DB 现 **4/4 已用且主代理报告均清理**；本审查未重跑测试/Host/Docker/DB。未发布 `0.8.7` 候选不能自动变成正式版本：正式未使用版本、相应最终候选/回归证据和发布准备仍待，full-project regression 仍 **0/2**；merge/push 未获授权。结论不覆盖所有 Graph、全部身份攻击、LLM 质量或外部业务结果。文末有最终证据核验，以下保留先前失败和预检时点状态。

## 执行前预检结论（历史）：R1/R2/R3 静态纠正接受，可放行唯一有界真实 V1；当时 V1 仍未通过

本次新授权片的只读预检已完成：**R1/R2/R3 在静态代码及 focused 范围关闭**，helper 挂载/import 闭包接通，未发现需要阻止下一次启动的新静态缺口。独立一次 focused 为 **6 passed / 0 failed / 0 skipped**。可在用户约 08:51 追加的 40 分钟及新增 1 DB 授权内，由主代理放行一次最长 10 分钟的真实 V1，使用同候选/图/预声明终态并负责外层取证和 finally 清理；**不能据此宣称身份、幂等、事件或终态已实测通过**。

预检时实际 DB 为 **3/4**，本审查未创建第 4 个 DB；full regression 仍 **0/2**，没有产品构建或安装。R4 作者报告顶部已按恢复后真实失败更新，不再列作现存矛盾。以下保留首轮问题及历史 DB 3/3 状态，详见文末“新授权片 R1/R2/R3 只读预检”。

## 首轮结论：V1 未通过；当前 harness 需修正，无发布资格

真实执行停在首次 Process run 失败，未 checkout、未提交工作 attempt、未执行身份负向、review、decision 或预声明终态。已证实隔离 harness 缺少官方 Agent JWT 签名配置；这不是用户缺少 secret，也不是 Graph 产品缺陷。另发现验收 oracle 和事件观察截止处理的局部缺口，应在任何下一次获准启动前静态修正。

本报告只审新的三个 V1 脚本、fixture 测试和脱敏执行证据，不重审未变化的 S1/S2/S3/S4。只新增本报告，产品/作者报告只读，无委派、提交、merge/push、Docker、DB、npm 安装、产品 build 或 full regression。审查预算最多 15 分钟，计入用户约 08:02 开始的 60 分钟窗口，不因审查重置窗口。DB 累计 **3/3 已耗尽**，全回归 **0/2**；不能在审查中分配新实例或 DB。

## 四层状态

- **代码写入**：`scripts/e2e-minimal-host.mjs`、`e2e-minimal-graph.mjs`、`e2e-minimal-fixture-agent.mjs` 及 focused 测试已存在，尚未提交；事件名改为 `heartbeat.run.status` 的当前代码未真实重跑。
- **测试执行**：本审查独立执行一次 `node --test tests/core/minimal-triage-fixture.test.mjs`，1 passed / 0 failed / 0 skipped / 0 cancelled，约 0.24 秒。证明合成输入、triage output、RequestBrief 和有限 routing validator 的匹配，不证明完整 submit/self-review/review/decision 或身份链路。
- **真实运行**：目标 Host/插件/worker settings 成功，Graph 启动并派发 assess-request；真实 Process Host run failed，Graph 仍 running。不是闭环通过。
- **独立接受**：接受“安装/读取 catalog/一次派发已发生、失败被如实保留”的有限事实；不接受 V1 或发布通过。下列缺口属于 harness/验收证据，不借此改变 Pack 规则、产品授权或验收终态。

## 固定规格与候选

只读原计划 `D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph/docs/main-selective-salvage-plan-2026-11-10.md:193–266`，尤其 BDD-V1-01/02；场景为固定 main Packs `6ad0652828b3075b72e457e2afa1b0807dcd929e` 的 `adlc@0.3.2 / request-triage@0.2.0`，预声明 `needs-info -> triage-needs-info`、Graph completed。合成 root issue 确实故意缺受影响用户/具体期望行为，不需要模型或外部业务事实。

候选为未发布 `0.8.7`，tarball SHA-256 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`，v3 自包含。此次没有重新校验/构建产品包，其身份由前片独立包证据和本片主代理核验支持；不能把硬编码在 driver evidence 中的 SHA 字符串本身当作本片重新算 hash 的结果。

## 按严重性的问题

### R1 — P1 / 下一次 V1 启动阻断：隔离 Host 未提供 Agent JWT 签名 secret

位置：`scripts/e2e-minimal-host.mjs:22–30`；失败入口 `scripts/e2e-minimal-fixture-agent.mjs:24–25`。

当前 docker 参数不提供 `PAPERCLIP_AGENT_JWT_SECRET` 或 `BETTER_AUTH_SECRET`。固定官方 commit `d69631b01b9c658f80bf8bed389863dce82643e1` 的因果链已独立读取：

- `server/src/agent-auth-jwt.ts:40–42,123–133`：从这两个变量取签名 secret，缺失时配置为 null，`createLocalAgentJwt` 返回 null。
- `server/src/services/heartbeat/runtime-execution.ts:249–274`：支持 local JWT 的 legacy adapter 使用该函数；缺失时明确记录不注入 API key。`888` 将 authToken 传给 adapter。
- `server/src/adapters/process/execute.ts:39,46–64`：实际 run ID 由 Host设置，仅当 authToken 存在才设置 `PAPERCLIP_API_KEY`；不接受从 adapter config 提供该 key，也防止继承服务器已有 API key。

脱敏 execution 证据由主代理报告 Agent/run ID 存在，缺 API key；本审查只读的 failure-safe 则显示 fixture 在此统一缺凭据检查退出，尚无 attempt。二者与缺 signing secret 的静态链相符。P1 是此验收任务的运行阻断级别，不是已证实的生产安全漏洞。

**最小修复**：经下一步授权后，在隔离 Host 启动时安全生成/注入仅测试用的随机官方 JWT secret，并预检其已配置而不输出值。可由控制脚本子进程环境传递变量名，避免把 secret 明文打印在 argv、日志、报告或 repo。不要手工签 token、用普通 Agent key 代替合法 fixture 的 Host run token，或修改产品绕过身份要求。补设当前已停止实例无意义；任何新 DB 都需用户明确追加有限额度，不能本审查自动重试。

### R2 — P2 / BDD-V1-02 验收 oracle 不完整

位置：`scripts/e2e-minimal-fixture-agent.mjs:76–85`、`scripts/e2e-minimal-graph.mjs:96–105,120–127`。

负向仅要求任意 4xx，可能把非身份原因（例如 429/404）的拒绝计为授权拒绝；前后只比较当前 nodeState 和 decisions，不比较 Graph 状态/其余 nodeStates 或已有结果集合。合法提交与同 key 重放会在将来执行，但当前代码只在终态断言 assess-request attempts 数为 1。driver 对派发 issue 的数量只记录，不断言，也不按 work/supervisor/decision origin 排重。因此“同一工作 attempt 没增加”不足以证明没有额外 review/decision issue 或 wakeup。

这不是证实产品有重复派发，而是当前验收即使放过该回归也可能报通过。原计划要求错误身份不能推进 Graph/已有结果且合法重放不重复派发，不能仅用现在这几个局部比较替代。

**最小修复**：在此稳定的活动 assess-request 上明确断言 pending/current attempt 和合法 checkout 归属；限定预期身份/checkout/run-binding 拒绝状态及错误原因，比较完整相关 Graph 状态/结果不变。保存合法提交和重放响应并核对既有幂等结果，按本图预期三个非自动 phase 的 origin/issue/run 检查唯一性；对 `dispatchIssueCount` 增加有意义的预期断言，而非仅输出。只针对本图、一次工作和一次 review/decision，不扩建通用验收框架。

普通 wrongAgent 的真实 key 先经 `/api/agents/me` 确认不同 Agent，再带合法 work run ID 提交，是有效的错误身份设计。它可能在官方 Host 的 run/Agent 绑定层就被拒绝，不必强求一定进入 Core；但要按真实错误来源记录，不能凭任意 4xx 声称已触发某个产品检查。BDD 允许错误 Agent **或** 错误 run，无需为本片强加第二组新身份场景。

### R3 — P2 / 观察窗口的总截止未取消已排队读取

位置：`scripts/e2e-minimal-graph.mjs:14–16,52–72,90–91`。

120 秒 timer 仅 reject completion；每个事件已排入 `serial` 的 GET 仍会继续，fetch 各有独立 90 秒 timeout，finally 只清 timer 和 close socket。没有共同 AbortSignal 或 settled/stopped 门闩。timeout/首次失败后，已排队的任务仍可逐个发起读取；成功后也没有阻止这些任务继续。因而这只是 completion 的截止，不是所有 observer I/O 的总截止，不能保证脚本在该窗口安全收尾。

外层 `e2e-minimal-host.mjs:48` 的 180 秒只杀 docker CLI 子进程，不等同证明容器内 driver 已退出；实际 Host 清理由主代理另行 stop 完成，不能据此把 observer 本身宣称为硬总截止。

**最小修复**：共享一个观察期 AbortController/绝对截止，并在成功、失败、超时进入同一 settled 清理路径，停止接受/处理排队事件并取消在途 fetch。可把事件合并为一次状态 invalidation，避免每条事件排一个 GET；不引入 sleep/poll 或新的调度系统。保持取证后关闭自己唯一命名容器的外层 finally/明确责任，不删除未知实例。

### R4 — P3 / 作者报告顶部已与实际阶段矛盾

位置：`docs/main-graph-lifecycle-slice3-2026-11-12.md:5,13–15` 对照 `24–38`。

顶部仍称 Host 未启动、未安装、无 Graph/Agent，也称未恢复；后文及脱敏证据已证明恢复后安装、一次派发和 Process 失败。请把顶部当前结论改为“V1 未通过；已安装/派发，Process 缺 Host run credential 失败，DB 3/3 已清理”；首轮日志驱动失败保留在历史段。报告只读，本审查不代作者修改。

## fixture 与 Pack 契约核对：已支持和未知

- 固定 `lifecycle-graphs.mjs:13–28` 确实存在此图；assess-request 的生产物为 triage_report 和 request_brief，工作 product-owner、supervisor cpo，后接 product-owner 的 triage-disposition。所选 needs-info 路由和终态与代码一致，没有新增产品图或放宽 gate。
- `triageSubmission` 生成两份有版本的 artifact、真实 synthetic issue source_request 引用、信息缺口及 request_brief payload。固定 ADLC `runtime/host-api.mjs:109–130` 仅对注册的 product-method payload（含 request_brief）要求 payload/envelope 一致；没有证据要求另造一个不存在的 triage_report payload。测试已验证 brief/output 基本 schema。
- work choice 使用 `ruleRef=node:assess-request` 和来源为 run_input.source_request 的 summary，符合 Core `engine.mjs:421–438,785–807` 的静态规则。fixture 在隔离公司读取实际 issue 列表与当前 Graph decisions，不以“无外部研究”伪造外部业务证据。是否满足全部运行 wrapper/幂等前提尚未实测。
- self-review 使用生产同一 Host run；supervisor 分支按实际 dispatch title 的 ` review` 识别，与 `dispatch.mjs:196` 一致。CPO 的 review-disposition 规则来自 Pack 汇总的 principal-engineer 决策模型，其允许 CPO 并要求 artifact_version/review_findings/self_review_history；fixture 三项和引用与之静态匹配。不应因该规则不在 CPO 自己的文档里就误报缺规则。
- triage decision 从 pinned Pack 按 type/mode 读 requiredEvidence，并引用 assess-request 的 triage_report；needs-info 不要求声称实现/发布已完成。审查未发现明确的下一步 payload/schema 硬阻断，但当前 focused **没有**实际跑 GraphEngine + ADLC wrapper 的 submit/self-review/review/decide 全序列，不能据一项 validator 通过保证终态可达。
- fixture 从 Host 注入 env 取 Agent/run/token，不从 caller JSON 信任 claimed actor，并先真实 checkout；产品 `dispatch.assertAgentCallback` 检查 bound Agent、phase、attempt、Host run 和 checkout。以上 checkout/callback 在本次真实失败中均未执行，代码路径存在不等于通过。

## Host run 取证、事件形状与快事件

当前 `e2e-minimal-graph.mjs:67–70` 已合并 node attempt actors **和 latest.decisions 的 Agent actors**。Core `engine.mjs:911–912` 把 supervisor actor 写入 review Decision Record，`944–945` 把 gate actor 写入决策/attempt；owner dashboard 返回该 run 的 decisions。因此现在不能把“只取生产 attempt、必漏 supervisor/decision”作为现存缺陷。仍建议最终 evidence 显式按 work/self-review/supervisor/decision 标注 Agent、Host run 和对应 issue，且做 R2 的实际派发清单核对；现有末尾 `attempts` 展示本身没有 supervisor actor。

独立读取固定官方 commit：

- `server/src/services/heartbeat.ts:1060–1066` 发布 `heartbeat.run.status`，payload 由 `heartbeat-run-status-payload.ts:20–26` 生成，确有 `runId` / `status`。
- `server/src/services/live-events.ts:13–25` 是顶层 `type` / `payload` envelope；`server/src/realtime/live-events-ws.ts:348–366` 订阅公司事件并 JSON 发送，local_trusted implicit-board 在 `149–157` 授权，`282–287` 保留事件。目标修正后的 event.type / payload.runId / status 判断有源码依据。
- driver 在 start 前安装 message listener 并 await socket open，`pending` 保留 runId 尚未赋值前收到的事件，串行队列避免读请求乱序；没有 sleep/poll。没有发现此处必然丢失快成功事件的静态原因，修正后却仍未真实验证；断连不做无界重连，按失败处理。
- failed Hostrun 当前不会立即结束 Graph completion，只能等截止；这会损失早期诊断但不把失败当成功。下次可在已识别本 Graph 派发 run 时快速记录 failed/cancelled，不能把其他公司的/无关测试 Agent run 误归到该图。

Context7 返回 master 文档还列有 `heartbeat.run.finished`，本报告不以它否定固定目标实现；事实依据是上述固定 commit，不是浮动文档。

## 真实失败与清理证据

独立只读 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-v1-triage-20261112/evidence-first.json` 及 `failure-safe.json`，未读取未脱敏 key/token 文件、docker env 或原始日志：

- Host 日期版本/commit 匹配，plugin ready / 28 agents / 61 skills。settings 三包通过为主代理及 driver 断言证据，阶段 JSON 未单独保存该 response；不冒充本审查独立 HTTP 请求。
- Graph `2a4d6189-fb61-465f-b116-7a3e6e220b8a`，assess-request issue `2e26ff7a-25c0-4d4c-ac09-18bb97e1c7df`，Hostrun `d75e1b6d-87b4-47a1-8705-6621df940858`。一条派发 queued，真实 Process failed / exit 1；Graph running、node pending、attempts 空。最终 driver timeout 亦如实保留。
- 首次 Docker logging 的 compress/max-file 不兼容发生在 Host/DB 创建前；主代理批准改源配置为 explicit local + compress=false 后才再次启动同名唯一实例。基础设施失败与恢复不是产品 Graph 失败，更不是通过。
- 第三个实际 DB 在恢复实例中已创建并消耗额度。主代理报告 graceful stop 后该唯一名称 inspect 为 no such object，容器/tmpfs 已清理；本审查未自行 inspect、重启或分配资源。清理结论执行出处为主代理，不是本审查重跑。
- wrongAgent 一次性 key 只写私有 tmpfs 下 mode 0600 文件，成功路径不打印；evidence 记录 ID/状态而不记录 secret。没有已证实的凭据泄露。`logs` / startup logTail 是原始日志收集能力，不能先验当脱敏安全证据；分享前仍须审查，不应把其中潜在 token 放报告。

## 下一最小预检修订与停止边界

1. 保留同一候选、图和预声明终态。先关闭 R1：安全随机的测试 JWT secret 在 Host 启动前就绪，静态验证官方 injection 路径，禁止伪造 run token。DB 3/3 已尽，任何实际重试须用户/主代理明确追加有限 DB/时间额度。
2. 关闭 R2 的身份拒绝/完整状态/幂等派发 oracle，以及 R3 的共享截止与排队取消。离线检查 fixture 的完整三阶段和取证集合，避免用稀缺 Host/DB 发现本可静态看出的假设；不要求无关 fullsuite 或新框架。
3. 更新作者当前状态摘要，保留 logging 失败、真实 Process 失败、旧事件名与未重验状态，不覆盖历史。正式版号和发布准备不能越过 V1。
4. 下一次获准执行前，明确取证/stop 的外层 finally 责任：现有 controller 是 start/run/evidence/stop 分离命令，脚本失败本身不会自动 stop；本次由主代理完成清理，不宣称 controller 独自保证全程 finally。只清理自己命名资源，先保留脱敏阶段结果。

本审查只有一次 focused 运行，无失败重跑，无新产品修改周期/全回归/数据库。已取得可决策证据即停止；未知保持未知，不自动执行修复或增加验证场景。V1 当前未通过，候选无发布资格。

## 新授权片 R1/R2/R3 只读预检

### 决策与预算

用户约 08:51 新增 40 分钟和 1 个 DB，前提是先关闭 R1/R2/R3 并经独立静态接受。此次审查最多 8 分钟，计入该窗口、不是重置；只更新本报告，产品/作者代码与报告只读。实际 DB 仍 3/4，之前实例已清理；没有为预检启动 Docker/Host/DB、拉镜像、npm 安装、产品 build 或 fullsuite，没有委派或提交。

**允许主代理在这一明确窗口中启动唯一一次有界真实 V1（计划最长 10 分钟）。**放行仅表示原静态启动阻断及 oracle/观察器缺口已合理纠正，不表示真实 V1 已通过或保证下一次一定到达终态。候选仍 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`、`request-triage@0.2.0`、needs-info/triage-needs-info。若执行失败或超出窗口，记录阶段、IDs 和未知并停止；不能自动再分配第 5 个 DB、第三轮修复或换场景试到成功。

### R1 静态关闭：真实启动路径共用 signer 配置

- `scripts/e2e-minimal-helpers.mjs:4–28` 用 `node:crypto.randomBytes(32)` 生成仅本测试使用的 signer；env 包含 `PAPERCLIP_AGENT_JWT_SECRET`，Docker argv 只含 `-e` 和变量名，不含值。空值和值误入 argv fail fast。
- `scripts/e2e-minimal-host.mjs:10–11,19–25` 实际调用 `buildStartInvocation` 并把返回的 env 交给 docker 子进程 spawn；不是只测试未被 controller 使用的另一个构造器。Host signer 仍由官方代码签 run JWT，合法 Agent fixture 没有手工造 token 或用普通 key 替代它。
- 预检 focused 使用固定无效测试字符串检查 argv/env，不生成真实 signer 或输出 secret。真实签名、SDK 注入和 API key 可用性仍待第 4 个 DB 上的那一次执行；不把离线环境构造等同 Host 已签发。

### 挂载与 import 闭包：接受

`buildStartInvocation:20–23` 将候选只读挂载 `/opt/polyforge/plugin`，fixture `/opt/v1/fixture.mjs`、driver `/opt/v1/driver.mjs`、新 helper `/opt/v1/e2e-minimal-helpers.mjs` 亦分别只读挂载。`e2e-minimal-fixture-agent.mjs:6` 和 `e2e-minimal-graph.mjs:4` 的相对 import 均解析到该 helper；helper 自身只导入 Node builtins。Host controller 本地也使用同文件。未发现这次新增 helper 引起必然 MODULE_NOT_FOUND 的路径缺口，不要求下一次稀缺 DB 用来发现此静态错误。

### R2 静态关闭：负向、重放与实际派发 inventory

- `helpers:31–50` 限定 400/403/409 并匹配 Agent/run/checkout/dispatch 身份绑定文本，排除 404/429 及无关拒绝；比较整个 Graph run（包括全部 nodeStates/结果）及 decisions。活动前提断言 originKind/originId、pending attempt、assignee、checkoutRunId 和 Graph 状态。
- `fixture:43–46,76–98` 使用真实 GET checkout 信息、wrongAgent `/agents/me` 身份确认及当前 attempt 前提；负向后用共享 oracle。合法 submit 必须有 result，同 key replay 的 result、完整 run、decisions 均须保持相同，才继续 self-review。
- `helpers:53–75` 对 work、supervisor、decision 三 phase 要求各一个准确 origin，三个唯一 issue、三个唯一 Host run，逐项核对 Agent role binding 和 issue/run 配对。
- `graph:97–104` 不再仅从成功 attempt actors 推断无额外 run，而是查询真实 company heartbeat inventory（limit 1000，必须低于上限），对这组原生 dispatch issues 过滤实际 runs，再与 `completed.ids` 完全集合比对，并要求均 succeeded。计数不再仅输出。
- 独立只读固定官方 commit 的 `server/src/routes/agents.ts:6861–6875`，该 endpoint 确实支持 limit、返回 runs 数组；相邻 heartbeat 数据代码也存在 issueId 字段。此检查支持 API 方向，不是对下一次响应全部结构和错误文本的实测承诺。

当前这些检查比首轮充分，未发现需阻止一次有界执行的明确静态缺陷；仍应让实际错误文案、ordinary wrong key + work run header 的拒绝层级、checkout 响应、idempotency result 和全三阶段 inventory 在真实运行中接受严格断言。不可为通过而删掉后来失败的 assertion。

### R3 静态关闭：共享截止、事件合并与统一清理

- `helpers:79–134` 的观察器在 socket open/start 之前安装 listeners，维护单一 deadline、共享 AbortController、settled 门闩、finished 集合和 dirty invalidation；早到的成功事件可在 runId 设置前保留 finished/dirty。
- start 和 read 接受共同 signal；`graph:15–17,54–65` 将其实际合并到 fetch 的 AbortSignal，不再只是传入未使用参数。超时、读错、socket 错/关闭、成功都通过 settle abort 在途 I/O，settled 后不再处理事件/触发读取。
- dirty/reading 合并事件，不建立每事件一个 GET 的无界串行 backlog；finally 解除 message/error/close/open listener 并关闭自己 socket。没有恢复 sleep/status polling。
- 观察窗口只涵盖该 observer 的 open/start/read，前置安装及后置取证仍由各 API timeout、controller 和主代理总窗口约束。不能夸称整个启动/取证/容器清理都由该 observer 的 120 秒覆盖。主代理在获准执行时仍负责先保存脱敏证据、再对唯一命名容器执行外层 finally stop。

### 独立验证与作者实际周期记录

本次因共享 helper 接入真实 controller、负向/派发 oracle 及事件取消路径改变，执行一次最小 `node --test tests/core/minimal-triage-fixture.test.mjs`：**6 passed / 0 failed / 0 skipped / 0 cancelled**，约 0.25 秒。覆盖原合成契约、实际共用 signer argv/env 构造、负向错误种类与完整状态变化、活动 origin/checkout/attempt、三 phase 唯一性、挂起 read 超时取消/晚事件拒绝，以及成功/读失败 cleanup。没有在本审查真实启动 Host、签 token、checkout 或完成 Graph。

作者报告实际 focused 启动了三次，各 6 pass：首次三项实现；第二次将 signer 构造迁到 controller 实际共用的纯函数后重验；第三次增加 R2 活动 origin/checkout/attempt 和 R3 open listener 清理后重验。原要求一次，实际多两次必须保留，不能把每次 6 pass 算新增交付或声称只跑过一次。作者 R1/R2/R3 各两轮修改验证额度已用尽，无权因新函数/断言更名自动开启第三轮。上述为作者执行出处，本审查只独立跑了当前文件一次，无失败重跑。

### R4 当前状态与仍未验收事项

已读取当前作者报告顶部和新纠正段：顶部现在正确记载恢复后安装/派发、Process 缺 token 失败，首轮“尚未启动”的矛盾已纠正；历史段的旧 3/3 与新授权段的 3/4 是不同时点，不据此继续报 R4。

四层结果仍须分开：代码/离线 focused 已纠正，独立静态预检可接受；当前实现尚未在新增 DB 上真实运行，Host signer 注入、身份负向不变、合法重放、review/decision、WebSocket 终态响应、精确三次派发与 Graph completed 都未实证。正式版本及发布结论保持未通过。取得放行所需证据即停止，本报告不分配资源、不执行下一次运行，也不重置总窗口。

## 第 4 个隔离 DB：实际 V1 最终只读核验

### 核验方法与来源

本次仅更新原报告，最多 5 分钟，仍计入约 08:51–09:31 的同一 40 分钟窗口；没有重跑测试、Docker/Host/DB、修改产品/作者报告、委派或提交。按用户给定范围只读以下脱敏文件，没有读原始日志、环境、key/token 文件：

- `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-v1-db4-20261112/evidence-db4.json`。
- 同目录 `failure-db4-safe.json`：通用文件名未改，但实际内容为 Graph completed，不能因文件名说成此次失败。
- 同目录 `execution-summary.json`：`startExit=0`、`runExit=0`、`stopExit=0`、`containerSeen=true`、`uniqueContainerAbsent=true`，candidate SHA 一致。

同时重新只读冻结的 `e2e-minimal-graph.mjs:66–108` 和 fixture `75–100`：终态、三 Hostrun succeeded、实际 company inventory/三 phase 唯一性、真实 heartbeat 日志中的负向 probe，以及合法 replay result/run/decisions 相同，均在 `graph-terminal` 写入之前严格断言。异常会导致非零 runExit，而实际摘要为 0。因此不是仅凭一个 JSON 常量或日志打印认定通过。原始执行者为 Terra/主代理，本审查只独立核验证据，未声称亲自再次执行。

### BDD-V1-01：通过本候选与固定场景

- 实际阶段 health 为 `serverVersion=2026.1106.0`、commit `d69631b01b9c658f80bf8bed389863dce82643e1`；安装 ready / 28 agents / 61 skills。候选完整 SHA 与固定图声明一致。固定官方 image pin、无外部 Packs/sidecar 及实际 tarball 部署核验的执行出处为主代理/作者，本审查没有重新 inspect 镜像或重算 tarball；不把 evidence 中 SHA 字符串本身当重新取证。
- Company `e7fc1cec-c18d-4203-a490-758d0ff2809c`，root issue `45e5e5ce-e877-47ac-bc81-19ea55c5704d`；Graph **`68be9a9a-f2aa-4c4e-8de4-973902335896`**。stage 终态与独立脱敏 Graph 快照均显示 completed、decision needs-info、triage-needs-info completed；后者含 system 自动终结 attempt，而非直接写 DB 制造结果。
- work：issue `77e93e88-b7d6-435b-9b52-4dd114185413` / Hostrun `9b5da106-d293-43fa-a73a-1d359622fe84`，product-owner `061a4e81-efa6-4b64-83cf-4be904b1a138`。
- supervisor：issue `7090e704-fab4-4ce8-b458-82928ba7b8b3` / Hostrun `2c98b6b9-7cb2-42f9-b18a-ebb5071f50b1`，CPO `a2620fbd-d884-48d9-a88a-eb32f6779c21`。
- decision：issue `5ad975eb-36ee-430b-b51f-8e0a39527ab0` / Hostrun `e57c2c90-18ce-4086-91d2-4e91f5e9790e`，同 product-owner。
- 阶段证据的三条 Hostrun 均 succeeded，原生 phase/issue/run 映射和角色一致。Graph 快照另含同 work run 的 self-review round 1、独立 CPO 的 accept supervisorReview、product-owner 的 needs-info decision attempt；review Decision ID 为 `7fbfbcbd-335e-43b4-88b7-3b9adf6915a6`，routing Decision ID 为 `a9467687-ea71-4fa9-9273-042c7bcc5b7a`。
- `failure-db4-safe.json` 的 hostRuns 附表只列 work run，这是较窄的诊断采集范围，不用它单独证明三条成功；三条完整清单来自 `evidence-db4.json`，且 driver 对每条 GET 和 company actual inventory 都有严格成功断言。未发现 ID/状态冲突。

据这些运行结果，可认定 Host 实际派发、Host Agent/run 身份 checkout、带身份的工作提交/self-review、独立监督 review、decision 及声明终态已在本场景发生。没有模型或外部业务事实承诺。

### BDD-V1-02：通过本次错误 Agent 场景

实际 wrongAgent **`b039bff6-377b-4be6-9636-aa95aed23a0e`**，其 key 在 fixture 中先由 `/api/agents/me` 确认身份，再对当前 work attempt 提交同一 submission。证据记录 HTTP **403**，原因 **`Agent is not bound to this Graph node issue`**；不是 404/429 或不明拒绝。

活动 checkout 证据为上述 work issue、origin `68be9a9a-f2aa-4c4e-8de4-973902335896:assess-request:1:work`、product-owner Agent、Hostrun `9b5da106…`、attempt 1。真实阶段记录 `unchangedGraphAndDecisions=true`；该标记由 fixture 在完整 run/decisions 深比较成功后打印，再由 driver 从真实 work heartbeat 日志提取，并与 Agent/run 对照。脱敏 evidence 没有保存负向前后两个完整原始快照，因此本审查不能重新独立重做这次前后比较；接受的依据是冻结断言、实际 work run succeeded、driver runExit 0 和匹配的 probe/checkout 记录共同支持，而不是该布尔字段单独证明。

证据保留 acceptedResult / replayResult：同一生产 execution、artifact 和 work Decision ID，状态 awaiting_self_review。JSON 对象键顺序不同不构成结果差异；fixture 使用深比较，且 replay 后 run/decisions 不变，再继续 self-review。driver 最后验证 work attempt 仍一次，原生三 phase 各一个 issue/run，company inventory 没有额外该图派发 run。因此接受此次合法重放未重复派发，不扩大为所有重试/并发或第二组错误 run 场景。

### 清理、历史和发布边界

execution-summary 的 start/run/stop 均为 0，曾见唯一容器且最终不存在；作者报告明确外层 finally 在取证后 graceful stop。清理的运行出处为主代理，不是本审查独立 Docker inspect；没有发现摘要与作者声明矛盾。DB 实际累计 **4/4**，新额度已耗尽，不得据通过结果自动分配更多资源。先前缺 signer 的第三 DB 失败及旧 evidence-first/failure-safe 原样保留，不被此次覆盖。

四层最终状态：实现冻结且仍未提交；已有 focused 证据保留；本次真实 V1 严格 runExit 0、达到固定终态及负向/幂等要求；独立结果审查**接受该候选该图的 BDD-V1-01/02**。这不同于先前只读预检的“允许执行”。主代理另一次最终受影响 source 回归集合尚在进行，本报告未收到结果、不计为通过，也不重复；它不是 full-project suite，full regression 仍 0/2。

正式未使用版本尚未选择，`0.8.7` 只是本次已验证候选；改版本或重建后的新 SHA 不能冒用本 SHA 的精确包级身份。发布/合并仍需对应版本准备与最终证据、用户授权；没有 merge/push 授权。本次没有新增场景、修复、运行或预算，核验完成即停止。
