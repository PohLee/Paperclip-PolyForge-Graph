# S2 Windows 原子 manifest 写入：首片证据

## 实施

局部参考 `da74478405e72277d17ea755e0a47eb0a70fffce`，`git show --stat` 确认参考提交仅改 `src/host/check-runner.mjs` 和 `tests/core/check-runner.test.mjs`；当前 main 的两个替换点与参考适配。未 cherry-pick 或提交。

修改上述两个文件：save 和 acknowledge 共用 `writeJsonAtomically`；先写同目录 UUID 临时文件，rename 为唯一提交点，仅 Windows 的 `EPERM` / `EACCES` 按 10、20、40、80、160 ms 等待后重试，最多六次 rename；其他错误立即传播，耗尽时传播原始错误。finally 只尝试清理本次临时文件；清理失败不掩盖原始错误，也不撤销已成功的 rename，故不能保证在文件系统拒绝清理时临时文件消失。没有引入文件锁、跨进程 CAS 或防止业务丢失更新的保证。

## 验证

一次 `node --test tests/core/check-runner.test.mjs`：**11 passed，0 failed，0 skipped**，Node v25.2.1，Windows。新增测试注入 platform、rename 和等待函数：同时覆盖模拟 EPERM/EACCES 瞬时冲突后真实 rename、完整旧 JSON 保留至提交、六次耗尽及五次延迟、非 Windows 和非目标错误立即失败、保留其他写入方临时文件以及本次文件正常清理；另以真实 save 和 acknowledge 验证完整 JSON、ack 字段和无残留临时文件，并检查清理失败不掩盖写入错误或成功提交。没有模拟并发读者压力或证明业务层并发一致性；Windows 分享冲突为注入模拟，不是实际文件句柄重现。

作者只有一次实现修改后 focused 验证；无失败及修复重跑，无完整回归、Docker、数据库或下载。该 S2 源码变更**不包含在之前的 S1 tarball 中**，此前 S1 安装结果不证明 S2 或 V1 已通过。

## 后续构建及独立复核

S1 审查纠正后的构建已包含 S2。最终 tarball SHA-256 为 `c24895df0ae22ccfb591162ceb0eb5923b0ec860ad5e97576686c68fb001c1fa`；主代理在同一官方 Host 上完成该包的 upgrade、manifest 与真实 worker catalog 检查，部署时间戳前提见 [S1 证据](main-official-sdk-slice1-2026-11-11.md)。这不等同真实文件句柄争用测试。

Sol 独立审查 S2 代码后无阻断缺陷，合并 S1 聚焦测试 **13/13 通过**；S2 有限接受。未宣称跨进程 CAS、并发业务事务保证、真实共享锁重现或 V1 完成。详见 [独立审查](main-official-sdk-slice1-review-2026-11-11.md)。
