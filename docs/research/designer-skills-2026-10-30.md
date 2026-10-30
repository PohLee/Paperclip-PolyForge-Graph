# Designer Skills 仓库研究笔记（2026-10-30）

## 研究范围

研究对象为 [Owl-Listener/designer-skills](https://github.com/Owl-Listener/designer-skills)，固定在 commit [`9a6930cf84a822eb458624bd11c61aac5bbdf224`](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224)。通过 GitHub 连接器只读检查递归目录树、模板、贡献约定、代表性 skill/command、插件 manifest 及 Gemini 构建脚本；没有安装插件或运行仓库脚本。

## 核心结论

这是以 Markdown 提示词组织的设计知识和作业流程库。它给已有 AI 助手补充专业判断与执行步骤；本仓库没有定义一套独立设计师 Agent 团队的运行时。可以把层次理解为：**plugin 是安装与领域边界，skill 是可调用的设计知识，role 是当前任务的专业视角，command 是组合 skills 的工作流**。这一判断来自目录结构和抽查文件，不代表对四个外部 collection 的架构审计。[目录树](https://api.github.com/repos/Owl-Listener/designer-skills/git/trees/9a6930cf84a822eb458624bd11c61aac5bbdf224?recursive=1)、[README](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/README.md)、[技能模板](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/SKILL_TEMPLATE.md)

## 仓库范围与九个插件

这个仓库同时是 design practice collection 的代码来源和五个 collection 的 marketplace 入口。marketplace 的 33 个插件条目中，9 个指向本仓库相对目录，24 个通过 git-subdir 指向四个外部仓库，分别负责 AI 产品设计、UX 项目管理、设计领导力与包容性设计。README 的 273 skills / 76 commands 是整个套件的声明；下表的 111 / 34 来自本仓库实际文件统计。[marketplace](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/.claude-plugin/marketplace.json)、[INDEX](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/INDEX.md)

| 本仓库插件 | Skill 数 | Command 数 | 主要解决的问题 |
| --- | ---: | ---: | --- |
| design-research | 14 | 4 | 用户是谁、行为与痛点是什么，如何收集并综合证据 |
| ux-strategy | 12 | 3 | 应解决什么问题，范围、信息架构和成功标准是什么 |
| ui-design | 19 | 5 | 页面如何布局，字体、颜色、间距与响应式如何定义 |
| interaction-design | 22 | 5 | 用户如何操作，状态、反馈、错误与恢复如何设计 |
| design-systems | 11 | 3 | 如何将视觉和行为决策沉淀为 tokens、组件与治理规则 |
| prototyping-testing | 10 | 5 | 如何探索多个方案、选择原型方法并验证假设 |
| visual-critique | 7 | 2 | 现有屏幕哪里存在问题，哪些修复应优先处理 |
| design-ops | 9 | 3 | 团队怎样评审、交付、验收与持续改进 |
| designer-toolkit | 7 | 4 | 如何找入口、解释设计决定、做演示和案例复盘 |
| 合计 | 111 | 34 | 覆盖设计实践的主要阶段 |

## Skill 如何组织知识与触发条件

典型结构是 `<plugin>/skills/<skill-name>/SKILL.md`。文件开头的 YAML frontmatter 定义名称与 description，正文通常包含专业身份、职责、方法、判断规则和最佳实践；部分研究类技能使用 Context、Domain Context、Instructions 结构。它们没有统一的机器可校验输入输出 schema，很多产物约定写在正文中。[技能模板](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/SKILL_TEMPLATE.md)、[user-persona](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/user-persona/SKILL.md)

description 是路由的关键。仓库要求它说明三件事：**产出什么；Use when 后说明使用情境；存在相邻技能时说明边界**。例如 `design-token` 负责建立 token 层，审计已有 token 使用应选择 `design-token-audit`，多品牌映射应选择 `theming-system`。这样 agent 在加载技能正文前就能区分多个近似能力。[贡献规范](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/CONTRIBUTING.md)、[design-token](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/design-token/SKILL.md)

Skill 不全是原子动作。有些是可直接完成交付的完整方法，例如 `user-persona` 包含读取数据、聚类行为、创建 2–4 个画像、选择主画像和说明研究缺口；有些是审视设计的判断视角，例如 Gestalt 原则、认知规律；有些是规格方法，例如 `state-machine` 组织 states、events、transitions、actions 和 guards。[user-persona](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/user-persona/SKILL.md)、[INDEX](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/INDEX.md)、[state-machine](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/skills/state-machine/SKILL.md)

按照仓库约定，宿主会根据任务选择 skill；用户也可直接在自然语言中说“使用 `form-design`”。需要端到端产物时，再使用带命名空间的 command。Skill 与 command 的区别主要在职责：前者提供专业方法与判断，后者为一次交付排列步骤，而非每个 skill 都只能完成一个步骤。[INDEX](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/INDEX.md)、[command 模板](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/COMMAND_TEMPLATE.md)

例如调用 `/ui-design:design-screen` 时，command 依次使用 `layout-grid`、`visual-hierarchy`、`typography-scale`、`color-system`、`spacing-system`、`responsive-design`、`dark-mode-design`。各 skill 提供对应专业视角和规则，command 将它们组合成包含七方面内容的屏幕规格。[design-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/commands/design-screen.md)


## Role：专业视角、团队责任与运行实例要分开

### Skill 的 role 是提示词身份

技能模板把 role 写为 `You are an expert in ...`，再用 `What You Do` 定义产物、判断与职责边界。例如 `user-persona` 要求助手以资深 UX 研究员的视角先读研究数据，再提炼行为模式与用户画像；`state-machine` 要求以 UI 状态建模专家视角识别状态、事件、转换和 guards。这是同一助手在不同任务里采用的专业视角，不等于新建一个带独立上下文、权限和生命周期的 Agent。[技能模板](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/SKILL_TEMPLATE.md)、[user-persona](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/user-persona/SKILL.md)、[state-machine](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/skills/state-machine/SKILL.md)

下表是便于理解的职责归纳，并非仓库注册的九个独立 Agent 名称：

| 领域 | 助手采用的专业视角 | 典型产物与职责边界 |
| --- | --- | --- |
| design-research | UX 研究员 | 从证据提炼用户画像、洞察、旅程；`user-persona` 要求画像基于研究而非假设 |
| ux-strategy | UX 策略与问题定义专家 | 写清问题、受众、约束与成功标准；brief 应定义问题而非预设方案 |
| ui-design | 视觉与界面设计专家 | 网格、字体、颜色、间距和响应式规范 |
| interaction-design | 交互与状态建模专家 | 状态转换、反馈、错误、加载与交互行为规格 |
| design-systems | 设计系统规格作者 | 组件 anatomy、props/API、variants、states、accessibility 与 usage rules |
| prototyping-testing | 方案探索与验证专家 | 生成行为上不同的概念，再依预先制定的标准选择并保存决策记录 |
| visual-critique | 屏幕视觉评审者 | 对现有界面给出观察、问题、具体修复及优先级 |
| design-ops | 设计流程与交付专家 | 团队节奏、review gates、handoff 与 QA 文档 |
| designer-toolkit | 设计沟通与论证专家 | 将决定连接到证据、用户需求、业务目标、原则和取舍 |

表格依据：[user-persona](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/user-persona/SKILL.md)、[design-brief](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/design-brief/SKILL.md)、[design-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/commands/design-screen.md)、[design-interaction](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/commands/design-interaction.md)、[component-spec](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/component-spec/SKILL.md)、[explore-options](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/commands/explore-options.md)、[critique-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/commands/critique-screen.md)、[setup-workflow](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/commands/setup-workflow.md)、[design-rationale](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/skills/design-rationale/SKILL.md)。

### 团队 role 是组织责任

`/design-ops:setup-workflow` 的首步明确要求定义团队角色与职责，产物是团队工作流文档。`design-review-process` 的批准链包含设计师自审、同伴评审、设计负责人签字、必要时的 stakeholder 批准和开发者接受。这些描述的是实际团队的协作责任，仓库没有为每个责任方生成账号、启动进程或强制审批。[setup-workflow](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/commands/setup-workflow.md)、[design-review-process](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills/design-review-process/SKILL.md)

组件文档中的 `ARIA roles` 又是第三种含义：它属于界面可访问性语义，与人员职责和 AI Agent 身份无关。[component-spec](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/component-spec/SKILL.md)

### 没有观察到独立 Agent 编排层

固定版本完整目录树没有 `agents/`、`roles/` 或独立 Agent 配置路径；抽查的插件 manifest 只有名称、版本、说明、作者等元数据；commands 是有序 Markdown 步骤。由这些证据可判断本仓库自身没有实现任务队列、子 Agent 启动、独立记忆、运行状态持久化或自动审批控制器。宿主助手是否选择使用子 Agent 是另一层行为，不能从 skill 的专家身份句推导出来。[目录树](https://api.github.com/repos/Owl-Listener/designer-skills/git/trees/9a6930cf84a822eb458624bd11c61aac5bbdf224?recursive=1)、[插件 manifest 样本](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/.claude-plugin/plugin.json)、[command 模板](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/COMMAND_TEMPLATE.md)

特别容易误读的是 `parallel-concepts` 和 `/explore-options`：这里的 parallel 指同时保留多个候选设计、以相近完成度比较行为差异，避免过早打磨第一案；文件没有要求创建多个并行 Agent。[parallel-concepts](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/parallel-concepts/SKILL.md)、[explore-options](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/commands/explore-options.md)

## 工作流：三层组织

### 第一层：入口路由

`/designer-toolkit:start-here` 先判断两件事：用户已经决定了多少，以及需要交付什么。它将工作放到 **understand → frame → explore → make → validate → ship** 中，给出一个当前入口、后续命令和可跳过的阶段；若信息不足，先问一个最能定位的问题。文件允许执行该入口或给出准确命令，未安装时先提供安装行。它是流程导航器，阶段是推荐顺序，文件明确说不是强制 gate。[start-here](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/commands/start-here.md)

### 第二层：插件内部 command 串联 skills

普通 command 负责完成一个边界明确的作业：

| 命令 | 内部步骤缩写 | 直接产物 |
| --- | --- | --- |
| `/design-research:discover` | user-persona → empathy-map → journey-map → 综合 | 研究总结、洞察与设计影响 |
| `/ux-strategy:frame-problem` | 探索假设 → stakeholders → brief → 约束 → metrics → principles → opportunities | 问题定义、范围、约束、成功标准和优先级 |
| `/prototyping-testing:explore-options` | 先定标准 → 设计多个行为差异方案 → wireframes → flows → heuristic review → selection | 同完成度概念集与保留取舍的决策记录 |
| `/ui-design:design-screen` | grid → hierarchy → typography → color → spacing → responsive → dark mode | 完整屏幕规格 |
| `/interaction-design:design-interaction` | states → micro-interactions → animation → gestures → feedback → errors → loading | 状态图与交互规格 |
| `/visual-critique:critique-screen` | hierarchy、brand、composition、typography、color、affordance、density → 排序 | P1/P2/P3 修复清单 |
| `/design-ops:handoff` | visual/interaction specs → QA → review readiness → version → package | 工程交接包、资产清单、QA 和实施说明 |

以上是文件步骤归纳，不承诺自动产出 Figma 文件或可运行前端。[discover](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/commands/discover.md)、[frame-problem](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/commands/frame-problem.md)、[explore-options](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/commands/explore-options.md)、[design-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/commands/design-screen.md)、[design-interaction](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/commands/design-interaction.md)、[critique-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/commands/critique-screen.md)、[handoff](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/commands/handoff.md)

贡献约定要求普通 command 只能调用自己插件的 skills，避免依赖用户没有安装的领域；router 是显式例外，以 `/plugin:command` 形式跨插件导航。Skill 的 description 可以提及其他插件的相邻 skill，但必须带所属插件名，这主要用于划清选择边界。[CONTRIBUTING](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/CONTRIBUTING.md)

### 第三层：跨阶段依靠产物交接

README 建议的自然顺序是研究 → 策略 → UI/交互 → 系统化 → 交付运营，但强调不是严格流水线。实际交接依靠上一步产物进入下一步上下文，例如研究证据成为 brief 输入，brief 的成功标准和产品原则成为 concept selection 标准，决策记录为 design rationale 提供依据，最终规格交给开发并通过 QA 核对。[README](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/README.md)、[design-brief](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/design-brief/SKILL.md)、[concept-selection](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/concept-selection/SKILL.md)、[handoff-spec](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills/handoff-spec/SKILL.md)

文件规定了交接内容，但没有统一 artifact schema、共享存储协议或自动向下游传递文件的代码。要在长流程中可靠使用，建议人为维护一份 brief、证据目录、候选与决策记录、最终规格，并在每次调用时明确传入；这是本次研究的使用建议，不是仓库已实现的运行能力。

## 需要注意的边界与文档不一致

1. **仓库数量与 marketplace 数量不同。** 固定版本目录树实际是 9 个本地插件、111 个 skills、34 个 commands。README 顶部的 273/76/33 是五个 collection 的宣称总数，包含四个其他仓库，本次未对它们逐项验证。README 某段仍写 “all 107 skills”，与本地实际 111 不一致。[README](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/README.md)、[目录树](https://api.github.com/repos/Owl-Listener/designer-skills/git/trees/9a6930cf84a822eb458624bd11c61aac5bbdf224?recursive=1)
2. **Gemini 与 Claude command 不能直接视为完全等价。** `build-gemini.sh` 将 SKILL.md 全文拼进 GEMINI.md，但 commands 仅保留名称和 description 的 `Available Workflows` 列表；它没有复制 command 的完整步骤和 Output。Gemini 获得 skills 正文及流程摘要，而非同一份完整 command 正文。没有实际运行验证两种宿主的输出质量。[build-gemini.sh](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/scripts/build-gemini.sh)、[Gemini context 样本](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/.gemini/extensions/design-research/GEMINI.md)
3. **名字相同的 command 有不同边界。** `design-research:test-plan` 从研究问题到参与者、任务、指标、主持指南和 pilot checklist，偏完整可用性研究；`prototyping-testing:test-plan` 更强调方法选择、task scenarios、click tests 与无障碍覆盖。使用完整命名空间可减少歧义。[研究 test-plan](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/commands/test-plan.md)、[原型 test-plan](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/commands/test-plan.md)
4. **流程约定不是硬性运行验证。** CONTRIBUTING 要求 command 3–7 步且每步命名 skill，但 `create-component` 和 `critique-screen` 实际各有 8 步，部分 command 的探索、综合、约束步骤没有独立命名 skill。应将约定理解为维护标准，不能假定当前全部内容都严格符合。[CONTRIBUTING](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/CONTRIBUTING.md)、[create-component](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/commands/create-component.md)、[critique-screen](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/commands/critique-screen.md)
5. **研究技能不提供真实研究数据。** `user-persona` 明确要求使用已有研究证据；若只有产品想法，输出需要被当作待验证假设，不能当作真实访谈结论。`discover` 后续建议访谈或测试，也是这一交接的重要部分。[user-persona](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/user-persona/SKILL.md)、[discover](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/commands/discover.md)

## 对当前项目的可借鉴点（研究推论）

可以借鉴其 skill 职责描述、输入情境、相邻技能边界和 command 作业步骤，不应直接把 111 个 skills 映射成 111 个 Agent，也不必把九个 plugin 映射成九个并发执行角色。若接入现有工作流系统，可将 skill 视为按任务加载的能力，将责任人、审批者、执行实例和产物持久化分别建模。这是从本仓库结构归纳的建议；本次没有评估当前项目的具体接口或提出代码改动。

## 使用示例与接入建议

在 Claude Code 中，仓库提供的基础入口是：

```text
/plugin marketplace add Owl-Listener/designer-skills
/plugin install designer-toolkit@designer-skills
/designer-toolkit:start-here 我正在重新设计一个结账流程，已有页面和用户反馈，需要确定下一步。
```

添加 marketplace 只是登记来源；安装 designer-toolkit 才有 start-here 入口，其他领域插件按路由需要安装。若已知道任务，也可直接安装对应插件并执行对应 command。[README](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/README.md)、[start-here](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/commands/start-here.md)

例如已有后台界面且需要改善体验，可以安装并使用 visual-critique，传入截图与目标任务，再根据修复清单进入 UI 或交互设计。新产品且没有研究基础，先从 research 开始；只有单个明确交付物，则直接选择对应 skill 或 command。前一步产物应保留并明确作为后一步输入。[INDEX](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/INDEX.md)、[start-here](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/commands/start-here.md)

接入其他 Agent 系统时，建议保留五个分离的概念：领域包、专业能力、专业视角、任务步骤、宿主执行机制。优先复用该仓库的 description 选择边界和具体步骤，再由宿主处理工具权限、产物存储、恢复和审批。这个设计建议来自其文件组织，不代表仓库已提供跨宿主适配器。

仓库 CI 检查 frontmatter、运行时文件约定、README 和 INDEX 生成结果、Gemini 打包一致性及 marketplace 来源。它能够发现结构与发布材料问题；这些检查本身不衡量真实用户研究的可信度或最终设计效果。[CI](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/.github/workflows/lint.yml)


## 完整技能和命令目录

以下按锁定提交的实际文件统计，限本仓库的九个插件；Gemini 中的打包副本不重复计数。总计 111 个技能、34 个命令。命令以 `/插件名:命令名` 使用。这里仅列名录，各文件的具体内容与约束以原文为准。

### design-ops

技能 9 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills)。

`design-critique`、`design-debt-audit`、`design-impact-reporting`、`design-qa-checklist`、`design-review-process`、`design-sprint-plan`、`handoff-spec`、`team-workflow`、`version-control-strategy`。

命令 3 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/commands)。

`/design-ops:handoff`、`/design-ops:plan-sprint`、`/design-ops:setup-workflow`。

### design-research

技能 14 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills)。

`affinity-diagram`、`behavioural-analytics`、`card-sort-analysis`、`diary-study-plan`、`empathy-map`、`interview-script`、`jobs-to-be-done`、`journey-map`、`qual-quant-triangulation`、`research-repository`、`summarize-interview`、`survey-design`、`usability-test-plan`、`user-persona`。

命令 4 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/commands)。

`/design-research:discover`、`/design-research:interview`、`/design-research:synthesize`、`/design-research:test-plan`。

### design-systems

技能 11 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills)。

`accessibility-audit`、`component-spec`、`design-system-governance`、`design-token`、`documentation-template`、`icon-system`、`localization-design`、`motion-system`、`naming-convention`、`pattern-library`、`theming-system`。

命令 3 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/commands)。

`/design-systems:audit-system`、`/design-systems:create-component`、`/design-systems:tokenize`。

### designer-toolkit

技能 7 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/skills)。

`case-study`、`design-negotiation`、`design-rationale`、`design-system-adoption`、`design-token-audit`、`presentation-deck`、`ux-writing`。

命令 4 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/designer-toolkit/commands)。

`/designer-toolkit:build-presentation`、`/designer-toolkit:start-here`、`/designer-toolkit:write-case-study`、`/designer-toolkit:write-rationale`。

### interaction-design

技能 22 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/skills)。

`animation-principles`、`conversational-ux`、`doherty-threshold`、`error-handling-ux`、`feedback-patterns`、`fitts-law`、`form-design`、`gesture-patterns`、`hicks-law`、`interfaces-that-feel`、`jakobs-law`、`loading-states`、`micro-interaction-spec`、`millers-law`、`navigation-patterns`、`onboarding-design`、`peak-end-rule`、`search-ux`、`serial-position-effect`、`state-machine`、`teslers-law`、`zeigarnik-effect`。

命令 5 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/interaction-design/commands)。

`/interaction-design:design-form`、`/interaction-design:design-interaction`、`/interaction-design:design-onboarding`、`/interaction-design:error-flow`、`/interaction-design:map-states`。

### prototyping-testing

技能 10 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills)。

`a-b-test-design`、`accessibility-test-plan`、`click-test-plan`、`concept-selection`、`heuristic-evaluation`、`parallel-concepts`、`prototype-strategy`、`test-scenario`、`user-flow-diagram`、`wireframe-spec`。

命令 5 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/commands)。

`/prototyping-testing:evaluate`、`/prototyping-testing:experiment`、`/prototyping-testing:explore-options`、`/prototyping-testing:prototype-plan`、`/prototyping-testing:test-plan`。

### ui-design

技能 19 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/skills)。

`aesthetic-usability`、`color-system`、`dark-mode-design`、`data-visualization`、`illustration-style`、`law-of-closure`、`law-of-common-region`、`law-of-continuity`、`law-of-figure-ground`、`law-of-proximity`、`law-of-similarity`、`layout-grid`、`platform-conventions`、`readable-measure`、`responsive-design`、`spacing-system`、`typography-scale`、`visual-hierarchy`、`von-restorff-effect`。

命令 5 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/commands)。

`/ui-design:color-palette`、`/ui-design:design-screen`、`/ui-design:platform-audit`、`/ui-design:responsive-audit`、`/ui-design:type-system`。

### ux-strategy

技能 12 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills)。

`business-design`、`competitive-analysis`、`content-strategy`、`design-brief`、`design-principles`、`experience-map`、`information-architecture`、`metrics-definition`、`north-star-vision`、`opportunity-framework`、`service-blueprint`、`stakeholder-alignment`。

命令 3 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/commands)。

`/ux-strategy:benchmark`、`/ux-strategy:frame-problem`、`/ux-strategy:strategize`。

### visual-critique

技能 7 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/skills)。

`critique-affordance`、`critique-brand-consistency`、`critique-color`、`critique-composition`、`critique-information-density`、`critique-typography`、`critique-visual-hierarchy`。

命令 2 个：[原始目录](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/commands)。

`/visual-critique:critique-screen`、`/visual-critique:critique-ux`。

## Creative Team Pack 复用分析

### 核验范围与组织前提

本次为 `agentic-creative-team-pack` 的补充研究，重新读取上游 `main` 目录树后，commit 仍为 [`9a6930cf84a822eb458624bd11c61aac5bbdf224`](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224)，与前次研究一致。继续固定该版本引用，重点检查概念探索与选择、品牌一致性、设计原则与愿景、研究证据管理、组件治理、QA 与交接，没有安装或执行上游代码。本节只评估 designer-skills；对 taste-skill、impeccable 的取舍应与它们各自的研究合并，不能把这里的判断外推为另外两个仓库的事实。

以下组织结构和交付形式来自本次需求：**Head of Design 下设负责产品设计的 Design Director，以及负责品牌策略和识别的 Creative Director**；概念阶段交付 **3–5 张静态概念图，配简短说明，集中封装在一个 HTML gallery**。后续角色分工、流程状态与产物字段均为本次研究建议，不是上游已有的 Agent 运行时。

### 上游能提供什么，不能代替什么

| 重点能力 | 已核对的上游事实 | 对 Creative Team Pack 的意义 |
| --- | --- | --- |
| 并列概念探索 | `parallel-concepts` 用用户行为差异区分概念，要求相近完成度，并保持同一视觉语言；数量由成本与风险决定，没有固定 3–5 的规则 | 可用作产品交互方案探索，不能原样作为品牌视觉方向探索；3–5 图是本次 pack 的要求 |
| 概念选择 | `concept-selection` 要求比较前固定标准，区分硬门槛和可权衡项；记录获胜方案代价、落选方案测试的假设、落选原因与恢复条件 | 值得保留为决策方法；静态图只能提供视觉与概念沟通证据，不能证明实际任务完成率 |
| 品牌一致性 | `critique-brand-consistency` 比对已有 `mood.md`、`voice.md`、`tokens.md`；缺文件应说明并跳过相应维度 | 这是品牌执行审核能力，依赖先完成品牌基线；不能自行补造品牌定位与识别 |
| 原则与愿景 | `design-principles` 要求原则有立场、可执行、可检验且有优先级；`north-star-vision` 定义长期产品体验、3–5 个 pillars、情景和成功标准 | 可支持 Head 与两位 Director 对齐，但产品愿景和品牌定位需要分别定义并建立联系 |
| 访谈与证据 | `interview-script` 强调真实经历、非引导提问；`summarize-interview` 区分明确陈述与推断；`research-repository` 分 Insights、Studies、Raw data，并给 insight 记录来源、时间、样本与置信度 | 可成为两条设计线共享的证据底座；客户 brief 访谈与用户研究应采用不同问题集，不能混称同一种研究 |
| 组件与治理 | `component-spec` 覆盖 anatomy、props、variants、states、行为、可访问性和使用规则；`design-system-governance` 覆盖 ownership、贡献、评审、版本、弃用和迁移 | 可成为产品实施规范与设计系统治理材料；仍需本地实现负责人、审批记录、版本绑定与状态转换 |
| QA 与交接 | `design-qa-checklist` 要求按规格核对构建结果，以截图记录差异并验证修复；`handoff-spec` 覆盖视觉、交互、内容、资产、边界情况和实施假设 | 可保留检查维度，但在 graph 中必须区分“写出了检查清单”和“运行后获得了验证证据” |

表格依据：[parallel-concepts](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/parallel-concepts/SKILL.md)、[concept-selection](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/concept-selection/SKILL.md)、[critique-brand-consistency](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/skills/critique-brand-consistency/SKILL.md)、[design-principles](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/design-principles/SKILL.md)、[north-star-vision](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/north-star-vision/SKILL.md)、[interview-script](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/interview-script/SKILL.md)、[summarize-interview](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/summarize-interview/SKILL.md)、[research-repository](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/research-repository/SKILL.md)、[component-spec](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/component-spec/SKILL.md)、[design-system-governance](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/design-system-governance/SKILL.md)、[design-qa-checklist](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills/design-qa-checklist/SKILL.md)、[handoff-spec](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills/handoff-spec/SKILL.md)。

### 建议采用“保留方法、适配契约、参考编排”三层

这里的“保留”指保留经过检查的方法和判断标准，不表示直接安装所有上游内容，也不表示无需与另外两个来源去重。

| 层级 | 建议纳入的能力 | 本地处理 |
| --- | --- | --- |
| 保留核心方法 | 非引导访谈；研究来源与推断分离；先定标准再选概念；落选方案可追溯；组件规格；按设计规格进行 QA；完整 handoff | 维持这些判断规则，转为 pack 的统一输入、输出和证据格式 |
| 适配后作为正式能力 | `parallel-concepts`、`design-principles`、`north-star-vision`、`critique-brand-consistency`、`research-repository`、`design-system-governance`、`version-control-strategy` | 加入领域 owner、候选与基线版本、图与说明的产物引用、适用阶段、变更权限和失败去向；补齐产品与品牌边界 |
| 仅参考 | 现有 `/start-here` 路由表、Markdown command 的全套调用顺序、真人团队仪式与工具清单、固定插件包装 | 本地 graph 成为流程的唯一调度定义；不把旧 command 与新 graph 同时设为两个流程控制者；按 pack 目标挑能力，不把 111 个 skill 自动映射成 111 个角色 |

这一分层来自上游 skill/command 与 runtime 的分离方式，以及本次组织需求；上游并没有提供 ADLC graph schema。尤其 `research-repository` 的置信度是描述性判断标准，不应误转成无依据的数值概率；`design-system-governance` 的人类 review 流程也不会自动生成可强制执行的审批。[research-repository](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-research/skills/research-repository/SKILL.md)、[design-system-governance](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/design-system-governance/SKILL.md)、[version-control-strategy](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-ops/skills/version-control-strategy/SKILL.md)

### Brand Strategy / Identity 需要新增主干

检查本地 111 个 skill 的目录与上述重点正文后，未发现专门覆盖完整品牌定位、命名、标志系统和跨触点品牌识别交付的端到端能力。现有 `competitive-analysis` 偏 UX 模式与产品机会，`north-star-vision` 偏产品未来体验，`content-strategy` 有 voice/tone，`illustration-style` 定义插画风格，`critique-brand-consistency` 检查已有规则。这些是有用的相邻材料，不能据此称仓库已经具备完整品牌策略与识别能力。[技能目录](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/INDEX.md)、[competitive-analysis](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/competitive-analysis/SKILL.md)、[content-strategy](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ux-strategy/skills/content-strategy/SKILL.md)、[illustration-style](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/ui-design/skills/illustration-style/SKILL.md)

建议 Creative Director 负责新增四组相互衔接的能力：

1. **Brand Strategy**：品牌受众与商业背景、竞争框架、定位、品牌承诺、差异点、支持承诺的证据、品牌个性，以及与产品价值主张的关系。明确哪些来自客户决定，哪些来自研究，哪些只是待验证假设。
2. **Creative Territories**：围绕同一策略形成 3–5 个可比较的创意方向；每个方向说明核心观念、情绪表达、独特性与风险，并用一张静态图表达。把具体字体、颜色或风格选择连接到方向意图。
3. **Brand Identity System**：选定方向后发展 verbal identity、信息层级、必要的命名与 tagline 探索、标志/字标及组合方式、品牌色与字体、图像/摄影/插画/图标方向、动效性格，以及不同触点的使用规则。产品 tokens 是此识别体系在 UI 中的映射之一。
4. **Brand Rollout & Governance**：跨触点示例、可用资产、格式和版本、正确/错误用法、例外审批及更新方式。品牌表现评审与实际生产文件/资产质量检查分开记录。

这四组是 pack 的新增设计建议，不是对上游已经实现的功能描述。也不应把概念静态图等同于已完成可生产的标志向量、字体授权或整套品牌资产。

### 从 3–5 概念转入单一语言：显式分阶段

建议 graph 把“探索中的候选”和“获准使用的基线”定义为不同状态，避免审美技能在探索期强行统一方向，或在交付期不断引入新风格。

| 阶段 | 建议规则与产物 |
| --- | --- |
| 1. 定义问题与选择标准 | 明确决策 owner、受众、交付场景、已知约束；先冻结硬门槛与可权衡标准。判定本轮是在比较产品行为，还是品牌表达 |
| 2A. 产品概念探索 | 使用同一品牌/视觉基线，变化信息结构、操作顺序、系统与人的分工、入口或承诺点；3–5 张图应体现不同产品方案，并用简短说明解释静态图无法呈现的行为差异 |
| 2B. 品牌方向探索 | 固定品牌策略、受众、相同应用场景和呈现完成度，允许每个方向拥有不同视觉语言；比较视觉表达本身时，不套用上游“所有概念保持同一视觉语言”的规则 |
| 3. 单页 gallery 交付 | 用一个 HTML gallery 集中展示 3–5 张静态概念图及简介。每项提供稳定 concept ID、名称、核心意图、主要差异和取舍；图片尺寸、可读性和展示面积应可比。gallery 是概念审阅产物，不是可交互原型或已验证产品 |
| 4. 选择与记录 | 按既定标准选择一个方向；记录理由、代价、落选方向及恢复条件。若全部不满足硬门槛，回到 brief/探索；若标准互相冲突，提交明确的优先级决策。不能把每案喜欢的元素直接拼成一个未被评估的“获胜案” |
| 5. 基线化 | 将获选方向形成有版本的品牌与设计基线：mood、voice、tokens、关键资产与适用规则，保留 selected concept 和 decision record 的引用。候选图不自动成为所有细节的实施规格 |
| 6. 应用与 QA | 后续页面、组件、内容和资产使用该基线；允许基线明确规定的响应式、主题、平台和情境变体。新增视觉语言走变更提案与再评审，不由单个实现步骤自行扩展 |

产品探索与品牌探索可以在不同时间进行，但每一轮必须声明比较变量。若同时需要选择产品行为与品牌方向，应拆成先后两轮或明确受控组合，避免把“行为更好”和“视觉更精致”混成同一个结论。这个两模式设计是对上游方法的适配；静态概念图无法验证交互响应、真实可用性或实现后的可访问性，这些应留到原型/构建验证节点。[parallel-concepts](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/parallel-concepts/SKILL.md)、[concept-selection](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/prototyping-testing/skills/concept-selection/SKILL.md)、[critique-brand-consistency](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/visual-critique/skills/critique-brand-consistency/SKILL.md)

### 对 Roles / Graphs 的映射建议

- **Head of Design**：确定跨产品与品牌的总体目标、资源和优先级，处理两条线的标准冲突与重大方向变更；不必承担每张页面的常规批准。
- **Design Director**：负责产品问题定义、产品概念选择、交互/信息结构、组件规格、产品体验验收；消费已批准品牌基线，不能在局部 UI 中自行改变品牌策略。
- **Creative Director**：负责品牌定位、创意方向、语言和视觉识别、品牌基线以及跨触点品牌表现验收；与 Design Director 共同确认品牌选择在产品中的可用性和实现影响。
- **共享能力**：研究证据、设计系统、QA 和 handoff 可被两条线调用；组织 owner、任务执行者和评审者需要分开建模，不因共享一个 skill 就获得同一种批准权限。

建议每个 graph 交接至少携带：目标与约束、owner、输入证据引用、候选/产物 ID 与版本、适用基线版本、所采用的标准、实际评审证据、决定与未解决问题。概念 gallery、决策记录、批准基线、组件规格和 QA 报告作为不同产物保存。节点只有在其契约满足时才前进；“已经生成文档”“已经审核”“用户已选定”“已获得实际测试证据”不能共用一个完成状态。

以上是 ADLC 风格的建模建议，未声称本次已查明或实现本地 graph schema。具体字段和 gate 类型应适配项目既有模型，避免另造一套与当前运行时不一致的协议。

### 上游许可与来源记录

该固定版本的 [LICENSE](https://github.com/Owl-Listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/LICENSE) 为 MIT，版权声明为 **Copyright (c) 2026 MC Dean**；许可文本要求在软件的副本或实质部分中包含版权与许可声明。若复制或改编技能正文，pack 应保留这份版权与许可文本，不仅保留一个网页链接。

建议另建来源清单，逐项记录本地能力、上游仓库、路径、固定 SHA、许可及本地改写说明；这有助于升级与审查，是工程建议，不是 MIT 额外要求。上游技能引用的研究、书籍、品牌参考或后来加入的字体/图像，应按各自来源记录，不能把 repo 的 MIT 简单视为所有外部素材的授权。此处仅记录已核对的仓库许可文本及建议的来源追踪方式。
