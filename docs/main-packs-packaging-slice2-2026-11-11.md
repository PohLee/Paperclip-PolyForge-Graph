# S3 / S4 Packs 构建与打包：实施证据

## 状态与边界

**S3/S4 已完成离线有限验收，Sol 复核关闭 S4 R1。** 最终候选为下文 `eb08930b…cf0b8d7`，不是旧 `6102d0ec…d8e88d5`；默认 snapshot 整体字节摘要已绑定在 manifest 和 worker。旧删行反例与通过历史保留，纠正后的包另有正/负向证据，不能相互冒充。详见 [独立审查](main-packs-packaging-slice2-review-2026-11-11.md)。主代理仅运行不启动 Host/数据库的只读 Node 24 容器；未运行这个新候选的真实 Host、V1、模型或完整回归。S1/S2 旧包的 Host 结果不覆盖新候选。没有提交、merge 或 push，也未修改 Core 状态、migration、Packs 或冻结的 S2 文件。

## 实施与输入

- `POLYFORGE_PACKS_SOURCE_DIR` 解析为单一绝对 root；未指定时使用原相邻目录。`scripts/pack-build-source.mjs` 从此 root 读取三个 main Pack 的 index，要求集合恰为 ADLC、Marketing、Creative，并检查 catalog 与 ADLC/Creative 独立模块的 id/version/canonical digest 一致；显式错误路径不回退。
- `scripts/trusted-pack-imports.mjs` 局部参考 `9e6d2e5`：仅对 `src/plugin/trusted-pack-adapters.mjs` 的四个指定 specifier 重定向至同一 root；没有新增任意 executable Pack 加载接口。编译 adapter 和内嵌数据来自同一 root。
- 构建生成 `dist/packs-catalog.json`，每个 Pack 的摘要使用与既有 adapter 一致的递归键排序 JSON + SHA-256；没有修改 Pack 自带 `release.digest` 算法。manifest 构建嵌入相同 catalog，但先加载并验证当前配置或 snapshot；显式部署源与内置值不同时使用显式源。`loadCatalog` 优先显式参数、环境／部署 config，其次 snapshot，只有开发模式缺 snapshot 时允许原相邻 fallback；已构建代码缺 snapshot、显式路径缺失、坏 JSON、digest 不符或 snapshot 重复 id/version 均报错，不回落。snapshot 每次读取，显式模块的 force reload 继续使用独立 worker；manifest 不再吞掉 catalog 加载错误。
- `scripts/runtime-artifact.mjs` 新增 snapshot 字节 inventory 并将格式从 `polyforge-runtime-artifact-v2` 改为 `polyforge-runtime-artifact-v3`。新 verifier 拒绝 v2，旧 v2 verifier 拒绝 v3；必须使用匹配的 v3 verifier 并重建旧候选，不提供隐式兼容或数据迁移。digest 是一致性检查，不是签名或外部来源认证。
- `README.md` 更新 snapshot、显式源、UI Host externals 和 v3 verifier 说明。产品 manifest 的 minimumHostVersion 保持 `2026.1106.0`，原有 tools/schema/capability 未有意改变；没有添加实验 Pack。

固定构建日志：Graph `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，dirty=true（包含本片和先前未提交工作）；Packs `D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph-Packs`，`6ad0652828b3075b72e457e2afa1b0807dcd929e`，dirty=false。canonical 摘要：

- `adlc@0.3.2` `sha256:299071d740c57cb7d2bd0943221a9e3fdd2d4fe08147c642708cb30276a0837a`
- `marketing@0.0.4` `sha256:e8e80c78a4dddf9474fbb7960c544ca98e46a48c653d06df5e94ddfb2d40f963`
- `creative-team@0.3.1` `sha256:58cf1e00d1c740d118aeb89946f688cc1e1186ae06f49eaae34706b2ae50fbaf`

## 验证和执行历史

1. `node --test tests/core/packs-packaging.test.mjs tests/core/pack-registry.test.mjs tests/e2e/runtime-upgrade.test.mjs`：14 passed，0 failed，0 skipped。fixture A/B 数据及 adapter 可辨识；用与正式构建相同的来源选择 helper 和 esbuild 定向重定向编译 B 的 manifest、snapshot、adapter 并检查角色、技能、digest 和两个 adapter 的行为为 B；这不是两次完整产品构建。还验证 snapshot 篡改/重复，真实旧 v2 verifier 对 v3、当前 verifier 对 v2 各自拒绝，原升级/preflight focused 测试通过。
2. 加入三包集合约束后 `node --test tests/core/packs-packaging.test.mjs`：3 passed；固定 clean Packs root 的第一次 `npm run build` 成功、RPC 模拟初始化通过。随后补齐计划要求的 manifest 内嵌 catalog，重复该 focused 文件 3 passed，并进行第二次必要构建/RPC。前两次候选 tarball 后来均被代码变动取代。
3. 新增显式 A 覆盖 B snapshot 和 force reload 断言时，第一次 focused 结果为 2 passed / 1 failed：测试 fixture 未构建其需要的 `catalog-loader-worker.mjs`，报 `MODULE_NOT_FOUND`。这是 fixture 缺失，不是正式产物检查通过；仅补齐 fixture worker 后重跑，3 passed。没有隐藏失败。
4. 随后补齐独立的“构建包缺 snapshot 不得开发回退”边界，`node --test tests/core/packs-packaging.test.mjs tests/core/pack-registry.test.mjs`：12 passed，0 failed；第三次必要构建/RPC 成功。对来源集合、内嵌 manifest、fixture worker、缺失 snapshot 分别记录修改及验证，不把额外断言当作同根因无限重试；没有针对同一失败超过两轮修复验证。
5. 最终 `npm pack` 及解压隔离检查：无 `POLYFORGE_PACK*` 环境变量、无包根 node_modules、无相邻 Packs checkout、无 sidecar。manifest 加载并逐键匹配 snapshot 的 28 agents（含 CEO）和 61 skills，三个 Pack id/version 正确，两个可信 adapter digest 与对应 snapshot 一致；当前 v3 verifier 对实际包字节通过；复制外部 smoke 驱动到解压目录后 worker 15 秒内响应模拟 RPC initialize。RPC 测试的 Host 回包为模拟，且 worker 初始化捕获 catalog 错误，**不能单凭 RPC 成功断言真实 Host 中 catalog 已使用**。fixture 的显式配置/force reload 检查与实际包的无外部加载是不同层次。

R1 纠正前候选 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s3s4-final2-d61ca00f76fc4262837344c7b2c97a69/pohlee-paperclip-polyforge-graph-0.8.7.tgz`；SHA-256 `6102d0ece4d0524150beba806f1ffb73d36a9e0e3ee96d031bb01486cd8e88d5`。包目录中没有配置 sidecar，也未声称 UI 的 React/SDK UI bridge 随包独立提供；其由官方 Host 提供。该包不作为 S4 完整性通过的最终候选。

## 资源与后续

本片没有完整源码快照，新增三个小型隔离 tar/解压目录合计约 34.3 MB；临时 fixture 由测试清理，dist 重建约数 MB，继承累计约 99 MB 和 2 GiB 总额。未分配 DB，既有 2/2 DB 创建额度保持耗尽。没有运行全回归；三次 build 均为初始候选和后续实现必要修正后的构建，不是全回归。独立审查应检查单一 root、显式覆盖／坏数据失败、构建包 snapshot 缺失和 v2/v3 升级策略，再由主代理决定是否在无需新建数据库的约束下验证；不可将模拟 RPC 当作 Host/V1 通过。

## S4 R1 唯一有界纠正（后续记录）

Sol 的 `docs/main-packs-packaging-slice2-review-2026-11-11.md` R1 指出逐行 digest 不能检测删除整行，故上述 `6102d0ec…` 旧包未通过 S4 完整性验收。现对同一构建源生成的 snapshot 精确字节计算 SHA-256，将预期值分别编入 manifest 和 worker；默认 snapshot 实际读取时先校验整体字节，再执行既有逐行校验。显式参数、环境和 sidecar 来源不与内置 snapshot 强制相同，开发源码 fallback、force 重读及 v3 格式不变；没有以三包运行时白名单代替绑定，也没有引入签名或修改 Host。此绑定是随候选代码提供的完整性检查，并非抗任意代码和数据共同修改的来源认证。

本次仅一次产品修改后验证周期：`node --test tests/core/packs-packaging.test.mjs` **3 passed / 0 failed / 0 skipped**，包含独立 A/B 编译 fixture、显式 A 覆盖 B 及 force、完整默认三包，以及删除完整一行后 compiled catalog 和 manifest 拒绝。测试还真实编译 worker，以模拟 Host RPC 的 `db.query` 返回空结果，断言正常 health 为三包 `ok`、删行后 health 为 `degraded` 且报告 build digest 错误；不是只断言 initialize。v2/v3 拒绝策略 focused 仍通过。一次 `npm run build` 使用 `POLYFORGE_PACKS_SOURCE_DIR=D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph-Packs`：Graph 基线 `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f` dirty=true，Packs `6ad0652828b3075b72e457e2afa1b0807dcd929e` dirty=false，构建和模拟 RPC 初始化通过。此次无测试失败或重试，不运行全回归。

新实际 tarball `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s4-r1-52bb797eb8644f0bbd6f8c19a511b572/pohlee-paperclip-polyforge-graph-0.8.7.tgz`，SHA-256 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`。在独立解压目录、清除 Pack 环境变量且无 sidecar／相邻 Packs 下，manifest 为 28 agents 和 61 skills；真实构建 worker 的模拟 Host health 初始返回完整三个 Pack 且 `ok`。仅在解压副本中移除 Marketing 整行、其余行和 digest 不变后，manifest 重新 import 拒绝，worker health 返回 `degraded` 和 build digest 错误；测试 finally 恢复解压副本 snapshot。tarball 原始字节未改。该包级检查无真实 Host 或数据库，不能替代 Host upgrade、V1 或独立复核；未提交、merge、push，未创建新 DB 或 Docker 资源。

## 主代理独立包级检查（追加只读审查窗口）

首次收到作者结果时，两次本地检查的时钟已跨过原 60 分钟窗口，实际活跃耗时无法追溯；主代理暂停新增执行，没有据此声称原预算已遵守。用户随后明确追加 30 分钟，仅用于 Sol 审查（最多 20 分钟）与主代理包级验证，产品代码冻结、不自动进入修复循环；本次检查起点为 18:06 左右。

1. 独立核对最终 tarball SHA-256 为上述 `6102d0ec…d8e88d5`，解压至新目录 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-slice2-isolated-41p39z`。
2. 只把此候选目录只读挂入固定官方镜像的 Node 24 容器，以 UID 1000、`--network none`、`--read-only` 运行；不挂载 Graph、Packs 或 node_modules，不提供 sidecar，清除 `POLYFORGE_*`。不是 Host 实例，没有启动数据库。
3. manifest 的门槛为 `2026.1106.0`；28 agents、61 skills 与容器外从固定 main Packs 独立计算的全部键逐一相等。容器中真实 built worker 在 15 秒内完成模拟 RPC initialize，共 5 次模拟 Host 调用。此项不证明真实 Host 下 worker catalog API、错误传播或 V1。
4. 在同一解压候选上另做 Node 24 的 adapter/snapshot 定向检查：三包版本完整，逐包重算 canonical SHA-256 与 snapshot 行摘要相同；两个 compiled adapter 可实际 import，factory 是函数，包 id/version/digest 分别与 ADLC、Creative snapshot 行一致。未挂载外部 Pack 源码，也未创建数据库。
5. 当前源码的 `verifyRuntimeArtifact(candidateRoot)` 对同一解压候选执行成功，没有跳过字节或 migration 校验。metadata 为 v3，包含 11 个 runtime 文件及 snapshot；第一次终端摘要误从返回 wrapper 读取 format/files（显示 files=0），并非 verifier 的 inventory 结果。随后直接读取实际 metadata 确认上述字段，没有将显示错误当作产品失败或新增一次验证通过。

驱动 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-slice2-package-20261111.mjs`，成功摘要在同前缀 `.json`，包含完整候选 SHA。两个包级容器均带 `--rm` 且运行结束退出；没有新的 DB、镜像拉取、模型、完整源码拷贝或全回归。检查前 C/D 分别约 61.6/315.8 GiB 空余，Docker 数据卷约 902 GiB 空余；新增一份小型解压候选，继承累计 2 GiB 上限。**真实 Host 上的这个新候选、v3 升级及 V1 仍未验收。**

## 主代理：R1 最终包的独立正／负向验证

用户另行授权 30 分钟仅用于 R1 修复、复核及最小包级验证，本窗口于 18:17 左右开始。Terra 一次产品纠正后，Sol 独立 focused **3/3 通过**并确认默认整体摘要实际编入 manifest/worker、显式覆盖保持，R1 关闭；此结论不改写旧包失败。

- 独立核对新 tarball 的完整 SHA 为 `eb08930b645762848dfd57cb743f4a20452ca5b4acac0c73f489338cecf0b8d7`。正／负向均从它解压到各自新目录；不改原 tarball，不挂外部 Packs/Graph/sidecar/node_modules，不继承 Pack 环境变量。官方固定 image 的 Node24 以 UID1000、只读、network none 运行，没有启动 Host/数据库。
- **正向最终通过**：28 agents、61 skills 与固定 main Packs 的全部键一致；built worker initialize 后真实 RPC health 为 `ok`，details.catalog 完整列出 ADLC `0.3.2`、Marketing `0.0.4`、Creative `0.3.1`。这里的 Host RPC 仍是模拟，不是官方 Host 服务。
- **负向通过**：仅在该测试自有解压副本移除 Marketing 完整行，保留剩余每行和 digest；manifest 的实际 import 报 `Built Pack catalog snapshot does not match build digest`。用原 manifest 的最小声明模拟已有 Host registry 后，worker initialize 可完成，但 health 明确 `degraded` 且 message 为同一 build digest 错误，未被判健康。未篡改产品或剩余行摘要。
- 初次正向 health 为 `degraded`；主代理加诊断后确认错误是 `Cannot read properties of null (reading 'map')`。原临时模拟器给所有 Host 请求回 null，但 `github-packs.mjs:13` 和目标 SDK 要求 `db.query` 返回数组。仅将模拟的查询回包修正为空数组，保留 health 必须 `ok` 的断言后通过。产品代码未为此修改；两次失败均不记通过，主代理模拟协议根因已用两轮“诊断/修正→验证”，不自动第三轮。原负向在查询前就因 snapshot 摘要失配而失败，故该模拟回包修正不影响其错误因果，没有重跑负向。

正向 JSON：`C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-slice2-package-20261111-eb08930b6457-complete.json`；负向 JSON：同目录 `polyforge-salvage-slice2-package-20261111-eb08930b6457-truncated.json`。两份均含完整候选 SHA、原始与受测 snapshot 摘要、模拟 RPC 调用数及 realHost/databaseCreated=false。驱动为上述同名 `.mjs`，新结果使用 digest 后缀，未覆盖旧 `6102…` 的原始 JSON。

真实 Host 对最终 v3 包的安装／升级、V1 真实 Process Graph 终态与错误身份拒绝、正式未使用版本号及最终受影响回归仍未完成。DB 创建额度仍为 **2/2**；后续 V1 如需新实例，须额外授权一个明确数量的测试 DB，不能因新的切片重置。
