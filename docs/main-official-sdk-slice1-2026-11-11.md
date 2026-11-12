# S1 官方 SDK：首片实施证据（2026-11-11）

## 状态与边界

**S1/S2 已交付本片有限结果，Sol 独立复核接受，R1/R2 已关闭。** 最终包含 S2 的候选通过构建、模拟 RPC、同一官方 Host 的 upgrade、manifest、health 和真实 worker settings/catalog 检查；独立 focused 13/13 通过。首次部署的时间戳缓存碰撞失败及修正见下文，不抹去失败历史。S3、S4 未实施；V1 只做静态预检，真实生命周期和错误身份测试未运行，不能发布或合并。未提交、merge 或 push。本片不修改 Core 状态、migration、Packs 或历史分析。独立审查见 [Sol 报告](main-official-sdk-slice1-review-2026-11-11.md)，S2 行为边界见 [Windows 写入报告](main-windows-atomic-slice1-2026-11-11.md)。

Graph `e8c3e5f01c5b1cb4dfd8509e099328c2630f778f`，分支 `salvage-plan`；Packs 主 checkout 和 Graph 相邻构建输入均为干净的 `6ad0652828b3075b72e457e2afa1b0807dcd929e`。先前将构建 import 路径误按工作目录而非 `scripts/` 解释，已更正：实际是 `../Paperclip-PolyForge-Graph-Packs`。这次输入一致不等于 S3 的显式来源、双 root 隔离已实现。

## 官方证据及变更

- `npm install --ignore-scripts --save-exact @paperclipai/plugin-sdk@2026.1106.0`，registry `https://registry.npmjs.org/`。npm registry 元数据与 lock 一致：SDK tarball `https://registry.npmjs.org/@paperclipai/plugin-sdk/-/plugin-sdk-2026.1106.0.tgz`，integrity `sha512-dmRBcyEIsqKAxBfrqwVGNxnARCwsGCt2bhrch49E0jhGzo0wwn501W9B3YADggSTSbm81FxMu8/G9z/jDrNeKA==`；其精确依赖 shared `2026.1106.0`，tarball `https://registry.npmjs.org/@paperclipai/shared/-/shared-2026.1106.0.tgz`，integrity `sha512-fleBeHYbmnwdvEuzyQ4ABUFbHzqft47ni/ZktF1jWQsFkyfHmHBz5xFm3nfD3WZQ9UGnVZmXfEhfk+nizpeGEQ==`。`npm ls` 确认实际嵌套解析；未声称验签。
- 三个 Compose 固定 `ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da`。主代理对本地目标 pin 做 image inspect，报告 digest/ID 匹配、构建 commit `d69631b01b9c658f80bf8bed389863dce82643e1`、工作目录 `/app`、ENTRYPOINT `["/usr/bin/tini","-s","--","docker-entrypoint.sh"]`、CMD `["node","server/dist-runtime/index.mjs"]`。`compose.real.yml` 保留官方入口，先在其下复制凭据、`umask 077`，再 exec 此官方 CMD。官方入口和命令已在隔离实例启动；凭据复制另用假凭据检查，不等于 authenticated Compose 或真实 Codex 登录通过。
- `minimumHostVersion` 最初按计划误设为 `0.3.1`，独立审查 R1 指出这放宽了 main 原有兼容下界；现修正为 `2026.1106.0`。目标 SDK 导出的 `PLUGIN_CAPABILITIES` 包含 manifest 全部 41 项。主代理实际启动目标镜像后 `/api/health` 返回 `status=ok`、`version=2026.1106.0`、`serverVersion=2026.1106.0` 和目标 commit；镜像内 `/app/server/package.json` 为 `0.3.1`。固定官方 commit 的 `server/src/app.ts:1011` 将 `opts.hostVersion ?? serverVersion` 传给 loader，`server/src/services/plugin-loader.ts:1164,1324–1332` 读取并比较该值，`server/src/version.ts:201–210` 优先解析 `PAPERCLIP_BUILD_VERSION`，`server/src/index.ts` 未覆盖 hostVersion。因此该镜像的 loader 比较版本是 `2026.1106.0`，不是 package.json 的 `0.3.1`；这纠正原计划第 34、40 行的假设。Compose 完整 image pin 锁定本次 Host。此前主代理的 `serverVersion===0.3.1` smoke 断言失败是错误假设，并非 Host 启动失败。固定 release 的 [Dockerfile](https://github.com/paperclipai/paperclip/blob/d69631b01b9c658f80bf8bed389863dce82643e1/Dockerfile) 和 [entrypoint](https://github.com/paperclipai/paperclip/blob/d69631b01b9c658f80bf8bed389863dce82643e1/scripts/docker-entrypoint.sh) 提供启动行为源码证据；Context7 返回 master 文档，不能当作目标发行版证明。RPC smoke 使用 `plugin_worker_smoke`，保留超时及 stderr；尚未完成全部实际 Host API 行为逐项验证。
- `scripts/build.mjs` 对 manifest 也 bundle 包依赖，避免 manifest 的 `semver` 依赖开发机；worker 原本已 bundle，trusted adapter 为独立构建文件。SDK 的 UI bridge 仍由 Host 作为 UI 外部依赖提供，不能将 UI 描述为自包含。
- 独立审查 R2 的 README 当前部署版本与 bootstrap CLI 已同步至目标版本。只读 `npm view paperclipai@2026.1106.0` 确认该版本与 tarball `https://registry.npmjs.org/paperclipai/-/paperclipai-2026.1106.0.tgz` 存在，integrity `sha512-jcZrSB5DItxeDJGO7TccI0WcYca2IbBJxpbaKZN6kZp+isNIbVF2AgmfFQq394mjXD+TTHwS5P3AT6jjpqXbng==`；未下载或运行该 CLI，真实 bootstrap 尚未验证。

## 基线库存和范围

- manifest 相对于 Graph 基线的源码 diff 只有 Host 门槛；9 个 route 为 `GET /settings`、`GET /issues/:issueId/graph`、`GET /graph`、`POST /issues/:issueId/graph`、`GET /company`、`POST /company`、`GET /channels`、`GET /channels/deliveries`、`POST /channels`；公开工具 `graph-command`、`company-command`，工具参数 schema、capabilities 和 managed agent 默认配置未修改。完整 schema/capability 基线可直接取固定 Graph 的 `src/plugin/manifest.mjs`，与候选唯一差异为门槛。没有声称线上 API 全部经行为验证。
- 固定 Packs 的图：ADLC `0.3.2` 包含 `request-triage@0.2.0`、`product-discovery@0.2.0`、`implementation@0.1.6`、`verification@0.1.6`、`release-process@0.1.0`、`release-observation@0.1.0`、`production-monitoring@0.1.0`、`requirements-baseline@0.1.0`、`product-experiment@0.1.0`、`competitive-watch@0.1.0`、`system-architecture@0.1.0`、`code-delivery@0.1.0`、`technical-design@0.1.0`、`design-drift@0.1.0`；Marketing `0.0.4` 的 `acquisition-plan@0.0.1`、`outcome-review@0.0.1`；Creative `0.3.1` 的 `creative-intake`、`brand-foundation`、`concept-sprint`、`concept-to-web-design`、`saas-feature-design`、`design-system-evolution`、`design-assurance`、`brand-campaign-assets`、`minor-ui-change`、`product-design-discovery`、`ui-candidate-sprint`、`ui-prototype-experiment`、`brand-architecture-naming`、`logo-concept-design`、`brand-identity-kit`、`brand-asset-adoption`、`brand-guidelines`、`brand-packaging-brief`、`brand-rollout-plan`，均 `0.1.0`。
- 三包角色/技能分别为 10/32、3/3、14/26；完整键与内容基线是上述固定 Packs 的 `index.mjs` 导出各 pack 的 `roles`、`skills`，不依赖 mutable latest。隔离 manifest 已逐键与这一基线比较；另有固定 CEO 角色，共 28 agents、61 skills。
- migrations 仅 `001_graph_state.sql` 至 `015_pack_runtime_validation.sql`，基线完整列表及内容以固定 Graph `migrations/` 为准；本片无该目录差异，没有引入 016–019。产品 manifest 显式指定 `codex_local` 和偏好，fixture 环境才指定 `process`；不将此等同于官方普通 Agent 的默认值。旧 `scripts/e2e.mjs` 已按具体 heartbeat ID 读取；`scripts/inspect-acceptance.mjs` 是列表统计，需注意官方上限，不能视为完整历史统计。`scripts/e2e-real.mjs` 等的 codex 断言针对显式配置的 real-codex 验证，不是全平台默认行为证明。

## 验证记录与部署前提

| 层次 | 本片证据 |
|---|---|
| Focused | 原始及纠正后各一次 `node --test tests/core/official-sdk-pairing.test.mjs`，各 2 passed、0 failed；纠正后以 semver 比较确认目标版本满足、`2026.1023.0`、`2026.1022.0`、`0.3.1` 不满足。测试在 `npm test` 的 glob 中；未运行全套。S2 单独测试结果见其报告，纠正后未重跑 S2。 |
| 构建/RPC | 原始及纠正后各一次 `npm run build` 成功；末尾 RPC 15 秒内初始化成功。纠正后构建包含 S2 的 check-runner 源码。Node `v25.2.1`，不是镜像内 Node；RPC 模拟 Host 回包，不是 Host 安装。 |
| 最小包级 | 以下是**修正前 S1 包** SHA-256 `2f93eb7aa9f0e6098295e29564b3233fb3b4061c6fa806d2c7a31df76ef8f112` 的检查：解压到 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s1-b6449440e25c4c9fa59666a320ac85e4/package`，无项目 node_modules，显式 sidecar 下 manifest 完整角色/技能键与固定 Packs 匹配，adapter `adlc@0.3.2` / `creative-team@0.3.1` 可加载，复制 smoke 驱动后 worker RPC 成功。未验证 worker catalog force reload 或完整 adapter digest。 |
| 修正后候选 | `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-s1-s2-corrected-de59090ce87148f7811c17af239df2cf/pohlee-paperclip-polyforge-graph-0.8.7.tgz`，SHA-256 `c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa`；包含修正的门槛及 S2 构建产物，已解压并经同一官方 Host 的实际 upgrade 与 worker catalog 验证，部署条件见下节。 |
| 官方 Host | 首次 health smoke 中 Host 启动成功，但驱动错误断言 `serverVersion===0.3.1`，该次检查失败且实例已清理。修正驱动为日期版本及固定 commit 后，在第二个隔离实例中 health、真实插件安装及 worker settings API 检查通过，详见下节。未删除失败历史，也未将其记作通过。 |
| V1 / 完整回归 | 未运行，不能算通过。本实施代理未创建 Docker 容器、数据库；上述 Host 检查由主代理执行，未用模型。 |
| 独立复核 | Sol 对纠正后的 S1 和 S2 执行一次合并 focused，13 passed / 0 failed / 0 skipped；代码审查接受，R1/R2 关闭。实际 Host 操作为主代理执行，Sol 读取最终成功 JSON 与驱动，不冒充独立重跑。 |

### 主代理：最终 S1+S2 候选的同实例升级

1. 独立核对最终 tarball 的完整 SHA-256；与旧包的文件路径清单相同，部署至同一个实际安装路径，保留明确的外部 Packs sidecar。没有使用开发源码或 node_modules，也没有另开数据库。
2. 首次按保留时间戳方式解压后，官方 `POST /api/plugins/pohlee.polyforge-graph/upgrade` 返回 ready，但 manifest 门槛仍为旧值 `0.3.1`；驱动严格要求新值而失败。新进程 import 磁盘 bundle 则得到 `2026.1106.0`，因此没有把旧 metadata 当作新候选通过。
3. 两个 npm tarball 的 manifest 时间戳均为 `1985-10-26T08:15:00Z`；固定官方 `plugin-loader.ts:1350–1360` 以路径加整毫秒 mtime 为 import 缓存键。部署保留相同时间戳导致缓存碰撞，与上述新进程／Host 差异一致。
4. 使用 `tar -xmf <final.tgz> -C <installed-root> --strip-components=1`，**不恢复 tar 内旧时间戳**。manifest 的字节 SHA-256 前后相同，仅部署 mtime 更新；候选 tarball 的 SHA-256 仍是上述 `c24895df…001c1fa`。未修改官方 Host、版本或验收断言。
5. 在同一实例重复同一个官方 upgrade 检查，通过：ready、插件 `0.8.7`、实际 manifest 门槛 `2026.1106.0`；28 agents、61 skills 逐键匹配；真实 worker settings 返回三包正确版本；plugin health 三项均通过。执行证据为 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-host-20261111-upgrade.json`，含完整候选摘要。Sol 已只读核验该 JSON。

**部署前提**：对同一路径替换本地 tarball，须使 manifest 的部署 mtime 更新（例如上述 `tar -m`），并通过官方接口核验实际加载的 manifest/catalog；仅见 upgrade 返回 ready 不足以证明刷新。该操作不改变 artifact 字节或 digest，不是新的插件加载框架。这里测试的是未发布的同版本候选替换，不宣称正式版本升级或生产迁移已验收；发布前仍须按计划选择未使用版本。

另一次不启动数据库的假凭据检查使用同镜像官方 entrypoint、相同 `sh -ec` 复制路径和 tmpfs：以 UID 1000 复制成功、内容一致。Windows bind 源经过 `cp` 后 mode 为 `0700`，并非先验假设的 `0600`；最初 exact-mode 断言失败。主代理据既有 bootstrap 的 owner-private 契约改为检查 owner 可读写且 group/other 无访问后通过，未改产品代码。这个检查不证明真实凭据有效、CLI bootstrap、完整 authenticated Compose 或重启通过；没有将 owner execute 位扩展为本轮新产品修复。

全部验证结束后，主代理通过明确命名的容器执行 graceful stop；该实例带 `--rm`，容器及 tmpfs 数据已清理，按本任务前缀检查无残留容器，未删除已有实例、卷或用户工作。

### 主代理：修正前 S1 候选的官方 Host 贯通检查

- 将修正前 `2f93eb7a…` tarball 解压至 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-installed-20261111`。此目录只有包内容与显式部署的 `polyforge.runtime.json`，不含开发源码或 node_modules；sidecar 指向容器内 `/opt/polyforge/packs/index.mjs`。此节所有结果均仅适用于该旧包，不适用于修正后候选。
- 候选目录与固定主 Packs 分别只读挂载。唯一命名实例 `polyforge-salvage-s1-host-20261111` 使用上述精确官方镜像、原 ENTRYPOINT/CMD，`--network none`，无对外端口，`HOST=127.0.0.1`、`PAPERCLIP_BIND=loopback`、`local_trusted`，关闭 heartbeat 调度。数据库和状态位于容量 512 MiB 的 `/paperclip` tmpfs，`/tmp` 上限 128 MiB；不是已有开发实例或旧数据。
- 官方 startup recovery 日志触发一次 health 请求，无 sleep／轮询：`status=ok`、`serverVersion=2026.1106.0`、commit `d69631b01b9c658f80bf8bed389863dce82643e1`。
- 官方 `POST /api/plugins/install` 对实际解压目录返回 `ready`、插件版本 `0.8.7`。官方 plugin health 的 registry、manifest、status 检查均通过；另将 Host 保存的 manifest 角色与技能逐键同固定 Packs 导出比对，结果为 28 agents、61 skills，一致。
- 创建一个无 Agent 的可丢弃 company，真实调用 `GET /api/plugins/pohlee.polyforge-graph/api/settings?companyId=…` 成功；此调用进入真实 worker，catalog 完整返回 `adlc@0.3.2`、`marketing@0.0.4`、`creative-team@0.3.1`，与固定输入一致。
- 临时检查驱动为 `C:/Users/pohle/AppData/Local/Temp/opencode/polyforge-salvage-s1-host-20261111.mjs`，命令为 `node <driver> prepare <isolated-package-dir> <pinned-packs-dir>`，然后 `node <driver> install`。该驱动只用于本片验证，不是产品接口或新加载框架。
- 边界：未运行 Graph、Process Agent、模型、完整回归、force reload、升级后配置重供或全部公开 API；未验证 `compose.real.yml` 真实用户凭据复制。本次完整性仅覆盖指定 tarball 和显式可信挂载，不声称 S4 自包含。

S4 未完成：安装包不是 Pack catalog 自包含。部署者须将固定 Packs 只读挂载至例如 `/opt/polyforge/packs`，在**实际安装包根目录**提供不在 tarball 中的 `polyforge.runtime.json`，例如 `{"packEntries":["/opt/polyforge/packs/index.mjs"]}`；升级/重新安装后须重新提供并验证该配置和挂载。本片已证明显式 sidecar 在真实安装路径可供 manifest/worker 使用，并在保留 sidecar 的同路径升级后仍有效；未验证删除后重供、重装及所有权限组合。现有 Compose 的环境变量及源码挂载本身不足以替代这些验证。manifest 捕获 catalog 错误会退化为仅 CEO，故仅检查非空不能验收。

## V1 静态预检

旧 `scripts/e2e.mjs` 要求的 `ui-ux-design` 不在固定 catalog，不能原样用于 V1。`adlc/request-triage@0.2.0` 仅候选：需要 `source_request`，`assess-request` 由 product-owner 执行并由 cpo review，产出 `triage_report`、`request_brief` 和符合 `triage-report` 的 payload；`triage-disposition` 可选 ready、needs-info 或 closed。旧 fixture 的通用 submit 缺对应 payload，decision 节点列表也不包括该图；需要先核验真实 validator、decision 和可追溯输入，再适配隔离 fixture，不能伪造事实或放宽规则。未证明任何终态可达，也未执行错误 Agent/run 身份拒绝及合法重试测试。

## 资源与待办

本片约用 30 分钟，低于约定 60 分钟上限；交付固定为 S1/S2，余下 S3/S4/V1 待新有限切片，不自动扩展。安装前 C 盘约 62 GiB、D 盘约 315 GiB 可用，均高于 10 GiB 门槛。结束时可见文件：node_modules 47,593,187 bytes、dist 7,960,199 bytes、作者旧包及隔离目录 9,550,357 bytes、最终 tarball 目录 1,535,289 bytes、主代理解压部署目录 8,017,977 bytes。npm 缓存按 09:00 后修改文件计量为 17 文件／24,296,890 bytes（含可能的其他任务，非精确归因，不记为零）；可见文件总量约 99 MB，另有小型日志/报告。已有镜像未 pull；Docker data/docker 前后均 20439796 KiB，数据盘约 902 GiB 空余。两个 Host 的 tmpfs 各有 512+128 MiB 上限，先后使用，均已清理；没有创建完整源码快照。

本目标数据库创建 **2/2** 额度已用尽：首次错误版本断言后销毁，第二次用于安装及同实例最终候选 upgrade 后销毁；换切片不重置，后续 V1 若需新 DB 必须额外授权。S1 作者原始实现与一次审查纠正分别 focused/构建通过，已消耗该路线两轮，不自动第三轮；S2 作者一轮 focused 通过。部署 mtime 问题一轮方法修正后同一 upgrade 检查通过；无完整回归开始。未发现已证实的数据损坏或 Core 不变量问题，这不是安全审计。后续最小步骤为 S3 单一构建 root，再 S4 catalog/artifact；V1、正式版本选择与合并门槛保持未完成。
