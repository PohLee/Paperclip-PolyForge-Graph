# Impeccable 深度研究：作为 agentic-creative-team-pack 的能力来源

研究日期：2026-10-30。固定仓库：`pbakaus/impeccable`；固定提交：`02523aec3e4c4580102d996d1b6a71fbe062e03f`（提交时间 2026-10-29）。本报告通过 GitHub connector 读取固定提交的目录、源文件、配置与测试，没有安装包、启动引擎、执行上游脚本、访问其外部设计目录服务或运行上游测试。下文“已核实”表示源码/文档事实，“建议”表示针对本 pack 的设计推论。

用户最新需求以此为准：快速输入需求并回答少量问题，产出 **3–5 张静态设计预览图，放进一个 HTML gallery，每张附 design concept 简介**。不是给每个方案实现一套可浏览网页。后续可从选定 concept 发展完整网页设计图，再进入 SaaS 与 BE 协作。

## 1. 结论

**Impeccable 最适合承担 pack 的“视觉方向探索、前端设计执行、设计语言持久化和质量评审”能力层。** 它不是完整的 Product Design / Brand Strategy 组织模型，也不是仅有几份 Markdown 的旧式提示词包。

已核实：

- 当前根 `package.json` 为 **4.8.0**，引擎固定版本为 **0.1.18**。仓库包含 Rust runtime、跨宿主打包、浏览器/live 迭代、设计系统文档、概念选择页面与测量式 comp fidelity 流程。
- README 声明 **24 commands、62 deterministic rules**；24 包含已弃用的 `craft` alias。主 Skill 还路由 hooks、doctor、pin 等设置操作，它们不应与 24 个设计命令混为一谈。
- `skill/` 是手写源；`.agents/`、`.claude/`、`.cursor/` 等及 `plugin/` 是生成并提交的分发产物。不要将不同宿主目录当成不同设计能力。
- 目前提供四个辅助 agent：asset producer、finish reviewer、documenter、manual edit applier。它们是执行专职，不是 Head of Design / Creative Director / Design Director 的组织架构。
- README 明确说既有界面的定点迭代是强项，新建页面也是能力，但更难。

来源：[README][readme]、[package.json][package]、[ENGINE_VERSION][engine-version]、[仓库结构说明][repo-guidelines]、[源 Skill][skill]。

**集成判断：保留自己的角色、产物和 graph 契约；按节点调用/改编 Impeccable 的能力。不要让三个上游各自成为全局路由器。** 特别是快速概念 gallery 不宜直接继承上游整套生成图片、选方向、选构图、组件审批、实现、复审的长链。

## 2. 核心设计模型：产品事实、视觉系统与页面策略分层

### 2.1 三类长期上下文

| 记录 | 上游职责 | 对 pack 的价值 |
|---|---|---|
| `PRODUCT.md` | 用户、任务、定位、真实能力、约束、平台、证据、品牌承诺 | 防止不同角色编造互相冲突的产品事实 |
| `DESIGN.md` | 已落地的视觉系统、可机器读取的 token frontmatter，以及使用规则 | 后续页面沿用同一套设计语言 |
| `.impeccable/surfaces/*.md` | 某个页面/产物的目标、访客模式、内容、方向契约、未决项 | 避免把每个页面的营销叙事写成全站规则 |
| `.impeccable/design.json` | DESIGN.md 无法表达的扩展信息，如 motion、breakpoints、阴影、组件 HTML/CSS | 机器展示和规则检查的辅助数据 |
| `.impeccable/critique/*.md` | 评审快照与趋势 | 记录质量判断与后续修复依据 |

`init` 扫描现有项目后才问缺口；每轮最多三个聚焦问题。它负责产品事实，明确不在此阶段 invent palette、字体或视觉世界。平台、已有品牌资产、事实性证据与未决项分开记录。它要求确认推断，不能把仓库推断直接视为用户批准。[init][init]

`document` 提取现有代码的真实设计系统。其 DESIGN.md frontmatter 支持 colors、typography、rounded、spacing、components；组件子项有有限字段，motion、shadow、breakpoints 等移至 sidecar。token 值只应有一处规范来源。文档另有 seed mode，但只建立方向框架，不伪造尚未实现的 tokens。[document][document]

**建议：** pack 保留这一分层，但增加品牌与需求的独立记录：

- 产品事实由 Product Strategy / Research 管理。
- 品牌定位、承诺、价值观、语气、命名和品牌架构，由 Brand Strategy 管理。
- 已选 concept、设计系统、页面策略分别保留版本和批准状态。
- 在 SaaS 项目中，规范 tokens / 组件库是实际实现的权威；DESIGN.md 为其可读投影，不能让新页面的一次偏差自动升级为新标准。

最后一点是整合判断：上游 documenter 主要从完成的作品提取系统；长期 SaaS 更需要“批准的规范 → 实现 → 检测偏差 → 批准变更”的治理闭环。

### 2.2 四种页面模式非常适合 graph 路由

| 模式 | 访客目标 | 典型表面 | 本 pack 推荐路由 |
|---|---|---|---|
| Persuade | 理解、相信并行动 | 官网、营销、活动、定价 | Creative Direction + Product Strategy |
| Operate | 完成任务 | SaaS、后台、编辑器、设置 | Product / Interaction / Design Systems |
| Read | 理解资料 | Docs、帮助、文章 | Content + Information Architecture |
| Experience | 探索作品本身 | Portfolio、作品展示、画廊 | Creative Direction + Visual / Motion |

模式按具体页面决定，不按公司行业决定。SaaS 官网可为 Persuade；登录后的产品为 Operate；帮助中心为 Read。**同一品牌不意味着每个表面使用相同视觉强度。** 这是上游最适合直接借鉴的路由概念。[源 Skill][skill]

Operate 强调熟悉的控件、稳定的状态语义、同用途组件的一致性、固定 rem 字体阶梯以及任务反馈。它明确允许一个好用的字体家族和熟悉 UI 范式；品牌表达落在细节，不能牺牲操作。[Operate guidance][operate]

## 3. 能力目录与适合承担的角色

### 3.1 24 个设计命令

| 类别 | 命令 | graph 中的用途 |
|---|---|---|
| 规划与系统 | init、shape、document、extract | 采集事实、形成 brief、记录系统、提取组件/token |
| 评估 | critique、audit | UX/视觉判断、技术质量检查 |
| 方向调节 | bolder、quieter、distill、colorize、typeset、layout | 有明确目标的视觉修改 |
| 表达增强 | animate、delight、overdrive | 需要动效或更强表达时的可选节点 |
| 完成与防错 | polish、harden、clarify、adapt、optimize、onboard | 完成任务路径、错误/边界、文案、适配、性能、首次使用 |
| 现场迭代 | live、generate | 已运行网页中的局部方案变体与接受写回 |
| 旧 alias | craft | 普通新建请求的旧别名，不应成为新 pack 的核心节点 |

来源：[源 Skill 命令表][skill]、[command metadata][commands]。

`generate` 指围绕运行中页面的指定元素产生多个 live variants；它与用户需要的“3–5 个整体概念图 + 单 gallery”不是同一个入口。[generate][generate]

### 3.2 角色映射建议

以下是为用户提出的组织架构设计的映射，并非上游已存在的 role：

| pack role | Impeccable 可提供什么 | 仍需补充什么 |
|---|---|---|
| Head of Design | 按页面模式判断质量目标、处理方向与系统边界 | 跨团队优先级、预算、升级与最终设计治理 |
| Design Director | shape、Operate、critique、audit、polish | 研究证据、业务目标、跨流程 UX、BE 合作决策 |
| Creative Director | new-work、visualize、方向契约、表达调节 | 品牌策略、传播理念、品牌架构和长期创意一致性 |
| Product / Interaction Designer | shape、onboard、harden、adapt | 完整领域状态、业务规则、权限、API 契约 |
| Design Systems Designer | document、extract、polish | 组件 API、版本、变更审议、设计与代码映射 |
| Visual / Web Designer | 字体、布局、配色、可视稿、页面构图 | 依具体业务补充内容设计与可用性证据 |
| Creative Technologist / FE Designer | code-led build、live variants、motion | 项目实际 FE 工程约定与测试 |
| Design QA / Accessibility Reviewer | critique、audit、finish review | 专业可访问性验证、真实用户测试 |
| Brand Strategist / Identity Designer | 定位/品牌承诺记录、visual-world workshop | 品牌命名、品牌主张、Logo/标志规范、完整 VI/应用系统 |

组织汇报关系与执行 graph 应分别定义：Design Director 和 Creative Director 均向 Head of Design 汇报；执行时小任务不必经过每位总监，只有方向锁定、系统变更或冲突裁决才升级。

### 3.3 四个上游辅助 agent 的边界

| Agent | 实际角色边界 |
|---|---|
| asset producer | 根据 spec 生成素材、保留 prompt/provenance；不是品牌战略负责人 |
| finish reviewer | 读取提交的 screenshots、comp、contract、source 与既有检测发现，返回质量 disposition；不编辑、不自开浏览器截图 |
| documenter | 从完成的代码提取真实系统；普通扩展保留已有系统，不顺手修无关 drift |
| manual edit applier | 将 live 浏览器编辑写回源文件，处理应用与验证；不是任意前端开发者 |

来源：[asset producer][asset-agent]、[finish reviewer][review-agent]、[documenter][doc-agent]、[manual edit applier][edit-agent]。

## 4. 快速概念图 + 单 HTML gallery：借鉴与修改点

### 4.1 上游现有路径

`new-work` 先判断视觉权威：

1. 已有成熟视觉语言：继承。
2. 品牌不完整：保留明确承诺并扩展。
3. 全新视觉世界或明确 redesign：建立新方向。
4. 既有页面的局部扩展：不重新发起品牌/方向竞赛。

对新世界，它要求从受众真实文化与场景推导多个方向，再经 `concept-seed` 分配方向和外部 catalog challengers，并按受众认同、产品清晰度判断。通过 HTML decision page 展示各方向、风险、色板、材料、首屏概念，允许 steer/re-roll/选择常规路径。[new-work][new-work]

对既有世界的新整页，它保留视觉语言，探索结构差异。上游也支持每张卡展示生成图、首屏 HTML sketch 或 wireframe。选择后保存页面方向 contract；comp-led 路径进一步形成构图样稿。[new-work][new-work]、[serve-question 实现][question-engine]

`visualize` 固定要求 **3 个**同一已选视觉世界下的构图选项，锁定 palette、字体方向、材质、组件、影像及动效语法。它把“视觉身份探索”与“同一身份内的构图探索”分开。[visualize][visualize]

### 4.2 为什么不能原样接上游来满足 3–5 张快速 concept

- 新世界的方向卡数量由上游判断胜出/竞争/淘汰决定，文本明确不按用户指定数量补齐。
- 已选方向的 visualize 轮固定为 3 个构图，不是 3–5 个品牌/设计方向。
- 上游完整 comp-led build 还有后续测量、素材、组件审阅、页面实现、responsive 和 finish review；快速 concept gallery 不应该自动进入这些阶段。
- `shape` 是规划命令：生成确认 brief 后停止；它不会为本 pack 自动建立完整需求、概念与选择的永久档案。
- 上游设有每阶段的交互/批准，直接拼接可能把“少量问题快速看方案”变成多轮采访和审批。

来源：[new-work][new-work]、[visualize][visualize]、[shape][shape]。

### 4.3 推荐 graph：concept-sprint（新增 pack 流程）

以下是适配建议，不是上游现成功能：

```text
需求输入
  → 上下文扫描 / 已有品牌与产品事实
  → 2–3 个关键问题（只问影响方向的缺口）
  → brief.confirmed + constraints
  → 生成 3–5 个有实质差异的 concept briefs
  → 快速可行性 / 事实 / 多样性评审
  → 生成 3–5 张静态设计预览图
  → 单 HTML gallery + 概念简介 + 比较要点
  → 用户选定或反馈
  → concept.selected + decision record
```

建议默认 **3 张、可指定 4 或 5 张**，每张对应一个明确方向。初稿数量不足时补足有效方向；不要用换颜色或改字体伪装成不同 concept。命中完全相同需求时使用同一内容集、相同 viewport、相同目标页面及相当完成度，方便比较。

每个 concept 至少包含：

- 稳定 ID、名称、一句话主张；
- 受众/目标与为何适合；
- 核心视觉或交互构想、palette、type direction、imagery；
- 预览图路径、生成 prompt、使用的参考、局限/风险；
- 实现可行性和对跨页面语言的推演；
- briefVersion、brandVersion、status。

gallery 是评选界面：显示大图、简介、对比和选择；不让用户在首轮阅读内部 skill/engine 细节。图片是设计概念的预览，交互与数据真实性需在后续设计规格中明确。gallery 的选择必须存入 pack 自己的 decision record。

实现策略：借鉴 new-work 的“已知世界/新世界分流”、方向差异和 visualize 的固定世界规则；实现独立 `concept-sprint` adapter，不把原始 Impeccable `new-work` 直接当整个 pack 的顶层 system prompt。用户的 3–5 张 gallery 要求优先。

## 5. 从 concept 到完整网页设计图，再到代码

### 5.1 两种交付必须分清

用户要求的“完整网页设计图”可以是完整长页视觉稿和响应式视图，**无需自动进入代码交付**。建议 graph 显式提供输出类型：

- `design-only`：页面设计规格、完整页面设计图、关键响应式图、关键状态图。
- `implementation`：在用户要求实现时才进入代码、连接真实数据、测试与发布准备。

对 design-only 的建议路径：

```text
selected concept + 补充内容
  → 内容与证据盘点
  → sitemap / page outline / 用户路径
  → 锁定 shared design language
  → 页面区块和组件规格
  → 完整桌面页面设计图
  → 手机构图 / 关键状态
  → Design Director + Creative Director 分工评审
  → 设计交付包
```

重要整合点：各页面从同一 concept contract 与视觉系统推导，不是每页重新随机生成一个方向。真实文案、定价、证明材料不足时保留占位/未决项，不能从生成图反推新业务事实。这借鉴了 PRODUCT.md 和视觉世界分离原则。[init][init]、[new-work][new-work]

### 5.2 上游 comp → code 确实有运行时门控

当用户要求把高保真 comp 实现成页面，上游不是只说“看图写代码”。`build-phase` 在磁盘记录状态；comp-spec 建立区域与几何、font-match 估测字体、plates 阶段生成资产、hero 阶段对比首屏、后续测响应式与评审。comp-diff 产出 side-by-side、heatmap、区域报告等证据。生成图带 prompt sidecar；批准的图有 `approved` 标记。[new-work][new-work]、[visualize][visualize]、[engine map][engine]

因此它可作为高保真营销页实现的可选 adapter，但不宜把它的像素门控和多次素材生成预算带到每个小改动。上游本身把 Operate/Read 设为 code-led；app screens 不应拿整张生成图片作为交互布局的唯一权威。[init][init]、[new-work][new-work]

### 5.3 资产溯源值得保留

上游对生成图嵌入准确 prompt；外部/既有素材记录 origin；comp 的 crop 是生产资产的参考，不能拿概念图切片直接假装所有真实 UI。最终应有 assets manifest，保留生成来源、参考、授权信息和实际用途。[visualize][visualize]、[asset producer][asset-agent]

## 6. SaaS 与 BE 协作：用它守住语言，用新增契约守住行为

### 6.1 推荐 graph：saas-feature-design

```text
需求 + 已有产品 / 品牌 / 组件系统
  → UX task / domain / role-permission 建模
  → 与 BE 对齐 data + API + errors + async lifecycle
  → screen & state matrix
  → 基于已有组件/semantic tokens 的设计
  → 典型、空、加载、失败、无权限、极值数据预览
  → 交互 prototype / FE 实现（如果本次范围包含）
  → UX critique + technical audit
  → 聚焦修复
  → 交付 / 更新批准的设计记录
```

可直接复用的上游能力：

- Operate 模式的共同控件、信息密度、稳定颜色含义和任务反馈。
- `polish` 的分类：缺 token、重复实现、概念不一致、局部缺陷，按最小正确层级修复；完整路径优先于局部美化。
- `harden` 的 network/API errors、validation、permissions、rate limit、concurrency、i18n、RTL、极端文本和数据。
- `adapt` 的多设备适配；`clarify` 的错误恢复与控件文案。
- `document/extract` 的系统记录与重复模式抽取。

来源：[operate][operate]、[polish][polish]、[harden][harden]、[adapt][adapt]、[document][document]。

### 6.2 必须新增的 BE 交付契约

上游没有定义一个完整的后端协作协议。以下为 pack 建议：

- `domain-contract`：实体、业务状态、状态迁移、术语、边界。
- `api-contract`：字段、nullability、pagination/filter/sort、错误结构、version。
- `permission-matrix`：角色 × 操作 × 对象状态。
- `state-matrix`：screen × loading/empty/error/success/permission/offline/long-content。
- `interaction-contract`：提交、保存、乐观更新、撤销、重复点击、轮询/实时更新、冲突处理。
- 真实 API sample / fixtures，关联 screen state 与验收条件。
- design-system version、组件映射和变更记录。

Design Director 对用户路径和行为一致性负责；Creative Director 对品牌表达负责；BE 负责人对真实数据/状态与 API 契约负责。Head of Design 处理跨域冲突与设计系统破坏性变更。这里的“report to”不等于每张图都需要三个审批人。

## 7. Interview HTML：现成问题页与需求档案是两回事

**已核实：Impeccable 有 HTML decision page，但没有满足本需求的通用持久 interview 系统。**

`serve-question` 的典型 payload 是 title、question、options、steer、reroll、buildPath、canonCard 等。options 可包含 hero/board/comp、HTML sketch 或 wireframe；用户返回 `optionId`、`steer`、comp/html、buildPath 等。它针对设计选择轮，不是任意问卷字段、表单分支、访谈纪要与需求版本系统。[问题页引擎][question-engine]

尤其关键：

- 回复写入 `.impeccable/questions/<key>.answer.json`。
- `--wait` 读取并打印 ANSWER 后，**删除该 answer 文件**。
- 问题目录自动忽略 Git；回答、选项轮、seed 等被定义为 local runtime state。
- 成功选择后部分状态/hand/generated 目录会清理；它们不应当被当作持久需求档案。

这些行为直接由 Rust 实现可见。[serve-question，回答消费与清理][question-engine]

**建议新增 interview-capture graph：**

```text
任务类型
  → 选择 2–3 题快速模板 / 可选深入模板
  → 单 HTML interview
  → answers 原始记录
  → 解析为需求事实、约束、偏好、未决项
  → 给用户确认摘要
  → versioned brief / requirements
  → 路由 concept / brand / web / SaaS graph
```

原始答案应保存为 `interviews/<id>/answers.json`，包含 questionId、原题、答案、时间、问卷版本；派生需求记录 sourceAnswerIds、inferred/confirmed、confidence/openDecision。修改答案时追加新版本，不把旧答案覆盖成“从来如此”。

静态 HTML 可以使用 localStorage 暂存并导出 JSON，但 localStorage 不等于已写回 repo。若需要自动记录，提供一个明确的本地 collector API，将回复写入指定工作目录并回传 receipt。重开页面、刷新、服务器重启后应能恢复草稿；导出 JSON 是可携带备份。这些都是新增功能，不是上游已经保障的能力。

## 8. QA 的分工与结论强度

### 8.1 critique 与 audit 不重复

- `critique` 做 UX/设计判断和排序；web 路径要求独立的设计评估 A 与 detector/browser evidence B，避免先看到检测结果后只围绕 lint 问题判断。不能并行隔离时需要披露 degraded；native 平台另走 A-only。
- `audit` 检查可验证的技术维度：a11y、performance、theming、responsive 等，产生报告，不直接修复。
- `polish` 才按优先级执行修复。
- finish reviewer 给出 `recapture / rebuild / fix / ship` disposition；缺失/无效截图先补证据，不能用文字计划给页面通过。
- 上游明确指出 detector 结果不是设计质量证明。源码扫描只覆盖 pattern rules；对比度等需要 rendered URL。对 native source 扫 web detector 得到空结果不代表合格。

来源：[critique][critique]、[audit][audit]、[polish][polish]、[finish reviewer][review-agent]、[README][readme]。

### 8.2 pack 推荐的有限闭环

评审输入应包括 briefVersion、selected concept、design-system version、screenshots、状态覆盖与未验证项。QA 不得修改原始需求以通过检查；设计系统维护者也不应将偶然缺陷写成新规范。

建议 concept-sprint 只做一次方案质量筛选与一次图像检查；正式交付做完整检查、批量修复、复核，并用明确预算终止。无需把 heavyweight comp-fidelity 和多轮专家评审强加给每个简单请求。

## 9. 与 taste-skill 组合时的冲突

本节 taste 证据来自同批研究固定提交 `12af471f627f866411b4bd785b19646d3672784c`，对应仓库 2.1.5。直接集成前以 companion research 的逐条来源为准。

| 问题 | Impeccable 已核实规则 | Taste 同批源码核查发现 | pack 建议 |
|---|---|---|---|
| 全局入口 | 单 skill 路由新建、调节、评审、实现 | 也是完整路由体系 | 一个 pack router；各能力按节点加载 |
| 页面/应用分流 | 四种访客 mode，Operate 强调精确与克制 | page 与 app 分流，app 无 page motion floor | 合并为统一 surfaceMode，并显式排除不适用规则 |
| 动效强度 | 按模式、任务和可用性选择；避免散乱效果 | page 有 8 个实际 motion 元素底线，16 以下 warning；app 主要任务反馈 | motion budget 由 brief/mode/可访问性决定，不用统一数量当质量 |
| 图像数量 | 根据 comp 和内容所需生成真实资产 | page 至少 4 张真实图片 | 不把图片数量作为所有页面通用门槛 |
| 品牌颜色 | brief/明确品牌承诺优先，允许对饱和模式作有理由选择 | 紫/靛限制含作者品味判断，提供 allow/ignore 机制 | 原有品牌 token 优先，禁止风格偏好重写品牌 |
| 硬 ban | craft-floor 将 eyebrow/kicker 设绝对禁用，其他条款既有模式/宿主条件 | page 也禁 eyebrow，但 app 可小标签 | 将审美偏好与可访问性/业务约束拆开 |
| 版本差异 | 当前源为 4.8.0，不能把旧版说明混入 | 当前单 skill 已不同于旧版多 dials 结构 | 固定 SHA，记录 adapter 修改和规则来源 |

Impeccable 来源：[模式与 brief 优先][skill]、[craft-floor][floor]、[new-work 字体和视觉校准][new-work]、[Operate][operate]。Taste 入口：[固定提交仓库](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c)。

**建议规则优先级：** 已确认需求和品牌承诺 → 平台/可访问性与真实业务约束 → 已批准设计系统 → 页面 mode → 专项 craft guidance → 可选 taste profile。来自上游的“风格禁令”应记录为来源规则；不应悄悄升级成组织永久政策。

还要注意 Impeccable 自身存在需要上下文化的 guidance：例如 harden 的泛化流式字体建议，与 Operate 的固定 rem 字阶需按 mode 解释。导入全文而没有路由，容易产生内部矛盾。[harden][harden]、[operate][operate]

## 10. 运行时、跨平台、网络与隔离更新

### 10.1 哪些只是方法，哪些需要工具

| 层 | 依赖与边界 | 是否适合第一版直接带入 |
|---|---|---|
| 设计方法文本 | Skill/reference，由宿主模型读取；本身不生成图、不截图、不写文件 | 适合按节点改编 |
| 跨宿主分发 | Bun/Node 构建器与 transformer，替换 paths/frontmatter/provider tags、生成 agent/hook manifests | 借鉴架构；本 pack 不必携带所有宿主产物 |
| 本地 runtime | 单个 Rust 编译的 engine；已发布二进制不需要 Rust/Node | 可选 adapter |
| npm CLI 安装入口 | `npx` 需要 Node；随后调用同一个 engine | 可选安装方式，不是 Markdown 方法必需 |
| 从源码构建 | Rust toolchain/Cargo；分发构建有 Bun/Node；WASM/browser bundle 有额外构建工具 | 维护 upstream fork 时才需要 |
| 文件检测 | engine 执行；源码文本规则不需 LLM API | 可选自动 QA |
| URL/render 检测 | engine + 可发现 Chrome/Edge + 能访问目标页面 | 高价值但必须按执行环境验证 |
| image generation | 宿主 image tool 优先，或 API fallback；需要对应服务能力 | 概念图工作流必须另声明此 capability |
| live variants | 本地 checkout、dev server、框架适配和浏览器 | 后续实现迭代，快速静态图 gallery 无需它 |
| question/gallery | 上游 Rust 本地 server；pack 可自建轻量静态 gallery + collector | 建议与 runtime 解耦 |

来源：[README][readme]、[engine map][engine]、[package scripts/dependencies][package]、[Windows launcher][windows]、[provider transformer][providers]。

Windows 有 `impeccable.cmd`，查找明确的本地 binary / 缓存，最后可下载版本固定的 release 资产，并按旁边 checksum manifest 校验。**技能执行不等于纯本地无网络**；第一次启动可能下载 binary。当前主机“安装的 skill 版本”也不能代表研究固定提交的版本。[Windows launcher][windows]

### 10.2 网络依赖要有事实边界

概念 seed 可从本地 catalog 或 `impeccable.style` 服务读取方向；源码会调用 `/roll`，目录图片另取自 cards endpoint。服务不可用时存在 degraded 逻辑。README 明确声明关闭 telemetry 不会取消获取方向的请求，只关闭匿名方向展示/选择记录。[concept-seed][seed]、[README][readme]

因此：

- GitHub 固定 SHA 不会自动固定远端 catalog 的内容与可用性。
- catalog 图片作为灵感参考，不等于 pack 拥有其完整再分发或商业素材使用权。
- 上游网站与服务位于另外的 private repo；开源 engine 不是服务端及其内容的完整离线镜像。
- 首版 pack 的 concept graph 可只依赖本地 brief + 宿主 imagegen；外部 catalog 设为可选增强，不作为必经网络节点。

来源：[concept-seed][seed]、[仓库结构说明][repo-guidelines]。最后一条为建议。

### 10.3 宿主支持必须以实现核对

`docs/HARNESSES.md` 自称 point-in-time；其表格部分与当前 provider 配置存在更新差异。例如实际 providers.js 具有 Cursor 和 GitHub 的 agent emission 配置，而文档的 native subagent emission 表较窄。不能直接复制其支持矩阵作为本 pack 的运行保证。[harness notes][harnesses]、[providers.js][providers]

建议 pack 维护 capability manifest，而不是只看宿主名称：

```text
images.generate
browser.capture
files.persist
questions.collect
subagents.spawn
server.local
design.detect
figma.write
```

graph 声明 required/optional capabilities 和真实 fallback；没有 imagegen 时，不能声称交付了用户要求的静态概念图。不存在浏览器截图时，不能把技术检查通过描述成完成视觉验证。

### 10.4 测试体系与不应过度宣称的内容

已读取测试与 CI 配置，仓库存在：

- Rust workspace tests，Linux/Windows jobs；
- CLI observable behavior oracle；
- provider build/manifest 路径测试；
- live framework E2E；
- 需要 API key 的 LLM skill behavior/workflow tests；
- 新建、初始化、方向确认、refinement 保留边界、finish documentation 等行为断言。

需要 provider key 或 binary 的测试会条件跳过；某些 LLM/browser 测试为 opt-in 或 schedule/workflow_dispatch。**测试存在不表示本次已运行，也不表示当前所有平台路径都已验证。** 本研究只读测试定义，没有执行。[CI][ci]、[full-build workflow tests][workflow-tests]、[finish-handoff tests][finish-tests]、[package scripts][package]。

### 10.5 推荐的隔离与更新方式

建议目录概念：

```text
sources.lock.json
third-party/impeccable/        # 固定 SHA 的上游只读材料/许可
adapters/impeccable/           # 自己的graph-node适配
roles/                        # 自己的职责与写入边界
workflows/                    # 自己的graph与验收
schemas/                      # brief/concept/decision/system/handoff
runtime/                      # 自己的gallery与interview collector
tests/contracts/              # 适配器产物与graph行为
```

不在本次研究创建这些实现。更新建议：

1. 固定 upstream repo、SHA、source paths、license、engine version、可选网络能力。
2. 上游材料与定制角色/graph 分开；避免直接编辑 generated provider 目录。
3. upstream 更新先 diff 方法与契约，不自动覆盖本地角色、品牌、需求和产物。
4. 只回归受影响 graph：3–5 图 gallery、选定方向保持、interview 答案持久化、SaaS 状态一致性。
5. runtime adapter 与 prompt adapter 分版本，可先升级方法而不自动升级引擎或安装 hooks。

## 11. 许可与归属

该固定提交使用 **Apache-2.0**；README 说明起源于 Anthropic frontend-design；NOTICE.md 说明 iOS/Android reference 从 ehmo/platform-design-skills 的 MIT 内容提炼。复用时保留适用 license、版权与 notices，对改编文件标明来源与修改；不要把上游作者名/品牌当成自有 pack 的背书。字体、图片、远端 catalog 等第三方内容需单独记录其来源和适用条件，不因主仓库许可证而自动视为同一授权。[LICENSE][license]、[NOTICE][notice]、[README][readme]

本报告是工程整合依据，未对第三方每个资产逐一执行权利审计。

## 12. 对 agentic-creative-team-pack 的优先建议

1. **先定义产物契约，再装 skills。** 最小共享集合是 confirmed brief、brand core、concept set、selected concept、design-system version、screen/state matrix、review、decision log。
2. **快速路径与正式交付分开。** concept-sprint 交付 3–5 张图 + 一个 gallery；full-page-design 产出设计稿；implementation 是下一条可选 graph。
3. **用 Impeccable 做方法与质量层。** 保留页面 mode、世界/构图分离、设计语言持久化和有证据的评审；完整 engine 作为可选 adapter。
4. **补上真正 Brand Strategy / Identity。** 上游 visual-world workshop 提供表现方向，不能替代定位研究、品牌主张、命名、Logo/VI、品牌架构及应用规范。
5. **补上 interview 与 BE 契约。** 上游 question state 是临时交互，不是需求库；harden 检查错误情形，不是 API 设计协定。
6. **总监是质量责任边界，不是每步都运行的审批节点。** 让执行 graph 按任务派员，跨域冲突再升至 Head of Design。
7. **只保留一个路由与规则优先级。** designer-skills 提供领域覆盖，taste-skill 提供可选风格/创意约束，Impeccable 提供 craft、系统与 QA；最终决策必须归 pack 自己。

## 固定源码索引

以下链接全部指向同一研究提交，Taste 比较链接除外。

[readme]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/README.md
[package]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/package.json
[engine-version]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/ENGINE_VERSION
[repo-guidelines]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/AGENTS.md
[skill]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/SKILL.src.md
[init]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/init.md
[shape]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/shape.md
[new-work]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/new-work.md
[visualize]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/visualize.md
[document]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/document.md
[operate]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/operate.md
[commands]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/scripts/command-metadata.json
[generate]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/generate.md
[asset-agent]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/agents/impeccable-asset-producer.md
[review-agent]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/agents/impeccable-finish-reviewer.md
[doc-agent]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/agents/impeccable-documenter.md
[edit-agent]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/agents/impeccable-manual-edit-applier.md
[question-engine]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/crates/context/src/serve_question.rs
[polish]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/polish.md
[harden]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/harden.md
[adapt]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/adapt.md
[critique]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/critique.md
[audit]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/audit.md
[floor]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/reference/craft-floor.md
[engine]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/docs/ENGINE.md
[windows]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/skill/scripts/impeccable.cmd
[providers]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/scripts/lib/transformers/providers.js
[seed]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/crates/context/src/concept_seed.rs
[harnesses]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/docs/HARNESSES.md
[ci]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/.github/workflows/ci.yml
[workflow-tests]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/tests/skill-workflow/full-build.test.mjs
[finish-tests]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/tests/skill-workflow/finish-handoff.test.mjs
[license]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/LICENSE
[notice]: https://github.com/pbakaus/impeccable/blob/02523aec3e4c4580102d996d1b6a71fbe062e03f/NOTICE.md
