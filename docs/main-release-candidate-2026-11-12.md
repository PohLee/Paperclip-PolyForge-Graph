# Graph 0.8.9 发布候选：准备与验收证据

## 状态

**本地 `0.8.9` 候选的发布准备及固定图 BDD-V1-01/02 已通过，Sol 已核验接受。** 新摘要 `ce778201…97bb90` 已在官方 Host 上真实运行，不沿用旧 `0.8.7` / `eb08930b…` 的 V1 身份。受影响测试 35/35、桥接纠正后定向 2/2、Sol 独立预检 8/8 通过；未运行全项目 suite 或真实模型质量验收。DB 累计 5/5 已用且全清理。用户随后明确授权本分支 commit/push；历史记录中的“未提交／推送”指当时阶段，不是禁止本次授权交付。merge 与公开发布仍未获批准。

## 版本与来源

重新读取所有本地可达 refs 的 `package.json`，并遍历 `git log --all -- package.json` 的可达版本变更：实验分支已有 `0.8.8`，未见 `0.8.9`，故选择 `0.8.9`；这是本地 Git 可达范围检查，不声称查询过任何外部发布 registry。Graph 基线 `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，构建工作树 dirty（包含已授权未提交变更）；固定 Packs `D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph-Packs`，`6ad0652828b3075b72e457e2afa1b0807dcd929e`，dirty=false。

`package.json`、lock 根版本、`src/plugin/manifest.mjs`、`src/core/compatibility.mjs` 已同步 `0.8.9`；构建产生的 v3 runtime artifact 同步 plugin/runtime 版本。SDK/shared 仍为 `2026.1106.0`，Host image pin 与 manifest 门槛 `2026.1106.0` 未修改；Pack 版本、Graph、状态、15 个 migration 和 v3 格式未改变。README 明确 `0.8.9` 是未验证候选，不把它称作正式发布。

构建日志中的 canonical Pack digest：`adlc@0.3.2` `sha256:299071d740c57cb7d2bd0943221a9e3fdd2d4fe08147c642708cb30276a0837a`；`marketing@0.0.4` `sha256:e8e80c78a4dddf9474fbb7960c544ca98e46a48c653d06df5e94ddfb2d40f963`；`creative-team@0.3.1` `sha256:58cf1e00d1c740d118aeb89946f688cc1e1186ae06f49eaae34706b2ae50fbaf`。

## V1 证据身份桥接

`scripts/e2e-candidate-metadata.mjs` 在 controller 启动前对明确传入的 tarball 实际计算 SHA-256，运行现有 v3 verifier 校验解压根目录的 artifact 和全部声明文件/迁移，再逐项比较 tarball 内的 artifact metadata、其声明的所有文件和 migration 与解压内容；输出真实 tar 摘要和 artifact pluginVersion。验证失败不会启动容器。此绑定覆盖运行时 artifact inventory 和 migrations，并不声称 README/sourcemap 等 inventory 外文件均经 controller 逐字节验证。只用于公开 metadata；没有修改 signer、负向身份、幂等、三 phase 或 event 断言。

后续执行者必须另建全新安装目录，显式核对 tar SHA 并使用 `tar -xmf` 解压，不复用旧目录或 sidecar；然后以 `node scripts/e2e-minimal-host.mjs start <extracted-root> <startup-failure-path> <candidate-tarball>` 启动。controller 将计算的公开摘要与版本传给容器；driver 拒绝缺失或格式错误的摘要/版本，并在真实安装时严格比较 plugin.version、manifest.version 以及 settings.runtime.version，将摘要和版本写入 evidence。测试 signer 仍通过环境变量名传递，值不在 argv；实际 Host 启动及身份桥接尚未运行。操作方仍须负责 finally 中提取脱敏证据、记录 tmpfs 实际用量并只清理唯一容器。

## 本阶段执行

1. 一次 focused：原六文件受影响集加 `tests/core/release-candidate.test.mjs`，`node --test tests/core/official-sdk-pairing.test.mjs tests/core/check-runner.test.mjs tests/core/packs-packaging.test.mjs tests/core/pack-registry.test.mjs tests/e2e/runtime-upgrade.test.mjs tests/core/minimal-triage-fixture.test.mjs tests/core/release-candidate.test.mjs`：**35 passed / 0 failed / 0 skipped / 0 cancelled**。新测试验证版本一致、身份必需、真实 archive 与独立解压 artifact 比对、错误根目录和字节篡改拒绝；使用小型合成 tar fixture，不是完整源码快照。
2. 一次固定 Packs `npm run build`：成功，内置模拟 worker RPC 初始化在 15 秒内成功。Node `v25.2.1`，不是官方 Host 验收。
3. 一次 `npm pack` 并用 `tar -xmf` 在隔离目录解压；运行实际 `candidateMetadata`、导入包内 manifest、检查打包 Core bundle 的版本常量及 v3 artifact：package/manifest/Core runtime/artifact 均 `0.8.9`，manifest 28 agents、61 skills，Host 下界不变。此检查不声称独立 Core 入口没有外部 npm 依赖，也不证明真实 Host。
4. 两个实际 tarball 的文件名清单相同；逐文件字节比较仅以下发生变化：`package.json`、README、`dist/core/index.js` 与 map、`dist/manifest.js` 与 map、`dist/worker.js` 与 map、`dist/runtime-artifact.json`。Pack snapshot、trusted adapter、migrations 与旧包字节相同；bundle 改变包含版本嵌入及 sourcemap 变化，不将其误称逐字节等同旧候选。

新候选：`C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-rc-089-e469c535e4694b189a2b9608a50677f8/pohlee-paperclip-polyforge-graph-0.8.9.tgz`
SHA-256：`ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90`。

首次受影响集通过后，发现仅比较 tar metadata 不能排除 tar 内其他 runtime 成员与已验证解压目录不一致；因此身份桥接作一次必要纠正，逐项比较全部 artifact inventory 和迁移。仅重跑 `node --test tests/core/release-candidate.test.mjs`：**2 passed / 0 failed / 0 skipped**，新增案例构造 metadata 相同但 tar 中 worker 字节不同的反例并确认拒绝；再对上述实际包与解压目录运行桥接，返回同一 SHA 和版本。该纠正只改包外 harness 与 focused 测试，没改候选字节，无需重建。

版本/身份根因两轮修改及对应 focused 验证，未发生测试失败；不再自动进行第三轮。无完整回归开始。实际 DB 仍为 4/5，前四个已清理，第五个须 Sol 预检并由主代理明确放行后才可分配。任务可见文件约 0.2–0.3 GiB，用户已将累计上限升至 4 GiB；历史 DB/WAL 实际用量未全量采样，不记为零，后续实例清理前须记录实际/容量使用量。

## 后续 DB5 真实 V1 执行结果

以上静态准备状态及 DB 计数是执行前的历史记录。Sol 静态预检接受、用户明确放行后，唯一 DB5 执行的严格 V1 driver **通过；结果尚待 Sol 只读复核**。本结果仅适用于 `0.8.9`、SHA-256 `ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90` 和 `adlc@0.3.2 / request-triage@0.2.0`，不是旧 `eb08930b…` 候选的证据。启动前独立核 hash、新目录 `tar -xmf`，controller 在创建容器前验证 tar 与 runtime inventory，记录相同 SHA 和版本。真实安装的 plugin、manifest 和 settings runtime 版本由 driver 断言为 `0.8.9`；Host `2026.1106.0` / `d69631b01b9c658f80bf8bed389863dce82643e1`，plugin ready，28 agents / 61 skills。

- Company `8ba64014-90b2-416e-a2c5-bdce7cd8bc18`；root issue `97476c93-ef60-4080-8f1f-fbf529502cb1`；Graph run `2299dc1a-def3-4ec9-8752-5a968259c168`，终态 `completed / needs-info / triage-needs-info`。
- Work issue/run `b0a790b2-4b3e-4e10-ade3-1d86042987e8` / `4184d46d-f3aa-4cb4-a837-a8e2797fdda2`；supervisor issue/run `e5fa228d-3785-449a-836f-db338efd60b8` / `9d084154-c486-4652-9114-7b2d85e04d4a`；decision issue/run `c0b8650b-1322-4503-a5f4-fd95d322f6e8` / `8ce3fa85-20eb-4576-9bd9-cce6a4097a22`。三条唯一 phase 的 Host run 均 succeeded；driver 的 checkout、run JWT、合法提交及幂等重放、self-review、CPO review、decision 和无额外 run 断言通过。
- 独立认证的错误 Agent `bbb85cd9-bf52-4087-b814-d9c38a014f20` 提交被 HTTP 403 拒绝，原因 `Agent is not bound to this Graph node issue`；完整 Graph 和 decisions 不变。
- 停止前 `du -sk`：`/paperclip` **109216 KiB**（包含 DB/WAL），`/tmp` **4 KiB**。`df -k`：`/paperclip` 总 524288、已用 109216、可用 415072 KiB（21%）；`/tmp` 总 131072、已用 4、可用 131068 KiB（1%）。两个命令退出码均 0；这是当次 tmpfs 的时点测量，不是历史 DB/WAL 的累计实际使用量，历史未测量值不能记为零。
- `startExit=0`、`runExit=0`、`stopExit=0`，唯一容器已不存在；此前四个 DB 的清理记录保留，累计 **5/5** 额度已用完。未新建其他 DB，也未重新构建、执行 focused/full suite 或发布。

独立 DB5 证据目录：`C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-rc-089-db5-20261112/`，包含 `evidence-db5.json`、`result-safe.json`、`storage-usage.txt` 与 `execution-summary.json`。真实 V1 通过不等于全项目回归、模型质量验证、合并或公开发布批准。

## 最终独立核验

Sol 已直接读取上述脱敏 JSON 与存储记录，并与冻结的 driver/身份桥接核对，接受新 `0.8.9` 候选的发布准备范围和本固定图 BDD-V1-01/02；无未关闭审查项阻止用户已授权的本分支提交推送。没有由 reviewer 重跑 Host/DB，没有把旧包证据转移给新摘要。详见 [最终审查](main-release-candidate-review-2026-11-12.md)。

验证对象固定为本报告完整 `ce7782014fdf16f7a565d24dff661df7516339e896da0914aa278dcb8497bb90` tarball、官方 Host `2026.1106.0` 和上述 request-triage 场景。35 项受影响测试不等于全项目 suite（全回归开始仍 0/2）；不声明所有 Graph、所有官方 API 或外部模型效果均通过。SDK／Host兼容、Windows 修复、来源 helper、snapshot 完整性和真实 V1 的代码/证据按提交组保留；仅推送工作分支，不 merge 或公开发布。
