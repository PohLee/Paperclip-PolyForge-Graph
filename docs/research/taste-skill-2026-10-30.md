# taste-skill 深度研究：在 agentic-creative-team-pack 中的位置

研究日期：2026-10-30。仓库：Leonxlnx/taste-skill。默认分支 main，固定提交 **12af471f627f866411b4bd785b19646d3672784c**，提交日期 2026-10-24，插件版本 **2.1.5**。以下源码链接均固定到该提交；“事实”来自仓库，“建议/推论”为本次 pack 设计判断。本次只读取源码和配置，没有安装或执行上游脚本，也没有验证其生成结果。

**结论：Taste 最适合贡献“从主体材料产生创意方向、将方向落实为网页、用浏览器检查成品”的能力，不适合作为整个创意团队的组织层，也不能视为已经具备完整品牌战略与图像生成服务。** 当前用户选择的第一条工作流是 **3–5 张静态设计预览图 + 单一 HTML 展示页 + 每张 concept 简介**；Taste 可以给这条流程提供方向、构图和素材计划，图像生成须由 pack 的独立工具适配器完成。网页构建阶段才使用其 draw / lint / inspect runtime。

## 1. 当前仓库到底包含什么

递归 Git tree 完整、未截断，共 72 个文件，只有一个正式技能：`skills/taste-skill/SKILL.md`，frontmatter 名称是 `design-taste-frontend`。Claude 与 Codex 的 manifest 均指向这个技能目录；没有内置设计团队 agents、组织关系、任务队列或 graph engine。[完整树](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c)、[技能入口](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md)、[Codex 配置](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/.codex-plugin/plugin.json)

| 层 | 实际内容 | 可贡献给 pack 的部分 |
|---|---|---|
| 指令层 | 一个 SKILL.md，两条工作路线：公共网页 / 工作型 app screen | 路由边界与任务规范 |
| 参考知识 | copy、type、colour、layout、imagery、motion、critique、tells、research、app-screens、scenes | 按节点加载的专业资料 |
| 方向资料库 | JSON 中的方向、构图、字体、颜色、参考站、app 模式 | 可检索的创意构成材料 |
| 执行脚本 | draw、assets、lint、inspect、scenes；CDP/probe/rules 辅助库 | 确实可执行的本地工具 |
| 前端基础 | base.css/js、app.css、charts.js、scene stage | 可选实现基础，不应覆盖项目现有设计系统 |
| 包装与检查 | Claude/Codex manifests、安装脚本、GitHub CI、10 个 eval briefs | 分发与基础验证经验 |

实际 JSON 数量如下，区别于 README 对研究样本的描述：

| 库 | 条目数 |
|---|---:|
| directions | 20 |
| heroes | 58 |
| sections | 185 |
| type | 44 |
| palettes | 56 |
| motions | 18 |
| sites | 202 |
| photos | 19 个 sets |
| app.styles | 7 |
| app.shells | 5 |
| app.patterns | 25 |
| app.kinds | 13 |

这些数字由固定提交的 JSON 直接统计。247 是网页研究样本的载入数量，并不是 `sites.json` 的实际条目数。[library 目录](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/library)、[研究方法](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/research.md)

### 已迁出的能力不能计入本仓库

README 明确说明：

- `brandkit`、`imagegen-frontend-web`、`imagegen-frontend-mobile`、`image-to-code` 已移到 `Leonxlnx/imagegen-skills`。
- `high-end-visual-design`、`minimalist-ui`、`industrial-brutalist-ui`、`gpt-taste` 等已移到 `taste-skill-classics`。
- `redesign-existing-projects` 已合并进当前 skill。

因此，不应根据旧文章或旧版本记忆声称这次三个 repo 已提供 brandkit 或专门的 imagegen pipeline；如要纳入迁出仓库，应另行核对来源和版本。[README 的迁移说明](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/README.md#moved-skills)

## 2. 它真正有价值的创意方法

### 2.1 从客户自身材料产生 idea

事实：网页路线先列出 8–12 项属于这个主体的材料：名称含义、地点、数字、限制、材质、仪式、时间、实体物件等。然后建立各 section 的“主张—证据”序列，避免机械套用 hero / features / pricing。脚本从方向库给出候选，agent 选择能承载主体材料的方向，再写出“主体材料如何变成页面构成方式”的概念句。[SKILL.md](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md)、[copy.md](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/copy.md)

特别适合迁移的三个判断：

1. **主体资产清单**：先知道有哪些真实材料，才选择表达方式。
2. **竞争者替换测试**：把最近的竞争者名称放进概念句，若仍然成立，创意可能只属于行业而不是品牌。
3. **一个可体验的核心动作**：网页可以让用户操作一个真正体现产品价值的东西；例如预算计算、材质切换、实时状态，而不是为了动效增加玩具。

建议：概念阶段把这三个判断写进 `ConceptBrief`，不必在快速预览阶段开发交互。静态预览中可以描述“拟议交互”，但不能把尚未实现的交互标记为已完成。

### 2.2 方向是构成方法，不只是颜色板

20 个方向包括：名称成为纪念碑、句子决定布局、固定海报、颜色章节、地点主导、页面成为实体物件、一个母题、产品自我演示、安静仪器、放大的对象、样本目录、借用其他门类、联系印样、印刷年报、响亮平面海报、分屏舞台、密集板面、不等幅照片、暗室、纯字体陈述。每个方向带有适用行业/语气、构图、字体类别、颜色比例、素材、section tags、风险和参考站。[directions.json](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/library/directions.json)

建议：3–5 个 concepts 应在“叙事、构图、视觉母题、字体、图片方式”上有差异，不能只换配色。方向库可作为候选生成空间，但最终取舍仍服从需求与品牌约束。

## 3. 两条现有工作路线

### 3.1 公共网页路线

原始顺序为：

`读取 brief / 主体清单 → 主张与证据 → 抽取方向 → 写概念句 → 全页文案 → 静态构建 → lint/inspect → 看截图并修正 → 动效 → 最终报告`

构建阶段先写 tokens，再做 hero、section、图片、关键互动、可用 scenes、版面与状态。检查要求在 1440 / 768 / 390 宽度打开真实浏览器，检查最终 production build，并逐张看截图，最多三轮修正。[SKILL.md](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md)

事实：README 自报完整构建约 30–45 分钟、数十万 tokens，大部分成本可能在图片与迭代。这不是针对当前宿主验证过的性能承诺。[技能 README](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/README.md)

推论：把这条完整路线复制 3–5 次，不能合理地称为快速概念预览。应把发散和制作拆开。

### 3.2 App screen 路线

原始顺序为：

`数据与工作清单 → 当前屏幕优先回答的问题 → 选择 app style / 产品特征 → 建 shell → 数据与图表 → 完整状态 → app 检查 / 看图 → 报告`

该路线具有较强的 SaaS 价值：

- 数据对象、字段、单位与现实数量级先行。
- 总数从行数据计算；同一事实显示多次时使用同一变量。
- 每个 screen 有一个主要问题、一个当前发现、一个最常用动作。
- shell 标明产品、workspace/account scope。
- 为 empty、zero、loading、error，以及 hover、selected、focus、disabled 建状态。
- 导航、表格、多个 panes 在手机上有不同排布规则。
- 营销页里的 app 片段按 app 规则处理；营销页和 app 共享 palette/type，而非共用相同密度与版式。[app-screens.md](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/app-screens.md)

7 个 app styles 为 achromatic-ledger、framed-sheet、accent-ladder、editorial-greeting、pastel-consumer、true-black-flat、data-terminal；它们是设计处理方式，不是业务数据模型，也不是 BE contract。[app.json](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/library/app.json)

缺口：没有 API schema 管理、认证/权限合同、分页/排序协议、异步任务协议、服务端错误映射、契约测试或跨版本设计 token 管理。真实 BE 协作需要 pack 在这条路线前后补充合同节点；不能把“示例数据对得上”视为后端联调完成。

## 4. Runtime 能力与文字规范的边界

| 文件 | 已存在的可执行行为 | 没有因此自动实现的东西 |
|---|---|---|
| draw.mjs | 根据 sector/tone/assets/history/seed 组合方向，输出文字方向说明和 direction.json；支持 2–5 个 options、指定方向、局部 redraw | 不渲染 3–5 张图片；不调用图像生成模型 |
| lib/app-draw.mjs | 按 kind/theme 选择 app style/shell/screen patterns，生成方向 sheet | 不连接真实 API，不自动建立 app |
| assets.mjs | 搜索开放图片/视频源，下载所选素材并记录 credits | 不生成新图像；来源许可不是全包统一许可 |
| lint.mjs | 对源码进行正则扫描，返回 FAIL/WARN、JSON、exit code | 不是完整 AST 分析，不理解全部组件语义 |
| inspect.mjs | CDP 启动浏览器、测量 DOM/CSS、滚动截图、规则判断、report.json、exit code | 不等于完成键盘/读屏/端到端业务测试；截图评审仍由 agent 做 |
| scenes.mjs | 采集页面中已存在 scene 的过程画面 | 不代表库中已有每个 scene 的现成实现 |
| app.css / charts.js | 现成 CSS 与 SVG 图表工具 | 不是团队设计系统 registry，也不是 Figma 组件库 |

证据：[draw](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/draw.mjs)、[app-draw](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lib/app-draw.mjs)、[assets](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/assets.mjs)、[lint](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lint.mjs)、[inspect](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/inspect.mjs)、[scenes](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/scenes.mjs)

脚本使用 Node 内置能力，inspect 的 CDP client 需要 Node 22+ 和已安装 Chrome/Edge/Chromium；draw/lint/assets 可在 Node 18+ 运行。现有框架可以是 React、Vue、Svelte、普通 HTML 等；redesign 明确要求保留原有 stack，避免顺手迁移框架。真正的技术绑定主要是浏览器、Node、HTML/CSS 语义与默认检查宽度。[技能 README](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/README.md)、[CDP client](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lib/cdp.mjs)

## 5. 不能原样提升为全团队规范的 house style

Taste 自己明确区分研究发现与作者审美，但实现里两者都可以触发 FAIL：

| 规则 | 公共网页 | App screen |
|---|---|---|
| 渐变、紫色/靛蓝、cream + terracotta | 原则上禁止 | 大多仍禁止，图表区域存在局部例外 |
| eyebrow、mono、装饰编号、细分隔线 | 严格禁止，code/table/form/UI fragment 有特例 | labels、IDs、表格与 panel lines 可以保留 |
| 同形 cards | 不接受机械重复 feature cards | 同类数据或对象允许重复 panel/card |
| 图片数 | 要求至少四张真实图片或合格 app fragments | 无此 floor |
| 动效 | 至少八个实际运动元素，否则可 FAIL | 只做反馈，不设动效 floor，禁止入场表演 |
| headline | 两行以内、强视觉主次 | 更小的 screen title，密度优先 |
| 既定品牌 | keep palette/type，再显式允许例外 | 同样需要保留品牌并映射到角色 |

来源：[主规范](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md)、[App 规则](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/app-screens.md)、[规则实现](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lib/rules.mjs)

几个具体风险：

- App 研究的 23 张屏幕中，10 张使用紫色/靛蓝；文档承认禁紫色来自作者偏好，不是研究结论。
- 研究发现 mono labels 和编号在高分站点反而更常见，它仍然禁用。
- 图片与动效最低数量不适合作为所有品牌和任务的通用成功条件。
- 两行 headline、约 32 字符预算来自以拉丁字体和特定网页样本为主的经验，中文、混合语言、复杂产品名需要独立判断，不能直接按字符数迁移。
- “不询问，先决定并说明”的默认不符合本 pack 的快速 interview 需求；应由需求节点控制问题预算。

建议分三层管理规则：

1. **项目硬约束**：用户明确要求、可访问性、交互有效性、数据真实性、品牌批准资产。
2. **设计系统规则**：版本化 tokens、components、patterns、内容语气。
3. **可选审美 profile**：Taste 的 editorial/no-ornament 等偏好，可替换、有记录的例外。

与其他 repo 的潜在冲突：不要让三份广泛触发的 frontend skill 同时成为最高层指令。designer-skills 的系统化规格与 Taste 的反装饰禁令可能对同一组件给出不同建议；Impeccable 的工作界面和宣传界面分类也应与 Taste 的 page/app route 对齐。此处是集成推论，最终冲突表应结合另外两份独立研究，不把其中任何一份审美当成事实标准。

## 6. 研究证据强度与实现缺口

### 6.1 研究不是用户验证或真实 Awwwards 评分

初始研究收集 248 个站点，247 可载入；模型 panel 可用 235 个，字体可测 202 个。21 个模型评委从截图和测量给出设计/可用性/创意/内容评分。文档明确说这不是人类评审，也不是站点实际 Awwwards 分数；最近精选图库本身包含流行趋势偏差。[research.md §1](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/research.md)

五轮盲评中，最终一轮 Taste 平均 7.7，baseline 7.8，另一技能 7.2，Taste 在三项中胜两项；前几轮多次落后 baseline。评委是模型，每 brief 每轮只有一个评委，最终一轮 brief 在上一轮见过。因此可借鉴它的迭代方法，不能宣称它已严格证明比无技能或其他技能更优秀。[research.md §11](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/research.md)

App 研究只有 23 张桌面图、17 个产品，截图未公开、产品未命名；没有手机图、loading/error、inbox 或真正高密度操作台样本。文档会把超出样本的规则标为 house rule。应将这些规则作为设计启发，而不是跨产品适用性证据。[app-screens.md](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/app-screens.md)

### 6.2 文档与实际 tree 存在差距

SKILL.md 描述 `library/scenes.json`、每个 scene 的 JS/CSS 和 demo 页面，但固定 tree 的 scene assets 实际只有 `stage.js` 与 `stage.css`，没有 scenes.json 或逐 scene demo。draw 对 scenes.json 有存在性判断并回退空数组，所以这是能力目录不完整，不是已证明 draw 会崩溃。[scene assets](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/assets/scenes)、[draw.mjs](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/draw.mjs)

技能 README 仍提到六个测试 brief，但当前 evals.json 已含十个，后四个是 app screens。CI 实际检查 frontmatter、编码、JS 语法、browser profile cleanup、输出文件名；并没有自动跑完视觉评估或真实用户可用性测试。[evals.json](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/evals/evals.json)、[CI](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/.github/workflows/check-skills.yml)

### 6.3 并行 graph 不能直接共享默认目录

- draw 默认写 `.taste-skill/direction.json`。
- history 默认写用户目录的 `.taste-skill/history.json`，可用 `TASTE_SKILL_HISTORY` 改位置。
- direction 既受 seed 也受 history 影响；只记录 seed 不保证重演相同选择。
- inspect 优先查当前 cwd 的 direction.json，再看输出目录的上层；仅改 `--out` 不一定能防止串入其他概念的配置。
- history 采用直接读取/整体写回，未看到并行锁机制。

建议：每个 graph branch 使用独立工作目录和 history；存完整 direction.json、输入、源码 SHA 与允许的规则例外。选定 concept 后冻结方向文件；后续页面使用同一语言，不重新随机抽方向。[draw](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/draw.mjs)、[app-draw](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lib/app-draw.mjs)、[inspect](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/inspect.mjs)

静态 lint 的豁免方式是逐行 `taste-skill-ignore`，inspect 则使用 `--allow` 和方向文件中的 allow；两套例外没有统一的项目 contract。Pack 应由同一 exceptions artifact 生成两边参数，避免通过了浏览器却被源码 lint 因既定品牌卡住。[lint](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/lint.mjs)

## 7. 品牌覆盖与缺口

Taste 已有：主体差异性、概念句、竞争者测试、字体与配色体系、图像风格、文案、产品 mark 的简单表达、既定品牌保留、跨营销页与 app 的 palette/type 一致性。

Taste 未形成专门工作流：品牌调研、定位、受众细分证据、品牌架构、命名、核心主张、价值观与理念论证、品牌语气治理、完整标志系统、VI 应用、商标评估、长期品牌资产管理。现有 asset 搜索与小型 mark 生成不能替代这些职责。特别是 brandkit 已迁出。[技能入口](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md)、[README](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/README.md)

建议把它的能力主要放在 Creative Director 下面的 Art Director / Concept Designer / Visual Designer，并让 Design Director 下面的 Product Designer / Design Engineer / Visual QA 使用适当部分。不要把一个 skill 拆成二十个需要常驻的 agent；role 是责任与决策权限，skill 是按节点加载的知识。

| 建议角色 | 从 Taste 借入的能力 | 需要另补 |
|---|---|---|
| Art Director / Concept Designer | 主体清单、概念句、方向库、差异性测试 | 品牌战略输入、concept 比选与预算 |
| Visual / Brand Identity Designer | 字体、颜色比例、母题、图片处理 | 完整 logo/VI、品牌规范版本 |
| Product Designer | app 的问题/动作/数据/状态路线 | 用户研究、任务流、信息架构、权限与 API 合同 |
| Design Engineer | tokens 实现、app.css/charts、响应式 | 项目组件复用、BE 集成、功能测试 |
| Visual QA | 多宽度测量、截图批评、有限迭代 | 可访问性、交互测试、跨页面回归 |
| Creative Director / Design Director | 方向与质量判断的依据 | 资源决策、审批责任、冲突仲裁与 graph 状态 |

以上是 pack 设计建议，不是仓库声明的组织结构。

## 8. 对目标 graph 的具体建议

### A. 快速概念：需求 → 3–5 张静态图 → 一个展示 HTML

推荐节点：

`brief intake → 3–5 个关键问题 → normalized brief → subject inventory → 3–5 direction briefs → 图像工具生成 3–5 张静态图 → 概念差异检查 → 单一 HTML 展示页 → 用户选定 concept`

每个 concept 必须带：名称、核心 idea、目标受众与场景、差异化主张、视觉语言、关键版式/图片策略、适合的页面类型、假设与约束。展示 HTML 只负责并列看图、阅读简介与记录选择；不应把每个方案做成独立网页原型。静态预览必须标明探索性内容，不能证明交互或可访问性已完成。

Taste 的位置：inventory、方向候选、构图、内容和素材计划。其 `--options 3` 或 `--options 5` 只输出文字方向；**不会生成图片**。生成 adapter 应记录模型、prompt、来源资产、图像路径、尺寸和版本。除非用户要求，不在这个阶段跑完整网页制作与 inspector。

### B. 选定 concept → 完整网页设计图

推荐节点：

`approved concept + 内容 → 页面/section 结构 → 文案与证据 → Design Language v1 → 全页桌面与移动设计 → 素材准备 → 图像/浏览器渲染 → 连贯性检查 → 图像交付包`

可选两种执行模式：设计图工具直接输出；或设计工程构建页面后截图。这里才适合使用 Taste 的完整 page runtime；最终交付依需求仍可以是完整网页设计图。不要误把一个 hero concept 等同完整页面设计，也不要只重画 hero 而后续 section 回到默认模板。

### C. 与 BE 配合的 SaaS 设计

推荐节点：

`业务/用户任务 → 对象与权限 → BE contract → 页面与状态矩阵 → shared tokens/components → app screen design → mock data rendering → contract-linked implementation → visual/interaction/a11y QA → 增量变更`

Taste 的数据先行、single source of displayed facts、empty/zero/loading/error，以及 page/app 分离非常适用。新增字段、权限、状态应沿 contract 与 state matrix 传播。营销页和 app 共享品牌语义 tokens；app 的密度、图表、操作反馈保留自己的规则。每个 feature 不重新随机 style。

### D. Interview HTML 与记录

本仓库未提供 interview HTML、答复持久化或需求版本服务。建议独立构建：

`question schema → interview.html → answers.json → requirement normalization → brief version → graph route`

至少记录 question id/version、原始回答、跳过项、已知事实/假设、必要上传资产、来源和时间。单文件离线表单可以浏览器本地保存并导出 JSON，但不能声称保存到团队服务；需要共享多人回复时，再接明确存储 API。不要依赖“显示提交成功”作为已经持久化的证据。

## 9. 许可证、来源与打包策略

代码与文档使用 MIT，版权标记为 2026 Leonxlnx，分发副本或实质内容时应保留版权和许可文本。MIT 不自动覆盖上游下载的图片、字体或视频。[LICENSE](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/LICENSE)

资产脚本默认提供 public domain、CC0、CC BY、CC BY-SA 范围，记录标题、作者、许可、来源并要求页面 credit；第三方资源仍保留各自许可。库中氛围照片由 Lorem Picsum/Unsplash 提供；字体来自 Google Fonts / Fontshare，应记录实际采用字体的许可。[assets.mjs](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/scripts/assets.mjs)、[技能 README](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/README.md)

建议：

- 记录 source URL、固定 SHA、version、license、导入文件清单、修改说明。
- 上游原版与 pack adapter 分开维护，避免无法追踪的复制粘贴。
- 节点按需加载具体 references；不要每个 agent 吞入全部巨大 JSON。
- 将 house rules 转换成带 profile 和例外的规则目录。
- 使用 pack 的 canonical Design Language；Taste 的方向 sheet 是来源材料，不是第二套永久真相。
- 为 page/app 之外的品牌定位、logo/VI、interview、图像生成与 BE 合同补充原创 skills。
- 第一版不承诺缺失的 scenes 资产；先完成 concept gallery → language lock → web/app → evidence QA。

## 10. 本次核对范围

已读取完整 recursive tree、README、LICENSE、SKILL.md、skill README、Claude/Codex marketplace 配置、安装脚本、CI、eval briefs；核对 draw/app-draw/assets/lint/inspect/CDP/rules/scenes 源码、JSON 数量与典型结构、研究方法、app 工作路线、critique、copy/type/colour/tells 规范。对大型脚本采用接口、状态读写、输出与关键判断的静态追踪；没有在本机运行其检查器或以真实网站复现视觉评分。以上实现风险来自固定提交的源码静态证据，不是运行故障报告。
