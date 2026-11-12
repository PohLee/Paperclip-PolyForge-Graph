# main 选择性抽取：Sol 独立静态审查

审查日期：2026-11-11。对象为只读原计划及 Terra 分析；本报告不是产品验收。仅新增本文件，未运行测试、build、npm install/pack、Docker、模型、升级，未提交、合并或再委派。

## 结论与门槛

- **可以进入 Phase 0。** 其目的正是固定范围、记录脏文件及检查旧假设；本次未发现应禁止这些工作的生产安全、数据损坏或核心不变量阻断。这不是对产品安全的全面证明。
- **完整实施有条件可进入，不宜直接承诺完整交付。** 先明确 S2/S3 是否选中，再按原计划落实 V1 静态契约预检及延期 S4 的部署办法。未验证这些路径，不等于已证明 S1 不可实施；也不应因此冻结所有独立的 S1 局部工作。
- **当前不能发布／声称 S1+V1 通过。** 没有候选包、目标 Host 或生命周期运行证据；原计划 288 行的实际合并门槛保持不变。
- **Terra 的多数源代码事实成立，但总体严重性偏重。** 唯一确认的计划文本矛盾是 S2/S3 的可选性；V1 预检及 S4 inventory 兼容属于原计划已有门槛，不是新发现的遗漏。T:5 已明确未证明 S1 不可行，T:16 也明确不阻止延期 S4；本审查主要纠正“计划就绪/验收阻断”合称及高风险分级的含混，不将 Terra 误述为已经断言不可行。建议修订分级和状态描述后接受其分析，不要求先把产品实施完才能接受分析报告。

## 证据约定与基线

- 计划：`D:/Projects/00.Own/05.AI-Ops/Paperclip-PolyForge-Graph/docs/main-selective-salvage-plan-2026-11-10.md`（未提交，只读），下称“计划”。
- Terra：`C:/Users/pohle/.local/share/opencode/worktree/ace267039946970ba017bda07fcdd1579bdd9568/salvage-plan/docs/main-selective-salvage-analysis-2026-11-10.md`，下称“T”。
- G：Graph 固定提交 `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`；P：Packs 固定提交 `6ad0652828b3075b72e457e2afa1b0807dcd929e`。以下源码行号均来自相应提交的 `git show`，不是浮动工作区。两主 checkout 的 HEAD 已分别核对与上述值一致。
- Graph 的 `git status --short --untracked-files=all` 实际列出两个未跟踪文件：原计划及 `tests/plugin/routine-bridge-status.test.mjs`；`git status --short --untracked-files=no` 和 `git diff --name-only HEAD` 输出为空。Packs 的含未跟踪文件状态输出为空。
- 因此 **T:7 的“两者工作区状态输出为空”若表示完整状态就是不准确的**。可改为“Graph 无 tracked 差异，但存在上述未跟踪文件；Packs 状态为空”。只能证明仅查 tracked 可以产生空输出；T 未记录原命令，本次不能断言 Terra 当时究竟用了什么参数，亦不能追溯当时全部文件状态。

## 逐项核验 Terra 的高／中风险

### R1：S2/S3 可选性——确认矛盾；“高：交付阻断”应降为中等范围决策问题

- **证据成立：**计划 47–52 行称 S2/S3 为建议、最小 S1+V1；169、176 行又无条件要求完成两项，172、181、188、286 行也默认相应产物／提交存在。
- **阻断位置：**阻碍冻结完整实施范围，不阻碍 Phase 0，更不是既有产品运行缺陷。计划 283、288 行已有“延期”“拟纳入”的条件措辞，说明需要统一文本，而非推翻最小交付。
- **最小修订：**明确选项；未选项目对应阶段步骤、BDD、提交及出口标为“不适用／延期”。若只做 S1+V1，仍记录固定输入和部署前提，但不得声称完成 S3 的双 root 验收。将 S3 变成必做需要用户范围决策。

### R2：延期 S4 的挂载部署——确认待补操作证据；不能定性为已不可行

- **已存在实现机制：**G `src/plugin/catalog.mjs:10–31` 寻找插件包根并读取 `polyforge.runtime.json.packEntries`，不只依赖环境继承；manifest 调用同一 loader（`manifest.mjs:1–5`），worker 也调用它（`worker.mjs:5,627`）。包根 sidecar 配置配合外部只读 Packs 路径，在源码层面是现有部署通路，不要求实现 S4 才存在。
- **Terra 的警告有据：**G `manifest.mjs:5,112–113` 会吞掉 catalog 异常，仍导出 CEO；`package.json:11–18` 未列 runtime 配置；`compose.e2e.yml:38–47` 仅给源码挂载及容器环境。它们不能证明安装后包根配置可达，也不能证明目标 Host 的两个加载阶段均可用。
- **应降级／澄清：**计划 52、63、137、288 行已经要求隔离包可加载、延期 S4 时显式部署挂载。T:14 已提及包根配置，是对这些要求的有用操作化，不是已证实的架构缺陷或全计划启动阻断。部署配置由运营者在实际包根提供，不必因为它不在 tarball 文件清单就认定方案失败。
- **最小补充：**写明实际安装包根、容器内 Pack 路径、sidecar 如何只读提供及安装／升级后如何重供；验收时清除开发机 fallback，核对完整三包角色／技能和 worker 的 Pack／adapter 身份。错误配置须使验收失败；不因此强行要求 S1 实现 S4 的无挂载能力。
- **尚未证明：**目标 Host 是否保留所需文件路径／读取权限以及安装、升级后的配置生命周期。既未证实成功，也未证实不可行。

### R3：V1 旧脚本不兼容——确认；“新计划遗漏／全实施阻断”不成立

- **证据成立：**G `scripts/e2e.mjs:10,115–117,133–146` 使用相邻 ADLC、固定 11 角色及旧三图；`tests/e2e/e2e.test.mjs:9` 同样固定旧图。P `packs/adlc/index.mjs:5–8,63–64` 聚合的 ADLC 图源码未检出 `ui-ux-design`；`engineering-graphs.mjs:16,53` 则有 implementation/verification `0.1.6`。
- **fixture 确需适配：**P `lifecycle-graphs.mjs:13–28` 的 request-triage `0.2.0` 有任务、review、decision 和三个合法终态；P `runtime/host-api.mjs:6–9,109–130` 要求受管 request_brief payload 与 envelope 对应。G `scripts/e2e-fixture-agent.mjs:294–305,431–452` 未覆盖该 decision 或 payload，不能原样拿来宣称通过。
- **关键归属纠正：**计划 **204–206** 行已经明确要求先确认图存在和输入输出契约，旧 fixture 不满足则定位并报告未完成；270 行还要求 Docker 前静态检查。T:15 是这项预检得到的具体证据，不是计划遗漏。它阻止原样运行旧 E2E／声明 V1 完成，不自动阻止所有 S1 实施。
- **最小动作：**在既定预检中选定一个真实图及声明终态、权限、输入／输出来源，再修复有限 fixture。没有穷举证明不存在合法路径；也未证明 request-triage 可完成。其 needs-info／closed 是原图既有终态（P 上述行；G `src/core/evidence-contracts.mjs:113–116,427–433`），不应默认只有业务“ready”才算生命周期闭环；但仍须真实满足契约、review、身份及预先声明的验收目标，不能临时换场景掩盖失败。

### R4：S4 inventory 兼容——确认条件风险；原计划已覆盖，不新增阻断

- G `scripts/runtime-artifact.mjs:6–8,67–79` 将 metadata 的文件集合与执行中 verifier 的精确集合比较。参考 `c4d9747697463ff2165de1b0f051a6a459c42081` 加入 catalog snapshot；若仅扩大集合而不改验证策略，旧 verifier／新 inventory 及反向组合都会被拒绝。这是静态逻辑结论，不是本次实测。
- G `scripts/runtime-preflight.mjs:55–69` 调用该 verifier；`scripts/upgrade-runtime.mjs:23–34,38–57` 重新预检并校对同一路径等信息，T:16 的源码引用准确。
- **计划 132 行已经明确要求检查 inventory 变化、格式版本及旧候选拒绝行为。** T 应标作“S4 纳入时执行既有验收”，不能列成计划遗漏；整体延期 S4 不受此项阻断。
- 最小要求是明确 verifier 来源和预期接受／拒绝组合，按所选格式策略做定向验证；不默认必须支持双向兼容或建立迁移层。T 的四格矩阵是可选验证设计，不应无条件扩成新增兼容功能。

### R5：完整性边界——确认事实；属声明边界／验收提醒，不是新安全缺陷

- G `scripts/runtime-artifact.mjs:6–8,28–47,50–58,67–96` 校验列举文件及 migrations；不覆盖全部 node_modules、外部 Packs、runtime sidecar，metadata 也在同一候选内。不能把这种自带摘要解释为可信来源签名认证。
- G `src/plugin/catalog.mjs:5` 存在 semver 导入，`scripts/build.mjs:23–35` 的 manifest/worker 配置不同；本次仅核对源码配置，未验证任何实际 tarball 的依赖解析。
- 计划 62–63、111、131、282 行已要求 registry/integrity、运行依赖、固定输入及候选摘要；未声称摘要可认证任意恶意重写。因此 T:17 适合保留为中低程度的证据边界说明，不能据此增加签名系统或把现有方案判为安全阻断。

## 其他核对与遗漏边界

- **S2 参考准确：**`da74478405e72277d17ea755e0a47eb0a70fffce` 只改指定两文件；UUID 临时文件、仅 win32 EPERM/EACCES、五次延迟及 finally 尽力 unlink 均可从 diff 直接核对。T:31 关于清理非绝对保证、无 CAS、未实测的限定正确。
- **S3 参考准确：**G `scripts/build.mjs:5–6,17–20` 与 `trusted-pack-adapters.mjs:4–13` 有不同导入点；`pack-host-support.mjs:55–64` 按 Pack 身份／digest 匹配 adapter。`e1ca1a1` 的文件清单没有 helper；`9e6d2e5:scripts/trusted-pack-imports.mjs` 限定 importer 和四个映射。T:35 没把构建来源固定误当运行时部署完成，正确。
- **身份边界准确但不等于通过：**G `worker.mjs:157–162` 与 `pack-host-support.mjs:28–36,90–105` 有受信 actor 映射／比较；旧 E2E `scripts/e2e.mjs:144–148` 只断言 start 的 body actor 不可信，不能替代计划 255–259 行活动 attempt 的错误 Agent／run 负向验收。未发现应删减该门槛的依据。
- **可补的小细节：**G `catalog.mjs:91–95` 和 `catalog-loader-worker.mjs:8–20` 会跳过不可访问 entry；多个显式 entry 中只加载一部分也可能非空。因此延期 S4 验收须比较完整预期 catalog，不能仅断言“非空／安装成功”。T 已要求三包一致，此为其证据精化，不另立扩范围产品缺陷。
- **外部事实仍未知：**未独立核验目标 registry tarball/integrity、镜像 digest／ENTRYPOINT／server version、目标 SDK capability／namespace、Runner 默认值、heartbeat 上限、Host 环境传递机制。本次不作外部 API 正确性背书，也未调用外部文档工具；T:58 自述的 Context7 master 结果及查询过程未在本审查中复现。若要解除这些未知，应遵守 Context7 规则并取得目标固定发行证据；master 文档不能替代目标版本。不要把 T 的保留意见误记成已核验。

## 返回主代理的最小修正清单

1. 修正 T:7 的完整工作区状态说法；区分 tracked 干净和未跟踪文件，不能臆测原命令。
2. 保留 S2/S3 范围矛盾，要求用户选项／条件化阶段出口；将其定位为范围冻结问题，而非产品高危。
3. 将 T:5、15、52 的 V1 结论明确归入计划 204–206 行的既定预检；“旧脚本不能原样用”不等于“没有可完成 Graph”，不阻止 Phase 0。
4. 将 T:14 已提及的 sidecar 机制明确归类为“现有通路，真实 Host 贯通未证”；补操作说明并保留实际验收，不强制 S4，不将其判为已不可行。
5. 将 T:16、17 区分为既定 S4 验收和完整性信任边界，保留真实证据，但移除“新遗漏／全计划阻断”的暗示；四格测试不应被理解为新增兼容承诺。
6. 总结采用三级结论：Phase 0 可进；完整实施需范围决策并完成既定静态检查；发布仍待实际 S1/V1 及选中项验收。**“审查无未解阻断”只可表示修正后的分析报告可接受，绝不等于 S1/V1 实际通过。**

预算与停止：本轮在 20 分钟额度内完成静态核对并交付；产品修改／验证循环 0，完整回归 0，数据库／完整归档 0。剩余未知项已列明，不继续扩大调查或执行范围。
