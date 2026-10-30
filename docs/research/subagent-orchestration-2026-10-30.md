# Sub-agent 编排研究笔记（2026-10-30）

## 项目结论

建议默认让主 Agent 在同一 loop 执行；仅当任务边界可分、独立结果有用，或上下文/权限隔离本身是目标时才委派。继续把 Shadow 作为独立评审契约，不折叠为作者自检。若用户希望普遍 Agent 委派能力，应另行讨论并区分 **Delegated Task** 与 **Review Shadow**：前者完成边界清晰的工作，后者以独立上下文核验候选。组织角色/审批职责与执行 session 是不同层次，可保留领域团队责任，同时集中把关跨任务质量。

## 来源事实

### 何时折叠 sub-agent（Anthropic，2026-10-22）

Claude Platform 实践建议：上下文共享、步骤紧密耦合时优先单 Agent 配按需 skills/tools；仅在上下文膨胀、并行新上下文、工具/指令冲突等可辨需求下保留子 Agent。一个客户案例约快 2 倍，但未公开可复现数据。文章建议用端到端任务评估比较架构、重复运行并追查翻转案例；并行适合独立工作或黑盒验证。 [原文](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)

### 多 Agent 研究系统（Anthropic，2025-06-13）

Anthropic 报告特定研究评估中，Opus 4 lead + Sonnet 4 子 Agent 比单个 Opus 4 高 90.2%；复杂查询时间最多下降 90%。研究工作负载重并行且多方向独立，不能外推至紧耦合编码。多 Agent 平均用 token 约为普通聊天的 15 倍（并非单 Agent 的 15 倍）；文章未给出足以独立复现的完整评估数据。 [原文](https://www.anthropic.com/research/multi-agent-research-system)

## 对项目的判断与建议

以下均为结合来源和本项目实现得出的建议，而非来源对 Paperclip 的实证结论。

- **内联主 loop**：共享状态的连续推理、强耦合编码、共用数据或频繁改动边界的工作。只有接口稳定的组件、独立研究路线或黑盒验证才考虑并行委派。
- **独立评审**：保留新 session 评审，让其只接触筛选后的目标、需求及版本化候选证据，绑定候选 ID/版本/digest；不向评审者传入作者的对话或自评。新 session 只隔离对话上下文，不能推导为不同 Agent、模型或 OS 沙箱。
- **上下文与 fork**：当前 `sessions.create` 建立新 session，而非 fork，适合明确交接且需排除父对话的 Review Shadow。两篇文章没有直接比较 fresh session 与 fork；此判断来自任务语义。委派包需显式给目标、约束、输出 schema、证据/来源和持久产物引用。
- **策略与权限**：当前公司默认关闭 Shadow；触发、同 Agent、Graph 绑定、预算、超时和并发槽位均受策略约束。此类硬门槛应留在确定性宿主控制中。当前 Agent 工具及文件权限仍由配置/宿主控制，Shadow 不是安全沙箱。
- **未来写任务**：当前只读评审边界不构成未来扩展禁令。若 Delegated Task 获得写权限，须额外定义工作区隔离、并发冲突与合并、外部副作用审批/idempotency、超时后的重试/恢复语义；不可直接复用只读 Shadow 契约。
- **评估**：用同一任务集比较内联与委派，多次运行，关注任务完成度、误接受/误拒绝、证据和候选绑定、延迟、token/预算及中断恢复；不要只测委派路由是否正确。

项目依据：[Shadow 设计与恢复记录](../shadow-runtime-2026-10-30.md)、[shadow-runtime.mjs](../../src/plugin/shadow-runtime.mjs)、[shadow-context.mjs](../../src/plugin/shadow-context.mjs)、[shadow-launch-lifecycle.mjs](../../src/plugin/shadow-launch-lifecycle.mjs)。

## 来源限制与待讨论问题

两篇文章都是 Anthropic 对自身产品和实践的回顾。2025 年数字来自特定内部研究任务和模型组合；2026 年企业案例匿名且缺少样本与原始数据。来源没有评估 Paperclip Shadow，也没有比较 session fork 与新 session。现有 Shadow 验收记录使用 deterministic process Agent 验证编排和恢复，未包含真实模型的 Shadow 验证，实际评审质量仍未验证。

1. 是否需要通用 Delegated Task；首个可委派任务应具有怎样的边界和输出？
2. 关键评审是否要求不同 Agent、模型或供应商来增强独立性？
3. 扩展前的质量、误接受率、延迟和预算门槛是什么？
4. 哪些产物需要持久化供审阅或恢复使用？
5. 哪些中断可自动续跑，哪些应失败关闭或进入人工修复？
