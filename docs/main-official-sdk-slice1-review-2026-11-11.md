# S1 官方 SDK 独立审查（2026-11-11）

## 最终状态：S1 纠正关闭，S2 代码审查接受；不等于发布通过

唯一有界 followup 已完成：**R1 / R2 均关闭，S2 未发现阻断缺陷，S1/S2 有限接受**。独立双文件 focused 为 13 passed / 0 failed / 0 skipped。最终候选 SHA-256 为 `c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa`，本审查已独立核验 hash，并只读确认其中门槛及 S2 源码来源。主代理同实例官方 upgrade 首次因 manifest mtime 缓存碰撞未通过严格断言；刷新部署 mtime、保持同一 tarball 内容后，同一断言通过，最终成功 JSON 已独立读取，不能归因为旧包成功。S3 / S4 / V1 尚未完成，仍非完整合并或发布验收。详见文末“S1 纠正与 S2 最终复核”和“最终 Host 证据补充”。

以下保留首轮历史问题和证据；其中“需修正”“未实施 S2”“尚未运行假凭据 bootstrap”等是首轮时点状态，不是最终状态。

## 首轮结论：需修正；本片不是发布验收通过

发现 **1 项 P2 兼容门槛回退**，建议作者在唯一有界纠正中修复；另有 1 项 P3 当前使用说明的版本残留。未发现本次差异引入 Core 状态、授权规则、迁移或 Pack 内容改变，也未证实数据损坏或生产安全漏洞。主代理后续已报告同一 tarball 的真实 Host 安装、health、settings/catalog 通过；本审查核对其驱动和启动 JSON，没有独立重跑。该结果不消除 R1，也不等于所有 API 或 V1 通过。V1 生命周期尚未验证，不能据本报告发布或合并。

这是 S1 + 预检的分片审查；S2–S4 未实施、旧 fixture 不适用于当前图，都不直接记作 S1 新代码缺陷。没有要求扩建架构或提前实施 S4。

## 范围、依据与独立性

- 审查者：GPT-6.1 Sol；作者报告为 Terra 实施结果，不能替代独立执行。
- 工作目录：`C:/Users/pohle/.local/share/opencode/worktree/ace267039946970ba017bda07fcdd1579bdd9568/salvage-plan`。
- 固定 Graph baseline：`e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，已解析成功；`baseline..HEAD` 无新增提交，实际审查的是 `git diff <baseline> -- <产品文件>` 和新增测试，而非一个已提交候选。
- 只读规格：`D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph/docs/main-selective-salvage-plan-2026-11-10.md`；结合主代理明确的本片范围，以及已纠正的 Host 版本事实。历史 analysis/review、原计划均未编辑。
- 产品差异：三份 Compose、package/lock、build、RPC smoke、manifest；新增测试 `tests/core/official-sdk-pairing.test.mjs`。作者报告只读。
- 未发现仓库内 `AGENTS.md` 或根级 CONTRIBUTING/STANDARDS 文件；遵守给定范围和跨项目执行约束。用户禁止继续委派，因此两轴由本审查者分别核对，没有创建下级代理。
- 本审查仅新增此文件，不改产品、作者报告，不提交、merge 或 push。

## Standards

未发现需要阻断的风格或模块边界问题。manifest 同样 bundling 是现有 esbuild 构建方式的局部修正；SDK/shared 精确配对且 lock 的 registry URL/integrity 同步变更；没有引入私有 Host API 或额外加载框架。没有把已有的重复配置升级为本片重构任务。

Standards：0 项硬违规；不把工具本可检查的换行/格式作为审查缺陷。

## Spec / 代码与交付问题

### R1 — P2：`minimumHostVersion` 无必要地低于 main 原有兼容下界

位置：`src/plugin/manifest.mjs:53`；同根测试：`tests/core/official-sdk-pairing.test.mjs:8`。

原值 `2026.1023.0` 被改为 `0.3.1`。固定官方源码的实际链路是：

1. `server/src/app.ts:1009–1013` 将 `opts.hostVersion ?? serverVersion` 传入 loader；`server/src/index.ts` 没有 hostVersion override。
2. `server/src/version.ts:196–210` 明确为无 `.git` 的 Docker 优先采用发行 build stamp；目标实例 health 的日期版本是主代理实测，而非本审查独立重跑。
3. `server/src/services/plugin-loader.ts:1164,1323–1332` 读取该 hostVersion，并在 `compareSemver(hostVersion, minimumHostVersion) < 0` 时拒绝安装。其 `1023–1035` 按 major/minor/patch 比较。

因此目标 `2026.1106.0` 本来就满足 main 原有门槛；为安装目标镜像不需要降到 `0.3.1`。新门槛会额外放行此前拒绝的版本（例如 `2026.1022.0`，以及许多 `0.x` 版本）。这不是声称这些旧 Host 必然在某个具体 API 崩溃，而是可以直接证明插件的安装兼容保护被扩大，却没有旧版本兼容证据或需求。Compose 完整 image pin 只约束使用这些 Compose 的实例，不能替代 tarball 自身对其他安装目标的声明。

原计划第 34、64 行的 `0.3.1` 要求建立在错误的 loader 版本假设上，作者照字面实现不能消除已纠正事实后的回退。它也与计划保留 main 既有边界的方向不符。新测试只断言这个错误常量，故 2 项通过不构成版本保护证据。

**最小修复**：将门槛设为本次唯一承诺支持的日期发行下界 `2026.1106.0`，同步测试；断言目标被接受、早于该目标的版本被拒绝。若主代理有明确理由继续承诺 main 旧 Host，可选择保留 `2026.1023.0`，但不要降为 `0.3.1`，且需说明兼容范围。无需添加 Host override 或修改官方源码。

这是需在 S1 关闭的中等严重性兼容元数据缺陷，不是已证实的安全利用或 Core 不变量破坏。

### R2 — P3：当前 bootstrap 使用说明仍固定旧 CLI

位置：`README.md:66–69`。

README 当前部署步骤仍运行 `npx --yes paperclipai@2026.1023.0 auth bootstrap-ceo ...`，并称其为 pinned CLI。它不是历史记录段落；用户按文档操作会在新的 `2026.1106.0` Host 旁下载、执行旧版 CLI。此次活动 `.mjs` 脚本扫描没有其他旧 image/tsx 启动路径，但扫描不能忽略 README 中可执行的当前命令。

没有实测证明旧 CLI 必然失败，因此不将它升级为启动阻断或安全漏洞。建议把此命令更新到官方目标版，并用主代理现有的唯一 Host 验收核对 bootstrap；若确需旧 CLI，需明确保留理由与兼容证据，而非默认为升级完成。此项属于 S1 文档一致性，不要求为此另开 Docker/DB。

Spec：1 项 P2 需修正，1 项 P3 文档残留；最高严重性 P2。

## 已确认的实现边界

- **公开契约**：`git diff` 中 manifest 仅版本门槛一行变化；工具参数 schema、41 项 capability、9 条 API route、agents 配置等源码未改。没有用“工具名称相同”代替完整 schema 源码核对。新测试自身只保护两个工具名称和 capability 被 SDK 收录，不保护完整 schema，也不证明每项 Host API 行为。
- **SDK 配对**：package 与 lock 精确升级 `2026.1106.0`；shared 由 SDK 精确依赖，不需要为了版本配对新增一个并无直接导入需求的应用依赖。registry 元数据核验是作者/主代理报告，本审查没有另行安装或下载 npm 包。
- **manifest 外部依赖**：`scripts/build.mjs:23–35` 对 manifest/worker 使用 `packages: 'bundle'`；manifest 的 semver 随之进入 bundle。独立读取现有隔离包能够实际导入 manifest 和 trusted adapter，而不是仅靠正则扫描断言可靠。
- **保留外部依赖**：UI 的 React/SDK UI bridge 仍由 Host 提供；其他分立入口的依赖策略未变。不能把局部 bundling 描述为所有入口和 Pack 均自包含。
- **官方启动**：`compose.real.yml:20` 使用 `sh -ec`、`umask 077`、只读源凭据复制后 `exec node server/dist-runtime/index.mjs`；没有覆盖官方 ENTRYPOINT。固定 release 的 Dockerfile 明确 `WORKDIR /app`、tini/entrypoint 及此 CMD；entrypoint 在 `gosu node` 后执行命令，因此没有发现此变更新增 root 运行 Host 的问题。`-e` 还避免凭据复制失败后仍启动。默认 UID 下的 tmpfs 目录存在，但凭据 bind 可读性、实际落盘权限、重启仍未实测。
- **RPC**：namespace 已为 `plugin_worker_smoke`，15 秒超时和 stderr 保留。作者 RPC 驱动对 Host 调用回 `null`，只证明 worker 初始化协议，不能证明真实 Host 权限、迁移、catalog 或执行能力。
- **Runner / heartbeat**：产品 manifest 本来就显式选择 codex adapter，不是对所有平台默认 adapter 的断言；真实 codex 脚本的断言有显式配置前提。主要 e2e 路径按已知 heartbeat ID 查单条；其他列表型诊断/回归脚本仍有查询，不能被当作完整历史清单。没有发现本片必须增加历史扫描系统的证据。

## 独立执行记录

1. 一次 reviewer focused：`node --test tests/core/official-sdk-pairing.test.mjs`，2 passed / 0 failed / 0 skipped，约 1.14 秒。因果：验证 SDK capability 配对与三份 image/real command 静态约束；不跑无关 Core 全套。测试在现有 `tests/core/*.test.mjs` glob 内。
2. 只读包复核：复用作者既有解压目录 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s1-b6449440e25c4c9fa59666a320ac85e4/package`，没有复制/解压新包。清除本进程 `POLYFORGE_*` 后导入 `dist/manifest.js` 及 `dist/trusted-pack-adapters.mjs`。包根无 `node_modules`；结果为 28 agents / 61 skills，adapter 为 `adlc@0.3.2`、`creative-team@0.3.1`，build mode 为 `compiled-bundle`。
3. 同次读取计算既有 tarball SHA-256：`2f93eb7aa9f0e6098295e29564b3233fb3b4061c6fa806d2c7a31df76ef8f112`，与作者报告一致。**这是修复 R1 前的包**，后续产品修正会使它不再是最终候选。
4. 包测试目录中存在作者另行写入的 `polyforge.runtime.json`，指向开发机固定 Packs checkout；`pack.json` 文件清单确认该 sidecar 不在 tarball 内。上述成功是“无包根 node_modules + 有显式外部 Pack 配置”，不是没有外部源码的 S4 检查。没有独立逐键比较全部角色/技能内容，也没有重跑 worker RPC/force reload。
5. 只读包复核前两次命令未完成：首次 PowerShell 原生命令引号导致 Node 语法错误，第二次读取既有 `pack.json` 遇 BOM，均在插件 import 前终止。分别改用 stdin 和去除读取文本 BOM 后，同一只读检查完成；没有修改产品或证据输入。这两次不是产品失败或通过。
6. 独立读取固定官方 commit `d69631b01b9c658f80bf8bed389863dce82643e1` 的 Dockerfile、entrypoint、app、version、loader、index 源码。Context7 查询返回 master 文档，仅作通用 manifest 语义参考，不当作固定发行证据。

### 主代理新增的真实 Host 证据（非本审查独立执行）

主代理报告：核验上述 tarball SHA 后解压到另一个独立安装目录，仅保留打包内容和人工部署 sidecar `{"packEntries":["/opt/polyforge/packs/index.mjs"]}`，不含 `node_modules` 或 Graph 开发源码；候选及固定 Packs 分别只读挂载。目标 pin 以官方 ENTRYPOINT/CMD 启动，network none、无对外端口、loopback local_trusted、heartbeat 关闭、tmpfs 隔离数据库。

报告结果：`POST /api/plugins/install` 返回 ready / `0.8.7`；plugin health healthy、registry/manifest/status 检查通过；manifest 28 agents / 61 skills 逐键与固定 Packs exports 独立计算一致。新建仅测试 company 后，真实 `GET /api/plugins/pohlee.polyforge-graph/api/settings?companyId=...` 成功，worker catalog 为 `adlc@0.3.2`、`marketing@0.0.4`、`creative-team@0.3.1`。未运行 Graph、Agent 或模型。

本审查静态读取了 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-host-20261111.mjs:26–36,67–90`：隔离参数、真实安装请求、角色/技能逐键比较、settings catalog 比较均存在，未以 fake Host 回包替代安装。读取同前缀 `.json` 确认持久化的启动结果为 `status=ok`、`serverVersion=2026.1106.0`、目标 commit。注意：该 JSON 只保存启动阶段，安装结果由驱动打印到主代理终端，本审查未重新读取其终端输出；安装通过的执行来源是主代理明确报告，不冒充独立重跑或独立读取的安装日志。作者报告稍后同步此结果。

因此现在已有“显式外部 Packs + sidecar”的真实安装/worker catalog 证据，不再把安装标为完全未验证；仍没有无外部 Packs 的 S4 证据、全部 API 行为证据、authenticated Compose 凭据 bootstrap 证据或 V1 终态证据。主代理累计已创建 2 次测试 DB，额度耗尽；不得为审查或修正再开 DB。

本审查没有运行 npm install/build/pack、Docker、全回归、DB、真实 Agent 或付费模型，没有新建测试数据库或完整源码快照。新增磁盘占用只有本报告。审查预算上限 20 分钟；执行在该窗口内完成，未消耗作者的产品修改验证周期。两次检查命令错误如上如实保留，不计作产品通过。

## 待实测门槛与下一最小动作

- 将主代理已通过的安装、worker health、sidecar 生效和完整角色/技能/catalog 结果补入作者报告，保留 tarball 标识及执行出处；无需为本审查重跑。源码 `src/plugin/manifest.mjs:5` 的已有 catch 会把 catalog 错误降为仅 CEO，现有逐键断言能识别该退化，不是仅凭 HTTP health 或 manifest 非空验收，也不是本片新增缺陷。
- `compose.real.yml` 凭据 bootstrap 尚未运行；固定官方启动源码支持当前实现，但不等同权限与重启实测。
- 安装成功不代表 V1 完成。旧 `ui-ux-design` fixture 和 graph ID 不适配固定 main；本片只完成预检，不应伪称终态/错误身份拒绝已通过，也不需把完整 fixture 重写塞进此审查。
- 作者最小纠正仅限 R1（及主代理同意的 R2），同步 focused 断言；修正后旧 tarball 不能继续作为新候选已实测的冒名证据。按剩余预算选择一次必要构建/候选更新与受影响验证，不能自动增加完整回归或数据库额度。若旧实例仍可安全使用，是否对同一实例做最小候选更新由主代理在预算内决定；否则保留最终候选未实测状态，不新建 DB。
- R1 关闭且最终候选证据边界清楚后，可接受为“本片 S1 安装就绪”的有限结果；完整发布仍等待已授权后续切片与 V1，S3/S4 缺失本身不被本报告冒充成 S1 回归。

## S1 纠正与 S2 最终复核

### 结论及复核范围

本次为用户明确授权的唯一有界 followup，上限 12 分钟；仅更新本报告，没有委派、改产品/作者报告、提交、Docker、build、npm install、数据库或全回归。原 Graph 基线仍为 `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`；审查对象是该基线上的当前未提交工作树，不虚构最终源码 commit。除既有 S1 文件外，新增产品差异仅 `src/host/check-runner.mjs` 及其现有测试；公开 schema、capability、Core 状态机和 migration 没有本次变更。

**接受本次 S1 纠正和 S2 局部代码；无未关闭的审查阻断项。**这不是完整 SDK API 审计或全产品回归通过。Standards 轴无新增硬违规；Spec 轴 R1/R2 已关闭，S2 行为符合所选局部规格。没有发现新增生产安全、数据损坏或 Core 不变量问题。

### R1 / R2 关闭依据

- **R1 关闭**：`src/plugin/manifest.mjs:53` 现为 `minimumHostVersion: '2026.1106.0'`。`tests/core/official-sdk-pairing.test.mjs:9–13` 验证目标满足，以及 `2026.1023.0`、`2026.1022.0`、`0.3.1` 均不满足。针对这些普通 release semver，其比较方向与首轮独立核对的官方 loader 源码相符；不是实际启动三个旧 Host 的负向集成检查。既有宽松门槛不再存在。
- **R2 关闭**：`README.md:60–73` 的 release / commit / digest / bootstrap CLI 已统一为目标发布，且明确旧 `ui-ux-design` fixture 不可作为当前 V1。官方目标 CLI 可获取性由作者/主代理的 `npm view` 证据支持，本审查未下载/执行；关闭的是“当前文档仍指向旧版”的缺陷，不宣称 CLI bootstrap 已通过。
- 新包中 `dist/manifest.js` 含纠正后的日期门槛；其 source map 嵌入的 manifest 源码与当前源码一致，避免仅源码修正而候选仍带旧门槛。

### S2 行为、失败与清理核对

位置：`src/host/check-runner.mjs:7–30,85,215–220`。

1. 每次写入生成 `${path}.${randomUUID()}.tmp`，与目标同目录，不再共用固定 `.tmp`。完整 JSON 仅先写入这一个临时路径；不直接截断目标文件。
2. rename 是唯一提交点。第一次立即尝试；仅 `platform === 'win32'` 且错误 code 为 `EPERM` 或 `EACCES` 时重试，五次等待严格为 10 / 20 / 40 / 80 / 160 ms，总共最多六次 rename。并非任意文件系统错误都重试，也不是无限等待。
3. 非 Windows、非目标错误、或重试耗尽时直接抛出此次 rename 原始错误对象，没有转成通过。失败前目标旧 JSON 不被删除。写临时文件失败也进入 finally，不重试写入或假称提交成功。
4. finally 只 unlink 本次 UUID 路径，不扫描、覆盖或删除其他写入方临时文件。rename 成功后该路径通常已不存在；清理异常被抑制，既不掩盖主失败，也不把已提交的 rename 反转成失败。若文件系统连 unlink 都拒绝，可能残留本次临时文件；实现和作者报告均未承诺这种条件下仍保证清理成功。
5. `runChecks` 的所有 save 以及 `readCheckResult` 的 acknowledge 都复用此 helper；原 manifest 字段、完成通知与 ack 条件未变。它提供原子替换和有限共享冲突重试，**不提供跨进程 CAS、不阻止业务层丢失更新，也没有新增锁或 FileStore 多写者保证**。没有为未要求的并发事务语义判失败。

### S2 测试强度与限制

位置：`tests/core/check-runner.test.mjs:90–152`。

- 注入两次 `EPERM` / `EACCES` 后执行真实 rename；每次 rename 前均读取并解析完整旧 JSON，完成后解析新 JSON，验证旧数据保持到提交点，而非只检查 helper 被调用。
- 耗尽分支断言 6 次尝试、完整五次延迟和同一原始错误对象；另验证 Linux `EPERM`、Windows `ENOENT` 只尝试一次且不等待。Windows `EACCES` 的重试成功已有覆盖，但没有独立穷举其耗尽或所有非 Windows 平台；这些共享相同明确条件，不构成需扩写才能交付的缺口。
- 断言正常成功及 rename 失败后的本次 temp 清理，保留另一写入方 sentinel；真实 save / acknowledge 保留完整 JSON、ack 字段且无 temp 残留。另验证清理失败不掩盖部分写入的主失败或已成功提交。
- 本测试没有制造实际 Windows 共享文件句柄冲突，等待函数为注入记录，未验证定时器精确 wall-clock 延迟；也没有多进程并发读压测或独立“两个同时调用必须不同 UUID”的测试。源码使用标准 UUID 且控制流直接，现有行为测试足以支持本次有限修复；不据此扩张验收或声明所有文件系统上的持久化保证。

### 本次实际独立执行与候选绑定

- 执行一次 `node --test tests/core/official-sdk-pairing.test.mjs tests/core/check-runner.test.mjs`：**13 passed / 0 failed / 0 skipped / 0 cancelled**，约 2.22 秒。因果是 S1 门槛断言已改变且 S2 新增文件写入分支；该范围同时覆盖保留的 check-runner 行为，不触发全回归。
- 独立 `Get-FileHash` 核验候选 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s1-s2-corrected-de59090ce87148f7811c17af239df2cf/pohlee-paperclip-polyforge-graph-0.8.7.tgz`：SHA-256 **`c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa`**。
- 用 Python 标准库只读 tar 成员，不解压/生成新副本：`dist/host/check-runner.js.map` 和 `dist/check-runner.js.map` 嵌入的 `src/host/check-runner.mjs` 均与当前源码一致（只归一 CRLF）；`dist/manifest.js.map` 对应 manifest 亦一致。并检查 built manifest 的日期门槛及 built runner 的五档 retry 数组实际存在。该结果绑定已审源码与包内来源，**不是执行新包中的 check-runner 或证明构建所有字节的语义等价**。作者的新 build/RPC 通过为作者证据，本审查没有重建。
- tarball 仍没有 `polyforge.runtime.json`。部署继续需要固定 Packs 只读挂载及显式 sidecar；不能把 source map 检查、旧包/新包相同 `0.8.7` 版本号当作 S4 或候选同一性的证据。
- 旧 SHA `2f93eb7aa9f0e6098295e29564b3233fb3b4061c6fa806d2c7a31df76ef8f112` 的 Host 安装/health/settings 成功保留为历史，不能覆盖新 SHA。followup 初次写入时，主代理正在复用现存第二个隔离 Host/DB，通过官方 upgrade 更新新包，尚未收到结果；当时只能确认驱动含新 manifest 门槛、完整角色/技能和 settings catalog 的断言。后续实际失败和通过见文末，不将“存在驱动”当作“执行通过”。

### 新增 bootstrap 证据的准确边界

主代理报告同目标镜像、官方 entrypoint、相同 `sh -ec` / `umask 077` / cp 路径和 tmpfs，在 UID 1000 下用假凭据复制成功。Windows bind 源使目标 mode 为 `0700`；owner 可读写，group/other 无权限，内容一致。最初 helper 的 exact `0600` 断言失败，改为既有 owner-private 契约后通过，产品未增加 chmod 或改变主逻辑。

本审查静态读取 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-host-20261111.mjs:100–119`，其断言确为 UID、`mode & 0077 === 0`、owner read/write、假凭据内容，并且该模式没有启动数据库/Host server。执行结果来源是主代理，本审查未重跑 Docker。未发现仅因 owner execute 位存在而必须阻断本片的依据；**这不是实际 Codex 认证、完整 authenticated Compose 启动、重启或 CLI bootstrap 验证**。

### 剩余交付门槛与停止边界

- 本片代码审查可以接受；最终候选官方 upgrade / health / 完整 manifest / settings catalog 的新 SHA 结果现已记录于文末。该结果关闭本片待定的 Host 安装就绪门槛，不覆盖所有 API 或 V1。数据库创建已 2 次，不得再建；本审查未占用数据库或 Host 资源，也未开启同根因第三轮产品修改。
- S3 显式单一 Packs 来源和双 root 一致性、S4 自包含及完整性绑定均未完成。用户本轮已授权它们，应在后续有限切片实施，或由用户明确改变交付范围；不能在本片标记完成。其缺失不是此次 S1/S2 新代码回归。
- V1 的真实 Graph / Agent callback / 错误身份拒绝 / 合法重试和终态仍未运行。安装、upgrade 或 settings 成功均不能替代它。真实模型质量不在本次验收内。
- 最终发布还需按计划选择未使用的候选版本并同步 package、manifest、Core/runtime artifact，以及完成受影响回归和对应合并门槛。当前 `0.8.7` 是切片候选标识，不是已批准发布版本；没有要求在本次审查内另做版本工程或全回归。
- 本次仅新增执行证据和报告结论，未启动新的修复路线。既有作者同根因两轮预算已用尽；本次无失败重跑，复核在获批 12 分钟内完成。

## 最终 Host 证据补充（只读纳入，不重跑 Docker）

### 失败、部署根因与唯一纠正

主代理报告：核验最终 `c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa` tarball 后，在同一个已运行 Host/DB 的原插件路径替换包。第一次官方 `POST /api/plugins/pohlee.polyforge-graph/upgrade` 虽返回 ready，却仍返回旧 manifest 的 `minimumHostVersion=0.3.1`，故驱动严格断言失败；**该次不是通过**。

主代理诊断发现新旧 npm tarball 的 `dist/manifest.js` 都带固定 mtime `1985-10-26T08:15:00Z`。新进程直接导入磁盘文件读到 `2026.1106.0`，但原 Host registry 仍保存 `0.3.1`，符合相同 import URL 复用缓存的因果链。本审查新增只读核验固定官方 commit 的 `server/src/services/plugin-loader.ts:1350–1360`：其 `loadManifestFromPath` 的确只用路径和 `Math.trunc(stat.mtimeMs)` 组成动态 import URL，没有使用文件内容 hash，因此同路径、同 mtime 的内容替换可命中旧 ESM 缓存。归档 mtime、磁盘 SHA 和新进程/registry 对照的执行出处为主代理，不冒充本审查独立复现。

未改 Host 或放宽断言；主代理以 `tar -xmf`（不恢复归档 mtime）将**同一最终包**重新部署到同一路径，确认 manifest 前后 SHA-256 相同而 mtime 更新为 `2026-11-11T01:29:40Z`，然后对同一实例执行相同官方 upgrade 和断言通过。没有新建数据库、换实例或篡改版本。此为新发现的部署缓存根因的一次方法纠正与重验，不是 S1 产品代码第三轮，也不是完整回归。

### 最终成功证据及独立核对

本审查直接读取 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-host-20261111-upgrade.json`，确认：

- `stage=plugin-upgrade`、`status=ready`、`version=0.8.7`、`minimumHostVersion=2026.1106.0`。
- `agents=28`、`skills=61`；catalog 为 `adlc@0.3.2`、`marketing@0.0.4`、`creative-team@0.3.1`。
- plugin health 为 healthy，registry / manifest / status 三项均通过。
- `candidateTarballSha256` 为完整最终 SHA `c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa`，与此前独立计算一致。

再次只读核对同前缀 `.mjs:68–98`：upgrade 分支仍严格断言日期门槛，roles/skills 为逐键与固定 Packs exports 比较，并真实请求 worker settings 比较三包 catalog。JSON 汇总计数本身不包含所有键，逐键执行保证来自驱动断言及主代理执行，不能仅凭计数宣称内容完全相同。执行者为主代理；本审查只读核验记录和源码，未重跑 Host。

### 必须保留的部署前提与结论

本次“同一路径替换后官方 upgrade”的有限成功前提包括：固定 Packs 只读挂载、显式部署 sidecar，且**替换 manifest 后刷新其 mtime，使 loader 的截断毫秒缓存键改变，再请求 upgrade 并核验 registry 实际门槛/manifest**。不能仅保留 npm tarball 的统一历史时间，也不能只看 ready 就认为新代码已加载。`tar -xmf` 是这次已验证的方法，不是对所有部署平台或文件系统时间精度的自动保证；后续部署说明应保留此条件和实际验证项。

因此 S1 官方目标包的真实 Host 安装就绪证据现已覆盖最终候选；结合 S2 源码/包来源核对和 13 项 focused，本片 S1/S2 可有限接受。该 Host 路径没有执行 S2 的真实共享句柄场景，亦未执行 Graph/Agent/模型；S2 行为依据仍是独立 focused 与代码审查，S3/S4/V1、发布版本及对应最终合并门槛保持未完成。保留首次缓存碰撞失败，不以最终成功抹去历史，也不继续自动追加修复或资源。
