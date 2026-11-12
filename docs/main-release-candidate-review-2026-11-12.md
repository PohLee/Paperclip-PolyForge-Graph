# Graph 0.8.9 发布候选独立预检（2026-11-12）

## 最终结论：0.8.9 本候选发布准备范围接受；固定 Graph 的 BDD-V1-01/02 通过

已只读核验 DB5 实际证据：**`0.8.9` / `ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90`** 在目标官方 Host 上完成固定 `adlc@0.3.2 / request-triage@0.2.0` 的 needs-info / triage-needs-info 闭环，三 phase Host run 均 succeeded，错误 Agent 403、完整状态不变、合法幂等及唯一派发断言通过。结合本报告的真实 tar/root 来源桥接、版本核对和独立 focused，**接受此精确候选的有限源码发布准备及 BDD-V1-01/02**，不是沿用旧 eb 包的成功。

start/run/stop 均为 0，唯一容器不存在；DB **5/5** 已用完。用户最新已明确授权主代理 commit and push 本分支；本审查不执行提交/推送，也不把它扩大为 merge、registry/public release 或所有 Graph/模型质量的批准。全项目 suite 未运行（full regression 0/2），既有 35/35 作者受影响集、桥接加强后 2/2 与独立 8/8 分层保留。以下静态“尚未执行”属于历史，最终证据见文末。

## 首轮结论（历史）：静态接受；资源前提满足后可放行一次最长 8 分钟 V1

对候选 **`0.8.9` / `ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90`**，版本同步、实际 tarball 与部署目录的来源桥接、driver 版本断言、helper 挂载闭包及已有 V1 安全 oracle 未发现启动阻断。独立最小 focused 为 **8 passed / 0 failed / 0 skipped**。

可由主代理在用户约 10:12–10:52 的新窗口内、**先完成 Docker 实际后端容量/free-space 核对等资源前提后**，放行唯一第 5 个 DB 和一次最长 8 分钟真实 V1。这里仅接受代码/包级预检，不替代资源放行或真实执行。旧 `0.8.7 / eb08930b…` 的 V1 成功不能覆盖本包；本新候选尚无真实 Host/Graph 通过证据，不具备笼统发布通过结论。

## 范围与执行限制

- 审查者 GPT-6.1 Sol；最多 8 分钟，计入用户新增 40 分钟，不重置总窗口。唯一写入为本报告；产品和作者报告只读，无委派、提交、merge/push/publish。
- 本次没有 Docker、Host、DB、镜像拉取、npm 安装、产品 build 或 fullsuite；使用已有包/解压目录，不建完整源码副本。
- 当前实际 DB **4/5**，前四个已清理；full-project regression **0/2**。用户存储上限增至 4 GiB；可见 taskfiles 约 0.2–0.3 GiB，不把历史未采样 DB/WAL 当零。Docker data VHDX 实际分配大小、system df 使用量及 distro 中的空 root 不能互相替代为后端剩余容量；本审查没有代查或宣称 free-space 已满足。
- Graph baseline 为 `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，当前源码仍为含授权变更的 dirty 工作树，不把 baseline SHA 冒充最终源码身份。固定 main Packs 为 `6ad0652828b3075b72e457e2afa1b0807dcd929e`。

## 版本语义与实际候选

1. `package.json:3`、lock 根及 packages['']、`src/plugin/manifest.mjs` 和 `src/core/compatibility.mjs:4` 同步 `0.8.9`。Core compatibility 对 baseline 的差异仅 `.version`，没有改变 schema、contracts、capabilities；迁移目录无 diff。
2. SDK/shared 与 Host minimum 继续 `2026.1106.0`；官方完整 image pin 不变。snapshot、trusted adapter、Pack 版本、v3 格式没有借发布准备升级。
3. 作者检查本地可达 Git 范围，`.8.8` 已用于实验分支，未见 `.8.9`，故跳过 `.8.8` 选择 `.8.9`。本审查接受其本地可达范围的版本选择说明，不把它升级为外部 npm/GitHub registry 全局唯一性查询；本次不公开发布。
4. 直接只读实际新 tarball 的 package/artifact 确认 packageVersion / artifact.pluginVersion / artifact.runtime.version 均 `0.8.9`、format 为 v3；source maps 中 Core compatibility、manifest 均与当前源码匹配（仅归一 CRLF）。未执行产品独立 Core 入口，不能据此宣称其没有外部依赖。

实际候选路径：

`C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-rc-089-e469c535e4694b189a2b9608a50677f8/pohlee-paperclip-polyforge-graph-0.8.9.tgz`

独立计算并核验 SHA-256：**`ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90`**。

## tarball → 部署 root → 容器 driver 的实际闭包

### 原始 archive 与解压目录绑定：接受

`scripts/e2e-candidate-metadata.mjs:8–18`：

- 要求显式 archive/root；对原始 tarball 字节实际算 SHA-256，不接收 caller 提供的“自报 SHA”。
- 先用当前共享 v3 `verifyRuntimeArtifact(root)` 检查实际解压 runtime 文件、package/runtime 版本与完整迁移 inventory/content。
- 再逐项从显式 tarball 读取 `package/dist/runtime-artifact.json`、metadata 声明的全部 artifact 文件及 migrations，与解压 root 的对应字节比较。并非只比较 metadata 字符串。
- metadata、worker 或迁移不一致会在启动容器前失败。没有建立通用 installer、签名或允许新 executable 来源的框架。

本审查对**上述实际新 tarball 和其既有 package 目录**执行只读 `candidateMetadata`，实际返回完整新 SHA 和 `version=0.8.9`。这不仅是测试 fake archive 的结论。没有重新解压、修改文件或生成新包。

### controller CLI 与证据身份传递：接受

`scripts/e2e-minimal-host.mjs:20–28` 的实际 start 路径调用 `candidateMetadata(process.argv[5], candidate)`，并将返回 identity 交给 `buildStartInvocation`，不是只导入未使用 helper。作者给定调用形状为：

`node scripts/e2e-minimal-host.mjs start <extracted-root> <startup-failure-path> <candidate-tarball>`

在该形状中 argv[3] 为实际挂载 root、argv[5] 为原 tarball，参数位置匹配。验证失败不会进入 docker run。执行者必须显式传对这两个路径，使用全新解压目录和 `tar -xmf`，不复用旧 sidecar。

`scripts/e2e-minimal-helpers.mjs:15–35` 验证 identity 格式，将计算出的公开 SHA/version 作为 `POLYFORGE_V1_CANDIDATE_SHA256` 和 `POLYFORGE_V1_CANDIDATE_VERSION` 传入容器。真正 secret 仍通过 docker 子进程 env 和 `-e PAPERCLIP_AGENT_JWT_SECRET` 名称传入，值不在 argv/日志。

`scripts/e2e-minimal-graph.mjs:8–10,28–30,40–42` 从 env 构建 evidence identity，拒绝缺失/格式错误值，并严格比较实际 installed plugin.version、manifest.version、settings.runtime.version。新包的身份不再通过单换一段硬编码 evidence SHA 得到。

### import/mount 与现有安全 oracle：接受

- candidate metadata/verifier 模块只在宿主 controller 使用；driver 不导入它，不需要为了此模块把源码或宿主 node_modules 挂入容器。
- fixture/driver 仍导入相邻 `/opt/v1/e2e-minimal-helpers.mjs`；构造器保留这三份脚本的只读 mount，helper 只依赖 Node builtins，闭包没有新增缺失模块。
- signer 名称传递、真实 wrongAgent me 身份、活动 checkout/origin/attempt、身份绑定原因、完整 run/decisions 不变、合法 replay、三 phase 原生 issue/run 唯一性与真实 company inventory 均保留。
- 观察器的共同 AbortController、截止、事件合并及 settled 后取消/不再读请求逻辑未削弱；没有恢复 sleep/poll。新的公开版本桥接不改变产品身份鉴别规则。

桥接覆盖当前 artifact inventory 和 migrations；README、source maps 等 inventory 外文件并非由 controller 逐项验字节。作者报告准确保留这一边界，不把它当来源真实性签名。这里没有要求新增非目标文件的通用验证体系。

## 独立检查与字节差异

- 为验证版本/来源桥接新分支及其与既有 V1 helper 联动，只执行一次：`node --test tests/core/release-candidate.test.mjs tests/core/minimal-triage-fixture.test.mjs`，**8 passed / 0 failed / 0 skipped / 0 cancelled**，约 0.60 秒。没有重跑全 33/35 项集合。
- release focused 构造真实小型 tar fixture，分别拒绝错误解压 root、metadata 相同但 archive worker 内容不同、已解压 worker 被改的情况；不只是断言 metadata 字段相同。signer/env 和 observer/身份/dispatch 的原 focused 同次通过。
- 另外只读对比旧 `eb08930b…` 与新 `ce778201…` 两个 tarball：文件 inventory 相同。实际有变化的正好是 package.json、README、dist/core/index.js 及 map、dist/manifest.js 及 map、dist/worker.js 及 map、dist/runtime-artifact.json。其余成员包括 snapshot、compiled trusted adapter 和 15 个 migration 字节相同。
- 这支持作者差异说明，但**不证明变化的 bundle 在语义上除版本外逐字节相同**，也不允许继承旧候选的精确 V1 通过。新包仍需自己的真实安装版本、worker runtime 版本和 V1 证据。
- 作者先 35/35、桥接加强后仅 2/2 的实际记录保留为作者证据；版本/来源根因已两轮。本审查没有修改代码、消耗新的产品修复周期或用新增测试名重置预算。

## 非阻断文档观察

README 第 3 行把 `0.8.9` 明确称作未验证候选，符合当前状态；须真实 pass 后再更新验证范围，不先宣称发布。第 36 行仍有旧 `SDK v2026.1023.0` 文案，属于当前说明残留，实际依赖/lock 已为目标版本；不阻止本次受限 V1，可在后续准确更新发布文档时一并处理，不为此强行开启第三轮产品构建。

如果后续修改打包 README、版本或重建包导致 tar SHA 改变，必须记录新的精确身份及适用证据，不继续把本报告 SHA 当最新包；也不能因文档说明把候选重新标成已经公开发布。

## 放行条件与未知

**静态放行**本新候选一次最长 8 分钟真实 `adlc@0.3.2 / request-triage@0.2.0` needs-info / triage-needs-info V1，前提是主代理完成其尚在核对的 Docker 后端可用容量/资源门槛，实际保持 cached image / no pull、限定 tmpfs、无模型、无外部 Packs/sidecar/网络、全新部署目录及外层 finally 取证后 graceful 清理。应在新实例前后记录容量/实际使用量；不能把 VHDX 文件大小或空 distro root 的 df 当后端 true free。

第 5 个 DB 尚未创建，创建后额度即 5/5；失败只记录阶段与严格断言，不自动再启 DB 或第三轮同根因修复。新包真实 installed/runtime `0.8.9`、真实身份负向/幂等、三条 Host run、Graph 终态均未知，待该次实际执行记录与短审。前片旧 V1 通过仍保留为旧 SHA 的历史事实。

首轮静态预检不批准全项目发布、所有 Graph、LLM 质量、正式 registry release 或 merge；当时亦没有据本审查执行提交/推送。用户后续已明确授权主代理本分支 commit and push，见文末，不能把旧权限时点当当前禁令。full regression 仍 0/2；没有据此偷偷启动全项目 suite。证据足够即交付并停止，不新增场景、架构或验证轮次。

## DB5 实际结果最终只读核验

### 核验范围与证据来源

本次仅更新本报告，最多 4 分钟，计入约 10:12–10:52 的同一窗口，不重置预算。只读 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-rc-089-db5-20261112/` 的 `evidence-db5.json`、`result-safe.json`、`execution-summary.json`、`storage-usage.txt`，以及作者报告第 35–45 行；没有重跑 tests/Host/Docker/DB、读原始日志/secret/env、改产品或作者报告、委派、提交或发布。

`storage-usage.txt` 不能由通用 read 作为普通文本读取，改用 PowerShell Unicode 只读显示，输出含嵌入 NUL，但数值与路径可辨且与作者摘要一致。这是证据文件编码显示问题，不是产品/测试失败，也没有为此重新执行 du/df。

### 新 SHA 与实际版本的绑定：接受

新阶段文件明确记录完整 **ce778201…97bb90** SHA、`candidateVersion=0.8.9`，health 为 `2026.1106.0` / `d69631b01b9c658f80bf8bed389863dce82643e1`，plugin ready、28 agents、61 skills。不是旧 eb 包的 evidence 路径或旧 Graph ID。

本审查先前已对实际新 archive/root 执行真实 metadata 桥接并核 hash；冻结的实际 controller 在 docker run 前再次使用该桥接，把计算值送入 driver。driver 在写 installed/prepared 阶段前严格比较 plugin.version、manifest.version、settings.runtime.version 与传入身份。DB5 execution-summary 的 `startExit=0`、`runExit=0` 及最终完整证据共同支持这些断言实际经过；不是仅把 evidence 的 SHA 常量改成新值。作者另明确记录新目录解压部署和实际安装版本，未复用旧 package/sidecar。

阶段 JSON 没有逐项重复保存三个版本 response 原文；本审查接受的是先前独立 bridge、冻结严格断言、实际 0 退出及作者执行记录的组合证据，不声称再次亲自请求 Host 或读取未脱敏日志。

### BDD-V1-01：通过本候选和固定场景

- Company `8ba64014-90b2-416e-a2c5-bdce7cd8bc18`；root issue `97476c93-ef60-4080-8f1f-fbf529502cb1`。
- Graph **`2299dc1a-def3-4ec9-8752-5a968259c168`**。实际阶段和另行脱敏结果快照均为 completed，decision needs-info，triage-needs-info completed；assess-request、triage-disposition 各一次 attempt。非选择分支保持 pending 不构成失败。
- Work issue `b0a790b2-4b3e-4e10-ade3-1d86042987e8`，Hostrun **`4184d46d-f3aa-4cb4-a837-a8e2797fdda2`**，product-owner `6ed189cc-fa34-4611-bfbf-958879744d71`。
- Supervisor issue `e5fa228d-3785-449a-836f-db338efd60b8`，Hostrun **`9d084154-c486-4652-9114-7b2d85e04d4a`**，独立 CPO `dbd6302b-3760-4403-9e7e-9cfc93e41857`。
- Decision issue `c0b8650b-1322-4503-a5f4-fd95d322f6e8`，Hostrun **`8ce3fa85-20eb-4576-9bd9-cce6a4097a22`**，同 product-owner。

完整阶段证据的三条 Hostrun 均 succeeded、dispatchIssueCount 为 3、phase 映射一致；driver 终态写入前已要求原生 origin、独立 issue/run、角色和真实 company inventory 完全集合匹配。`result-safe.json` 的 hostRuns 附表只保存 work run，属于较窄诊断采集，不用它代替完整阶段的三条清单；未发现冲突。结合冻结 fixture 的 Host 注入身份/checkout 和 self-review、CPO review、decision 请求顺序、实际三成功 run 与 completed，接受本固定 Graph 闭环发生。

### BDD-V1-02：通过本次错误 Agent 与合法重放场景

wrongAgent **`bbb85cd9-bf52-4087-b814-d9c38a014f20`**，记录 HTTP **403**、`Agent is not bound to this Graph node issue`；活动 origin 为 `2299dc1a-def3-4ec9-8752-5a968259c168:assess-request:1:work`，checkout 为上述 work Agent/run、attempt 1。`evidence-db5.json` 与 `result-safe.json` 的负向记录一致。

冻结 fixture 先用真实 key 请求 `/api/agents/me` 确认不同 Agent，比较负向前后的整个 Graph run/decisions，再执行合法 submit、同 key replay，并深比较 result、run、decisions。成功 probe 只在这些断言及 self-review 之后产生，driver 从实际 work heartbeat log 提取并核对身份，最后又核三 phase 唯一性、无额外该图 run。阶段证据保留 acceptedResult/replayResult，work run succeeded，严格 driver runExit 为 0。因此接受此次负向不推进、合法幂等不重复派发。

脱敏文件未保留负向前后两份完整原始快照，不能在此重新独立重做其深比较；依据是冻结 oracle、运行成功与匹配 probe/checkout/结果的联合证据，而非单一 `unchangedGraphAndDecisions=true` 字段。也不把这扩展成全部身份/并发攻击验证。

### 清理、容量和最终边界

execution-summary 明确 `startExit=runExit=stopExit=duExit=dfExit=0`，曾见唯一容器，最终 `uniqueContainerAbsent=true`。作者说明外层 finally 在取证后 graceful stop；本审查没有独立 Docker inspect，清理执行出处为作者/主代理，记录间未见矛盾。DB 累计 **5/5** 已耗尽，不能再自动创建。

本次停止前实际 `/paperclip`（含 DB/WAL）为 **109216 KiB**，`/tmp` 为 **4 KiB**。df：paperclip 524288 KiB cap、109216 used、415072 available；tmp 131072 cap、4 used、131068 available。属于本实例单个时点 tmpfs 记录，非历史所有 DB/WAL 的累计实际量，也不是 Docker VHDX 后端剩余容量测量；历史未测值仍不记零。

独立最终判断：**本候选的版本/来源准备及 BDD-V1-01/02 接受**，未发现需阻止用户已授权本分支源码提交推送的未关闭审查项。35/35 作者受影响集、桥接加强后 2/2、此前独立 8/8 和此次实际 V1 分层记录，没有新增测试或伪称 full-project suite 通过。模型质量、所有 Graph、外部业务、正式公开发布均未被验证；本次真实执行不等于 merge 或 registry/public release 批准。

用户最新明确要求 commit and push，主代理可在其授权与剩余窗口内处理本分支；本审查者仍未执行 git 写操作。若随后改产品、改包或重建改变 SHA，应准确记录新的证据适用边界，不冒用本 tarball 的精确身份。核验完成即停止，不增场景或修复路线。
