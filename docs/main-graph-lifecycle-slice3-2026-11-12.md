# V1 最小真实 Graph 生命周期：执行与验收证据

## 结果

**固定候选 `eb08930b…cf0b8d7` 的 BDD-V1-01/02 已通过，Sol 已只读核验接受。** 真实官方 Host 上的 `adlc@0.3.2 / request-triage@0.2.0` 达到预声明的 `completed / needs-info / triage-needs-info`；错误 Agent 403 且完整状态不变，合法提交与幂等重放通过，work/supervisor/decision 三条 Host run 均 succeeded 且唯一。最终受影响回归 **33/33 通过**。这只覆盖本候选与本场景，不代表所有 Graph、模型质量或新正式版本。此前日志配置与缺 signer 等失败保留；4/4 DB 已使用且均清理。未提交、merge 或 push。发布准备仍需选择未使用的正式版本并同步元数据及对应候选证据，不能把未发布 `0.8.7` 当作正式发布已完成。

## 预先固定的场景

候选 tarball `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s4-r1-52bb797eb8644f0bbd6f8c19a511b572/pohlee-paperclip-polyforge-graph-0.8.7.tgz`，解压前 SHA-256 已核对 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`。固定目标是 `adlc@0.3.2 / request-triage@0.2.0`，`source_request` 指向实际隔离公司中合成 issue 的 id/v1，工作角色 product-owner，监督角色 cpo，decision `needs-info`，预声明终态 `triage-needs-info`，Graph 状态 `completed`。合成请求故意不说明受影响用户及期望行为；fixture 限定检查隔离公司的 issue 和本 Graph 决策，不声明外部业务、发布或模型事实。

## 已写代码和 focused 检查

- `scripts/e2e-minimal-fixture-agent.mjs`：Process adapter fixture，预期使用 Host 注入的 Agent/run 身份和 checkout，提交结构化 triage/brief、self-review、监督 review、needs-info decision；设计了同一活动任务的真实错误 Agent key 负向请求及幂等重放。已被真实 Host 启动，但在凭据预检即退出，上述后续行为仍是**待验证意图**。
- `scripts/e2e-minimal-graph.mjs`：隔离 Host 内 owner 侧驱动，实际完成安装、catalog 核对、角色配置及 Graph 启动；证据提取、真实身份回调和终态等待没有完成，API/权限/观察逻辑仍需独立审查。
- `scripts/e2e-minimal-host.mjs`：只控制 `polyforge-v1-triage-20261112`，无网络、无主机端口、无外部 Packs、有限 tmpfs；含事件驱动 startup 等待和证据/日志/停止操作。首次启动失败，见下。
- `tests/core/minimal-triage-fixture.test.mjs`：`node --test tests/core/minimal-triage-fixture.test.mjs` **1 passed / 0 failed / 0 skipped**；基于固定 main Pack 的真实 request brief、input/output、decision validator。该测试不代表 Host 身份或 Graph 运行通过。

## 首次基础设施失败与资源

主代理预检报告 Docker 健康、目标 image 已缓存、C/D/Docker 数据盘空闲均超过 10 GiB；授权本目标累计最多 3 个测试 DB，前 2 个已清理。此次 `docker run --pull never ... --log-opt max-size=10m --log-opt max-file=1` 失败，错误为 `failed to initialize logging driver: compression cannot be enabled when max file count is 1`。这发生在容器任务创建、Host 进程和嵌入式数据库启动之前；因此本片**没有创建第三个 DB**。一次只读 `docker inspect polyforge-v1-triage-20261112` 返回 `no such object`，没有该名称的残留容器或其 tmpfs；未触碰其他实例或卷。没有拉取镜像或运行完整回归。候选已用 `tar -xmf` 解压到本片独立 temp 目录；无完整源码拷贝。

基础设施失败按全局停止规则暂停后续测试及资源分配，未重试、未换环境掩盖。下一最小方案是经用户／主代理明确决定后，针对日志驱动作有界配置修正（例如确认兼容的最大文件数或关闭压缩），再在同一授权的第三个 DB 额度内重新开始唯一隔离实例；先确认该配置与现有 Docker 日志驱动兼容，仍用 `--pull never`、无外部 Packs 和有限 tmpfs。不要把此次失败当作 Host 或 Graph 功能失败，也不要把尚未运行当作通过。

## 经授权恢复及真实 Host 结果

主代理在用户已授权的 60 分钟窗口内，经官方日志文档核实后，明确决定只在配置源码修改后恢复一次启动。harness 改为 `--log-driver local --log-opt max-size=10m --log-opt max-file=1 --log-opt compress=false`，不改变第一次失败记录。根据固定官方 commit 的 `/api/companies/:companyId/events/ws` 和 local_trusted implicit-board 语义，Graph 驱动在 start 前订阅公司事件，使用原生事件触发串行 Graph 状态读取，并用单一总截止时间；去掉原 sleep/status polling。`node --check` 对两个驱动通过。

唯一命名实例 `polyforge-v1-triage-20261112` 于 `2026-11-12T00:11:04.255Z` 创建，官方 Host startup recovery 完成。此实例使用本目标第三次也是最后一次 DB 额度（3/3）；不挂外部 Packs、无外网或对外端口，数据限于该实例 tmpfs。

真实 driver 依次确认 health 的 serverVersion `2026.1106.0`、commit `d69631b01b9c658f80bf8bed389863dce82643e1`；用候选 `eb08930b…` 安装插件返回 `ready`，manifest 有 28 agents 和 61 skills，settings 返回预期三包。隔离 company `5ed4bc6e-7a69-4c68-9ee8-e3edbc4fb8eb`、root issue `89534751-d70c-43d9-97f5-f7324d782230`；Graph run `2a4d6189-fb61-465f-b116-7a3e6e220b8a` 已启动，派发一个 `assess-request` issue `2e26ff7a-25c0-4d4c-ac09-18bb97e1c7df`、真实 Host run `d75e1b6d-87b4-47a1-8705-6621df940858`。Host 执行了 Process fixture，但该 run **failed**，exit code 1；Graph 仍 running，节点 pending、无工作 attempt。fixture stderr 为 `Fixture missing host-injected agent, run or credential`，尚未 checkout、提交或执行错误身份检查。仅能证明一次派发，不证明重复派发保护。

第一次 driver 的 Graph 观察最终报 `V1 Graph event deadline exceeded`。只读固定官方 commit 的 `server/src/services/heartbeat.ts` 和 `heartbeat-run-status-payload.ts` 后发现 WebSocket 实际事件为 `heartbeat.run.status`、payload 含 `runId` 与 `status`，而非先前使用的插件事件名 `heartbeat.run.finished`；harness 已按此源码修正，但**修正后未重跑**。此次超时不能解释或掩盖真实 Process run 的独立失败。

Host run 的脱敏 execution metadata 显示 Agent ID 和 run ID 已提供，但无 `PAPERCLIP_API_KEY`。固定官方 `server/src/adapters/process/execute.ts` 仅在 `authToken` 存在时注入该变量；`server/src/services/heartbeat/runtime-execution.ts` 对 Process adapter 使用 `createLocalAgentJwt`；`server/src/agent-auth-jwt.ts` 从 `PAPERCLIP_AGENT_JWT_SECRET` 或 `BETTER_AUTH_SECRET` 获取签名秘密，缺失时返回 null。此次隔离 Host 的启动参数没有提供这两个值，因而没有 Host 签发的 Agent run credential。不能以手工伪造 JWT、普通 key 或无凭据身份冒充 V1。启动后的进程环境无法通过正常 API 安全补设；重启该 tmpfs 实例会丢失此 DB，新的实例或 DB 又超出 3/3 上限，因此停止而非降低验收门槛或换场景重试。

第一轮阶段证据保存在 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-v1-triage-20261112/evidence-first.json`；仅含错误摘要、Graph 状态与 Process stderr 的脱敏快照在同目录 `failure-safe.json`。一次人工只读诊断命令先因 PowerShell 引号导致 Node 语法错误，随后使用 stdin 成功；这是诊断命令错误，非产品测试通过。脱敏证据不含实际 key；错误身份用的测试 Agent key 仅暂存容器内受限 tmpfs，随容器清理销毁。执行 `node scripts/e2e-minimal-host.mjs stop` 后 Host 已 graceful stop；只读 inspect 对该唯一名称返回 `no such object`，其容器与 tmpfs 已清理。没有新建额外 DB 或调用付费模型。

**仍未验收：** Host 已安装/catal​​og 已读取；真实 Graph 仅启动并派发，Process run 失败，未取得 Host 注入的 run token、合法 callback、review、decision、错误身份拒绝、合法重试或预声明终态。没有真实模型质量证据、完整回归或独立审查。要继续应由用户明确追加有限 DB 额度，并在新的隔离 Host 启动时通过安全方式配置随机、仅测试使用的官方 JWT secret；重新检查事件订阅和 fixture，再对同一候选、同一图与终态运行有界 V1。不要把本轮失败重命名为通过，也不要声称仅改脚本后已修复当前实例。

## 新授权：R1/R2/R3 离线纠正（待审查）

用户另授权有限时间及第 4 个 DB，但明确要求先完成本静态修订并经 Sol 预检；本阶段没有启动 Docker、Host 或 DB，也没有产品 build/full regression。当前实际 DB 仍为 3/4、均已清理。候选 `eb08930b…`、`adlc@0.3.2 / request-triage@0.2.0` 和预声明 needs-info 终态均未改变，旧运行仍为失败证据。

- **R1**：启动参数由共享纯函数 `buildStartInvocation` 构造；启动前用 `node:crypto` 随机生成仅测试 signer secret，仅通过 docker 子进程环境和 `-e PAPERCLIP_AGENT_JWT_SECRET` 名称传递；参数中包含值或值为空时 fail fast。无手签 JWT，无将普通 Agent key 用作合法运行 token。离线测试使用固定无效测试字符串，检查实际构造的 argv 和 env；真实 secret 尚未生成、未输出或写入 repo/evidence。
- **R2**：错误 Agent key 仍先通过 `/api/agents/me` 确认身份；负向响应限定为 400/403/409 且错误文本必须指向 Agent/run/checkout/dispatch 身份绑定，404/429 和无关拒绝不计通过。提交前检查真实 issue 的 origin、活动 attempt、assignee 和 checkout run；负向前后比较整个 Graph run（包括全部 nodeStates/结果）和 decisions。合法提交及同 key 重放比较 result、Graph 和 decisions；目标终态时检查原生 origin 三个 phase 各一个独立 issue/Host run、真实 company run inventory 无额外 run，并记录身份、状态及结果。以上是 harness 断言，未真实执行，具体官方错误文案、Host 响应结构与 idempotency 仍待 V1 检验，不预称通过。
- **R3**：共享 `AbortController` 与单一观察窗口截止；事件驱动读取合并 invalidation，成功、异常、超时统一 settled、abort 在途 fetch、拒绝后续事件并关闭/解绑 socket。没有恢复 sleep/status polling。离线模拟覆盖挂起读取被取消、后续事件不再发请求，及成功/读取失败后的清理。Host 启停仍是分离命令：**主代理在获准执行时负责外层 try/finally**，先保存脱敏证据，再仅对本任务唯一命名容器 graceful stop；不能把现有单个 `run` 命令说成自动清理。

focused 实际执行三次，均为 `node --test tests/core/minimal-triage-fixture.test.mjs`，每次 **6 passed / 0 failed / 0 skipped**：首次完成三项实现；第二次因将 signer argv/env 构造移入 Host 实际共用的纯函数而重验 R1；第三次因增加 R2 的 origin/checkout/attempt 具体断言及 R3 open listener 清理而重验。用户原要求一次 focused；实际多启动两次，原因和结果如实保留，不计为新增交付。R1 共两轮修改验证，R2/R3 各两轮修改验证；无失败修复重试，不应再自动扩展同根因循环。新文件 `scripts/e2e-minimal-helpers.mjs` 由 Host 只读挂载到 fixture 和 driver 相邻路径；现有三脚本及 focused 测试有修改。待 Sol 审查后，由主代理决定是否使用第 4 个 DB；不能凭这份离线报告宣称真实 V1 或发布通过。

## 第四个隔离 DB：真实 V1 执行结果

Sol 静态预检接受 R1/R2/R3 后，用户明确授权一次执行。解压前实际计算并确认候选 SHA-256 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`，使用 `tar -xmf` 部署独立目录，没有挂载外部 Packs 或 sidecar。唯一容器 `polyforge-v1-triage-20261112` 于 `2026-11-12T01:02:25.821Z` 创建（本地 09:02:25），官方固定镜像、无网络和对外端口、local_trusted loopback、有限 tmpfs；随机测试 signer 通过 Docker 子进程环境传入，没有记录值。

- Host health 报告 `2026.1106.0` 和 commit `d69631b01b9c658f80bf8bed389863dce82643e1`；真实安装为 `ready`，manifest 28 agents / 61 skills，真实 settings 断言三包 catalog。
- Company `e7fc1cec-c18d-4203-a490-758d0ff2809c`；root issue `45e5e5ce-e877-47ac-bc81-19ea55c5704d`；Graph run `68be9a9a-f2aa-4c4e-8de4-973902335896`。固定 `adlc@0.3.2 / request-triage@0.2.0` 以 `needs-info` 到 `triage-needs-info`，Graph `completed`；真实结果包含同一 work run 的 self-review、CPO 的 accept supervisor review 和 product-owner decision。
- 真实 Process dispatch 共三条，均有唯一 issue/run 且 Host 状态 `succeeded`：work `77e93e88-b7d6-435b-9b52-4dd114185413` / `9b5da106-d293-43fa-a73a-1d359622fe84`；supervisor `7090e704-fab4-4ce8-b458-82928ba7b8b3` / `2c98b6b9-7cb2-42f9-b18a-ebb5071f50b1`；decision `5ad975eb-36ee-430b-b51f-8e0a39527ab0` / `e57c2c90-18ce-4086-91d2-4e91f5e9790e`。driver 对原生 origin、角色、issue、run 唯一性及 company run inventory 做了严格断言。
- 实际不同 Agent `b039bff6-377b-4be6-9636-aa95aed23a0e` 的 key 先通过 `/api/agents/me` 识别，再针对当前已 checkout work attempt 提交：HTTP **403**，`Agent is not bound to this Graph node issue`。完整 Graph run/nodeStates 与 decisions 前后相同；随后合法 Host run 提交、同 key 重放及状态不变断言通过，work attempt 仍为一次。此结论是该具体场景，不扩展为所有身份攻击场景。
- 本次 execution 的 `startExit=0`、`runExit=0`；外层 finally 提取证据后 graceful stop，`stopExit=0`，只读名称检查确认唯一容器不存在，tmpfs 清理。阶段证据 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-v1-db4-20261112/evidence-db4.json`；结果快照同目录 `failure-db4-safe.json`（文件名保留通用快照命名，本次 Graph 为 completed）；执行和清理摘要 `execution-summary.json`。先前 `evidence-first.json` 和失败快照未覆盖。原始运行日志只在该临时目录，不将其当作已脱敏公开材料。

本次未修改产品或 harness、未再次运行 focused/full suite、未拉镜像、未调用付费模型。真实 Host/Graph V1 是实际执行结果，尚需 Sol 只读结果审查；它不证明模型推理质量、所有 Graph 或正式发布版本。完整回归仍为 0/2，正式未使用版本及发布准备未完成。

## 最终独立核验与受影响回归

Sol 已直接只读核验 `evidence-db4.json`、`failure-db4-safe.json`、`execution-summary.json`，并与冻结的驱动断言对照，接受本候选、本图的 BDD-V1-01/02。没有由 reviewer 重跑 Host/DB，也未把预检通过当作执行通过；详见 [独立审查](main-graph-lifecycle-slice3-review-2026-11-12.md)。

主代理另核 `execution-summary.json`：start/run/stop 退出码均为 0、唯一容器已不存在；只读 Docker 名称检查无残留，最终 tarball SHA 仍为上述完整 `eb08930b…`。没有新建数据库。

为关闭原计划 Phase 3 的最终受影响回归，在代码与候选冻结后执行一次：

```sh
node --test tests/core/official-sdk-pairing.test.mjs tests/core/check-runner.test.mjs tests/core/packs-packaging.test.mjs tests/core/pack-registry.test.mjs tests/e2e/runtime-upgrade.test.mjs tests/core/minimal-triage-fixture.test.mjs
```

结果 **33 passed / 0 failed / 0 skipped / 0 cancelled**（约 2.33 秒），覆盖 SDK/Compose、Windows 原子写入、来源与 snapshot 完整性、registry、runtime upgrade/preflight 及 V1 helper。不是全项目 suite；全回归开始次数仍为 0/2。此检查不改变历史候选通过范围，不新增产品修改验证轮次。

未完成的发布准备：当前 `0.8.7` 仍为未发布切片候选。主代理只读检查所有可达 Git 提交中 `package.json` 版本，已见实验候选 `0.8.8`，未见 `0.8.9`；正式准备时还须选择并同步 package、manifest、CORE_RUNTIME、artifact。若因此形成新 tarball，必须明确新摘要及相应验证，不能冒用本 `eb08930b…` 包的真实 V1 身份。没有执行 merge、push 或发布。
