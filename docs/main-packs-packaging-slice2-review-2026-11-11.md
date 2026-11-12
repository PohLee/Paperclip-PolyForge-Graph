# S3 / S4 独立审查（2026-11-11）

## 最终状态：S4 R1 已关闭，S3/S4 离线有限接受

唯一有界纠正复核已完成：默认 snapshot 的整体字节 SHA 从同次构建的精确 snapshot 字节生成，分别编入 manifest 和 worker，并在实际默认读取路径校验。独立最小 focused **3 passed / 0 failed / 0 skipped**；新包源码映射、两个实际 built SHA 比较及 11 个 artifact 文件 / 15 个迁移字节均已核对。**R1 关闭，本片无未关闭审查阻断；S3/S4 仅按离线代码/包级证据有限接受**。

新候选 SHA-256 为 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`，不同于首轮有缺陷的 `6102d0ec…`。主代理对该新 SHA 的 Node24 完整包 health 正向及删行拒绝负向结果现已只读核验，模拟协议 fixture 的失败历史另记于文末。真实 Host 对新 v3 候选的安装/升级、实际 API、V1、正式版本和最终发布仍未验收；旧包成功不能移植。以下保留首轮问题、失败和旧候选证据，首轮“需修正”不是最终状态。

## 首轮结论：需修正；S4 存在一项验收阻断

发现 **1 项 P2：默认 snapshot 的完整 Pack 集合没有在实际读取路径绑定**。逐行 digest 和重复检查不能识别删除完整 Pack 行；manifest 对内嵌值不一致的处理又允许该残缺值成为默认 catalog。v3 外部 verifier 能拒绝这种字节变动，但 manifest/worker 的读取路径没有调用它。此项阻止将 S4 标为完整性验收通过；不是要求新增签名系统或新架构。

S3 单一 root 和定向 adapter 编译未发现阻断缺陷；v3 格式拒绝策略清楚。独立 focused 14 项通过、最终包字节检查通过、主代理 Node24 隔离包检查通过，均不能覆盖上述缺口或替代真实 Host / V1。未发现已证实的数据损坏、授权规则变化或生产安全利用。本报告只审 S3/S4，不重新裁决未改变的 S1/S2。

## 范围、固定输入与预算

- 审查者 GPT-6.1 Sol；只读实际代码、测试、作者报告和既有包。唯一新增文件为本报告；没有产品修复、委派、提交、merge、push。
- Graph baseline `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`；源码为其上的未提交工作树，不虚构最终 commit。Packs 固定 `6ad0652828b3075b72e457e2afa1b0807dcd929e`，作为只读构建输入。
- 规格为 `D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph/docs/main-selective-salvage-plan-2026-11-10.md:100–137`，以及 BDD-S3-01、BDD-S4-01/02。作者记录为 `docs/main-packs-packaging-slice2-2026-11-11.md`，只读。
- 用户明确新授权窗口 30 分钟，其中本审查最多 20 分钟，剩余供主代理包级验证；收到后续消息不重置预算。此前第二片时钟跨越导致实际活跃耗时未知，本报告不追认旧片符合时限。
- 继承 S1 同根因两轮已用尽、全回归 0/2、测试 DB 2/2 已耗尽、可见累计新增约 0.13 GiB / 2 GiB。没有新 DB、镜像拉取或完整源码快照。

## Standards

未发现需要阻断的代码标准问题。新 helper 局限于来源选择、固定 importer 重定向和无领域行为的 canonical digest；没有引入实验执行器、迁移、任意 Pack executable 加载接口或签名体系。仓库未提供额外编码标准；不以已有重复 canonical 逻辑为由扩张重构范围。

## Spec：按严重性的问题

### R1 — P2 / S4 验收阻断：删除默认 snapshot 的完整 Pack 行仍会被接受

位置：`src/plugin/pack-snapshot.mjs:13–24`、`src/plugin/catalog.mjs:91–97`、`src/plugin/manifest.mjs:5–10`。

`readPackSnapshot` 只要求非空数组，检查各行内容 digest 和重复 id/version；没有校验完整 catalog 的集合或预期文件摘要。`loadCatalog` 默认读取 JSON 后直接返回该函数结果。manifest 虽嵌入完整 build catalog，但只在 JSON 相等时用内嵌值；不相等时总是使用 loaded catalog，没有区分“显式配置覆盖”与“默认 snapshot 内容偏离构建”。

**只读复现**：读取最终包 `dist/packs-catalog.json` 到内存，删除 `marketing@0.0.4` 整行，保持所有剩余行及其 digest 不变。当前 `readPackSnapshot` 成功返回 `adlc@0.3.2`、`creative-team@0.3.1`；该值与原内嵌三包不相等，因此 manifest 当前分支会选用两包。没有修改包、源码或磁盘 snapshot，也不需要伪造任何 digest。

这是可证明的默认集合丢失：Marketing 角色/技能从 manifest 消失，worker registry 接受非空的两包后也不必报错。不是外部可信源显式覆盖，不是重复 id/version，也不是当前测试已覆盖的“修改某行版本而保留旧 digest”。

`verifyRuntimeArtifact` 的文件字节检查确实能拒绝删行；但它由外部 preflight 调用，不在 `loadCatalog`、manifest 或 worker setup 路径上。因此不能用 verifier 单独通过来声称“读取默认 catalog 也拒绝完整性偏离”。此缺口直接涉及计划第 127–132 行和 BDD-S4-02 的默认 catalog/完整性绑定，不是增加新的生产场景。

**最小修复方向（仅建议，不实施）**：在没有显式来源时，把默认 snapshot 的完整内容/集合绑定到受构建确定的预期值，例如核对 artifact 中该文件的原始字节摘要，或用构建时同一 catalog 的整体摘要并在 worker/manifest 两侧校验。不要用 runtime 固定三包白名单替代真正绑定，也不要阻止已授权的显式来源覆盖。补一个“移除完整行、其他行 digest 不变”的实际 built catalog/manifest 负向断言，并确认 worker 不会把它变成健康的残缺 catalog。无需增加签名、Host patch 或新数据库。

本项判为中等严重性完整性/功能缺失，阻断 S4 当前验收，不声称已发生生产数据损坏或授权绕过。代码只读，发现后没有自动修复或开始额外产品验证轮次。

## 已核对且未列为缺陷的事项

### S3 单一来源与固定集合

- `scripts/build.mjs:11–24,35–39,52–53` 将 `POLYFORGE_PACKS_SOURCE_DIR` 解析为单一绝对 root，传给来源 helper、adapter esbuild plugin、snapshot 和 manifest define。错误显式目录的 import 失败，不回退相邻目录。
- `scripts/pack-build-source.mjs:5–22` 从同 root 读 collection 及 ADLC/Creative 单独模块；比较 id/version 和 canonical digest，避免 catalog 与 descriptor 数据不一致。缺 adapter 会在 esbuild 解析选择 root 的绝对路径时失败，而非悄悄回到相邻 checkout。
- `scripts/trusted-pack-imports.mjs:4–18` 仅允许 trusted adapter 文件这个 importer 和四个准确 specifier。未匹配 importer 不获得重定向；不是任意 Pack JavaScript 的执行注册表。
- build log 输出 Graph SHA/dirty、Packs root/SHA/dirty、各包 id/version/digest。作者明确当前 Graph dirty，未把 baseline SHA 冒充最终源码 commit。
- helper 强制 build collection 恰为 main ADLC/Marketing/Creative，而不固定其版本或角色/技能。对本次固定三包交付，这能防止误混实验 Pack，未改变运行时 registry 对多个历史版本或导入 Pack 的既有机制，也没有硬编码 Agentic Improvement。因此不把这项 build 输入约束列为无必要运行时架构限制；将来扩展产品包集需要明确调整，当前不是通用 Pack builder 承诺。

### digest、字节及显式覆盖

- `src/plugin/pack-snapshot.mjs:3–7` 使用原 adapter 的递归键排序 JSON / SHA-256，`trusted-pack-adapters.mjs:25,32` 复用。与既有 `pack-host-support.mjs:3–5,55–60` 的 canonical 身份语义一致；没有改变 Pack `release.digest`。
- 实际包的三个 canonical digest 与作者记录一致；实际 `release.digest` 是另外三个不同值，不能混用或宣称它们相等。
- 显式参数 > 环境变量 > package-root config > 默认 snapshot > 仅未构建开发态缺 snapshot 时的相邻 fallback。显式空数组、错误路径、坏 JSON、坏逐行 digest、重复发布版本和 built 缺 snapshot 均有抛错路径。
- `force` 对默认 JSON 每次重新 readFile；显式 `.mjs` 来源继续由独立 worker 重建模块图。registry 保留已加载旧 catalog 并把失败 reload 记为 degraded 是原有恢复策略，不是 `loadCatalog` 偷偷回退相邻包。旧 pinned run 的保留不等于新 snapshot 验收。
- manifest 已取消原来 `.catch(() => [])`，默认 snapshot JSON/逐行 digest 错误会阻止 manifest import。显式 A 覆盖 B snapshot 时，manifest 与 runtime 都选择配置 A；adapter 仍是编入的 B，旧有 host-support 按完整 pack digest 拒绝不匹配的受治理图，不会根据配置执行任意 A 的 JavaScript adapter。这是显式覆盖的现有可信边界，不可把它描述为自动重新编译了 adapter。

### worker 初始化 catch：既有行为与实际错误传播

- `src/plugin/worker.mjs:623–627,651–653` 的初始化路径确实 catch `packRegistry.installed()` 错误、记录 warning 后继续 setup。该 catch 未在本片新增，**initialize 成功不证明 catalog 成功**。
- registry 在 `src/plugin/pack-registry.mjs:71–86` 把加载失败记入 globalFailure 并继续向调用方抛错；`59–68` 对其报告 degraded。worker `794–795` 返回 registry health。
- `company-api.mjs:44–47` 的 settings 先 `engineFor`，worker `132–134` 经 registry `forCompany -> installed`，失败会到 `worker.mjs:788–791` 转为错误响应。因而语法错误、digest 错误、缺文件并不会从 API 路径被假装为正常 catalog；没有因为既有 initialize catch 就要求新增 Host 启动架构。
- 这些是静态调用链和 registry focused 支持的结论，不是对本候选真实 worker API/Host health 的独立实测。R1 的删行场景不同：它根本没有触发 validator 错误，既有传播机制不能补救。

### v3 verifier / preflight / upgrade

- `scripts/runtime-artifact.mjs:6–8,63–95` 加入 snapshot 文件，并明确 v3。文件键集合、每个文件实际字节、迁移 inventory/content、package/runtime 版本均检查；不是只比较 metadata 声明。
- `runtime-preflight.mjs:55–59` 调用当前共享 verifier；`upgrade-runtime.mjs:38–41` 重跑同一 preflight，并绑定 reviewed metadata digest、文件、company 范围和 installed path。没有另一个硬编码 v2 verifier 留在这些当前入口中。
- UI 的公司级 raw runtime preflight 仍是 metadata compatibility 检查，不验字节；README 第 89 行明确区别，未虚报所有入口都验 artifact。
- 实测当前 verifier 拒绝旧 v2，baseline 的真实 v2 verifier 拒绝 v3；旧候选需重建、操作者需使用匹配 v3 verifier。格式变化清楚，不建立迁移/双轨兼容。真实官方 upgrade 对这个最终包尚未验证，不由模拟 fetch 测试覆盖。

## 本审查实际执行

1. 一次必要 focused：`node --test tests/core/packs-packaging.test.mjs tests/core/pack-registry.test.mjs tests/e2e/runtime-upgrade.test.mjs`，**14 passed / 0 failed / 0 skipped / 0 cancelled**，约 0.75 秒。覆盖 A/B 数据与 executable adapter 可辨识、显式覆盖、损坏/重复/缺 snapshot、force 嵌套模块重读、registry 失败状态、v2/v3 以及 preflight/upgrade 来源约束。含测试 fixture 的小型 esbuild 编译，未运行产品 `npm run build`。
2. 测试调用与正式 build 共用来源 helper 和 plugin，但不是运行两次完整产品 build，也没有给真实相邻 checkout 写入 A。实际 B adapter 行为和 manifest 标记断言能发现常见相邻污染；环境变量到正式 build 的传递另由静态代码核对。
3. 独立核验最终 tarball SHA-256：`6102d0ece4d0524150beba806f1ffb73d36a9e0e3ee96d031bb01486cd8e88d5`。路径为 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s3s4-final2-d61ca00f76fc4262837344c7b2c97a69/pohlee-paperclip-polyforge-graph-0.8.7.tgz`。
4. Python 标准库只读 tar 成员，逐个核验 artifact 声明的 11 个文件和 15 个迁移的实际 SHA，并核对迁移完整文件集合；无新解压/全量源码拷贝。检查 manifest、worker、trusted adapter 的 catalog/snapshot/manifest/adapter source map 内容与当前源码一致（归一 CRLF），共 7 个匹配；adapter source map 的 Packs 来源仅所选 `D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph-Packs` root。source map 是来源佐证，不是任意第三方代码可信性的证明。
5. 对作者既有解压目录执行当前 `verifyRuntimeArtifact` 只读检查，通过；读取实际 snapshot 并用当前 helper 校验三包摘要，通过，角色 27 + CEO、技能 61。没有导入/运行 candidate worker。
6. 在内存移除真实 snapshot 的 Marketing 行，调用当前 validator，确认两包被接受；这是 R1 的只读定向证据，不改 fixture 文件、包或产品，不是第二次全套/focused 重跑。

本审查没有 npm install、产品 build、pack、Docker、Host、DB 或付费模型；未运行全回归。focused fixture 按既有测试清理其自有临时目录，新增长期文件仅本报告。本次执行没有失败/重跑。未据作者多次新增断言/更名推定预算重置，也未将次数本身伪造成代码缺陷；旧时钟/活跃时长未知保持未知。交付后停止，不自动派生修复路线。

## 主代理独立包级证据（本审查只读核验记录）

读取 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-slice2-package-20261111.json` 及同前缀 `.mjs`。JSON 记录本最终 SHA、28 agents / 61 skills、workerInitialized=true、5 次模拟 Host RPC，且 externalPacksMounted / packsEnvironment / deploymentSidecar / realHost / databaseCreated 均 false。

驱动在容器外从固定 main Packs 计算预期键；容器仅只读挂载独立解压后的候选，固定官方 image、`--pull never`、network none、UID 1000、Node24，无相邻 Graph/Packs、无 sidecar 或 node_modules，清除 `POLYFORGE_*`。manifest agent/skill 为逐键比较，不是仅非空断言；真实 built worker 在 15 秒内初始化，但 Host 调用回复均为模拟 null。容器已 `--rm` 退出，主代理未新增 DB。

这新增了 Node24 的无外部源码启动证据，不是官方 Host 进程、真实 worker catalog API、force reload 端到端或 V1。尤其不能用该 initialize 成功反证 R1/初始化 catch 的风险。本审查未重复 Docker 检查，也没有把主代理执行冒充自己的独立运行。

## 后续门槛与停止决定

当前可接受 S3 的局部代码及 v3 配对方案；**S4 在 R1 关闭前不接受完整性验收通过**。按用户约束，仅报告最小修复方向，不修改产品，不自动开始第三轮或降低现有断言。若作者路线/预算已用尽，由主代理与用户决定新的有限切片或接受有限结果，不能通过改名继续。

最终候选的真实 Host 安装/upgrade、实际 settings/catalog 和完整 V1（Graph / Process Agent / callback、错误身份拒绝、合法重试与终态）仍未执行。S1/S2 的旧包 Host 成功不能转嫁给本 SHA。正式候选还需未使用版本号及受影响最终回归；当前 `0.8.7` 和 baseline SHA 不是发布批准或完整源码身份。DB 2/2 限制继续有效，不能通过新建实例绕过。

## R1 唯一有界纠正复核

### 结论与权限

**R1 已关闭；本次纠正未发现新增阻断，S3/S4 可按离线范围有限接受。**这改变首轮对 S4 完整性缺口的判定，不抹去旧包 `6102d0ec…` 的失败。用户约 18:17 明确追加 30 分钟用于此根因纠正、复核和主代理包级验收；本审查最多 10 分钟，不重置该总窗口。作者本根因首次纠正已完成一次修改验证周期，本审查不自动派生下一轮。

仅更新本报告，产品、作者报告、旧审查均只读；没有委派、提交、merge/push、Docker、Host、DB、npm 安装、产品 build 或 full suite。S1 两轮冻结、DB 2/2、全回归 0/2 等继承限制不变。源码仍是原 Graph baseline 上的未提交工作树，不将 baseline 当最终源码 SHA。

### 实际代码关闭依据

- `scripts/build.mjs:25–27` 对同一 `snapshot` 生成一次确定字符串 `JSON.stringify(snapshot) + '\n'`，计算该字符串 SHA-256，然后把完全相同字符串写入 `dist/packs-catalog.json`。没有从另一个 root 或另一个 snapshot 计算预期值。
- `scripts/build.mjs:45–56` 的 manifest/worker 两次 build 都传入同一个 `__PACK_SNAPSHOT_SHA256__`，不再只依赖 manifest 内嵌 catalog 或外部 v3 verifier。额外的 manifest catalog define 仍只用于 manifest 声明，不承担 worker 校验。
- `src/plugin/catalog.mjs:92–105` 在默认来源分支实际 readFile 后、JSON parse 与逐行检查前，校验整个内容 SHA。built 模式缺预期 define 或不匹配均抛出 `Built Pack catalog snapshot does not match build digest`。删除完整 Pack 行即使保留所有剩余行 digest，整体字节也变更，无法仅凭剩余行通过。
- `readPackSnapshot` 仍是通用逐行/重复检查 helper；它自身接受任意合法非空集合并非本次缺陷残留，因为产品默认 built snapshot 现在先通过受构建固定的整体绑定。没有用“三包运行时白名单”替代整体校验。
- 显式参数/env/config 的选择在整体校验分支之前；只有 `configured === null` 才核对默认 snapshot。合法显式来源仍可优先覆盖，未被强制等于内置内容。force 默认 JSON 每次读取后重新校验，显式模块仍走独立 worker，built 缺文件仍抛 ENOENT，未构建开发态的缺 snapshot fallback 条件未放宽。
- v3 格式及文件 inventory 未改；逐行 canonical digest 与 Pack `release.digest` 的既有区别未改变。整体绑定是随候选代码一起交付的一致性检查，不是防止任意修改代码和数据的外部签名/真实性认证。

### 本次独立 focused 与实际包证据

1. 因为 R1 的整体校验及其 worker 失败传播路径改变，只执行一次 `node --test tests/core/packs-packaging.test.mjs`：**3 passed / 0 failed / 0 skipped / 0 cancelled**，约 1.77 秒。未重复无关 registry/upgrade suite。测试包含其自有小型编译 fixture，不是产品 build。
2. `tests/core/packs-packaging.test.mjs:76–86,97–111` 确认同一摘要用于 compiled catalog、manifest 和 worker；正常 worker health 为完整三包 `ok`。删除完整 Marketing 行、保留其余数据和 digest 后，compiled catalog 和 manifest reject，真实 built fixture worker 的模拟 RPC health 为 degraded，并包含 build digest 错误。不是仅检查 initialize 返回 ok。
3. 同一 focused 保留合法 sidecar A 覆盖 B snapshot 及 force、显式错误路径、坏 snapshot、缺 snapshot、v2/v3 拒绝等受影响边界。env/参数的优先条件另以源码核对；没有把该测试宣称为对所有配置形式的真实 Host 验证。
4. 只读新 tarball：`C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s4-r1-52bb797eb8644f0bbd6f8c19a511b572/pohlee-paperclip-polyforge-graph-0.8.7.tgz`。独立算得 SHA-256 **`eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`**。
5. tar 内 snapshot 原始字节 SHA 为 `64e1eb8d6db8455bb303fc1fbcaffe8ef3f498eae150befa05e98ef9dab6847a`；artifact 对该文件记录相同值。直接读取 tar 内 `dist/manifest.js:2936` 和 `dist/worker.js:36760`，两处都实际比较该摘要，非仅 source map 声明。两者 catalog source map 内容均与纠正后的当前源码一致（归一 CRLF）。这关闭“只改源文件/只给 manifest define 而实际 worker 没有校验”的疑问。
6. 同次只读 tar 检查确认 v3、11 个 artifact 文件与 15 个迁移的真实字节 digest 均匹配；没有解压新副本、执行包内代码或拷贝全源码。这个检查和源码 focused 分开记录，不扩大为 Host 通过。
7. 首次只读包检查用正则误假定 esbuild 局部变量必为 `snapshot`，在 worker 使用 `snapshot2` 时检查脚本失败；独立读取实际 built 比较行确认原因后，只修正检查表达式以允许重命名，同一包检查完成。**这不是产品失败、产品修改或 focused 重跑**；失败没有被计为通过。

### 作者包级/主代理验收的来源边界

作者报告本新包的独立解压目录正向 manifest 为 28 agents / 61 skills，worker 模拟 health 为完整三包且 ok；在副本中删除 Marketing 整行后，manifest reject、worker health degraded，最后恢复副本。只读检查作者 `verify.mjs`，其确实在 initialize 后再请求 `health`，并断言删行后的 build digest 错误；未在本审查执行该脚本或改动包。

主代理另在 Node24、只挂候选、network none、无外部 Packs/sidecar 的环境对新候选做正反检查；followup 首次写入时尚未读取最终结果，后续已核验，详见下一节，不以旧 `6102d0ec…` 的 Node24 成功代替它。即使该包级检查通过，也不是实际 Host、数据库、worker settings API 或 V1。初始化的既有 catch 仍可让 initialize 返回 ok；现在默认损坏 snapshot 会使 catalog 加载失败并反映为 degraded，而不会健康地接受残缺集合。

### 最终 Node24 正反包级记录补充（不新增执行）

本审查仅只读以下两个最终 JSON，没有重跑测试、Docker 或产品验证，没有重置 10 分钟复核或用户总窗口：

- `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-slice2-package-20261111-eb08930b6457-truncated.json`：绑定完整新 tarball SHA；`manifestRejected=true`、`workerInitialized=true`，worker health 为 degraded，错误为 `Built Pack catalog snapshot does not match build digest`。原 snapshot SHA 为 `64e1eb8d…6847a`，删行副本为 `23ac6ef7…2ef83`；无外部 Packs、环境配置、sidecar、真实 Host 或新数据库。主代理说明副本仅删除 Marketing 完整行，余行 digest 未改，原 tarball 未改。JSON 证明实际 worker 的错误不是仅凭 initialize 推断。
- `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-slice2-package-20261111-eb08930b6457-complete.json`：同完整新 tarball SHA，manifest 28 agents / 61 skills、`manifestRejected=false`、worker initialized，health 为 ok，details.catalog 完整列出 `adlc@0.3.2`、`marketing@0.0.4`、`creative-team@0.3.1`；原/测试 snapshot SHA 完全相同。五次模拟 Host 调用，无外部 Packs/env/sidecar、真实 Host 或新 DB。逐键同固定 Packs 比较的执行来源是主代理及其驱动，JSON 汇总计数本身不包含所有键。

**保留正向 fixture 失败**：主代理报告初次正向 health 为 degraded，诊断为 null 的 `.map`。既有 mock 对所有 Host 请求回复 null，但产品 `github-packs.mjs:13` 对 db.query 结果执行 `.map`，SDK 透传该查询结果；合法无导入 Pack 的返回应为 `[]`。主代理先补诊断，再仅修 mock 的 db.query 回复为数组，未改产品或 health 断言，最终正向通过。该原因和修正的执行来源为主代理，本审查没有独立重现；不能将初次失败记作产品 R1 回归或通过。主代理该 helper 根因两轮 modify/validate 已用尽，不因追加记录获得新轮次。

原负向在访问 db.query 前即被整体 snapshot SHA 拒绝，因而该 mock 修正不改变负向失败因果；主代理没有重跑负向。两个结果来自各自自有解压副本、同一原 tarball，容器均 `--rm` 退出、DB 新增为 0。以上增加最终候选离线正反证据，不扩大为真实 Host API、V1 或发布通过。

### 剩余门槛与停止

本次关闭的仅是 S4 R1 及离线受影响边界；主代理新 SHA 的实际包级正反结果现已按执行出处补齐。真实 Host 新 v3 候选、正式版本选择、受影响最终回归与 V1 的完整 Graph/Process Agent/身份回调/拒绝/终态仍未知。不得移植 S1/S2 旧包成功、降低 V1 或因剩余未知自动创建 DB。

本次纠正未发现需继续产品修复的新缺陷，独立测试无失败重跑。复核证据足够即交付并停止，不自动开启新修复路线；总 30 分钟窗口及本审查 10 分钟限制均不因该报告或后续通知重置。
