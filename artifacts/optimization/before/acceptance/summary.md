# Jev P0 离线验收报告

**结论：交接包 S0–S5 离线 P0 通过。S6 真实 API 测试尚未执行。**

最终执行状态、时间与退出码见 [checks.json](checks.json)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 类型检查 | passed | [日志](typecheck.log) |
| 代码检查 | passed | [日志](lint.log) |
| 单元与核心测试 | 55/55 | [日志](unit.log) |
| 集成测试 | 7/7 | [日志](integration.log) |
| 安全测试 | 38/38 | [日志](safety.log) |
| CLI 帮助与命令 | passed | [日志](cli-help.log) |
| 完整 mock 基准 | 240/240 | [报告](../mock/summary.md) |
| 异步专项回归 | 40/40 | [报告](../async-regression/summary.md) |
| 依赖审计 | 0 个已知漏洞 | [审计文件](dependency-audit.json) |

核心安全用例同时包含在单元与安全测试命令中，不能将各项相加当作独立用例数。最终验收没有 failed、blocked、skipped、cancelled 或 todo。要求与测试的对应关系见 [验收索引](../../docs/acceptance.md)。

## 交付内容

TypeScript 源码、固定依赖与锁文件、本地中英文模拟页面、六类动作、持久化幂等账本、租约与 fencing、独立验证器、mock 与默认关闭的 Jev adapter、私有 IPC coordinator、CLI 和 MCP stdio 接口。

两个真实 SDK 客户端测试覆盖身份隔离、显式共享权限下的 BUSY/取消、UNKNOWN 查询及禁止重放。启动方式见 [README](../../README.md) 与 [MCP/CLI 配置](../../docs/mcp.md)。未配置任何第三方 agent 全局设置。

## 修复与保留证据

首轮完整基准为 234/240，六个异步场景在执行前最终校验时发生页面变化，被保守记录为 UNKNOWN。首轮失败行完整保留在 [mock-first-run](../mock-first-run/summary.md)。

修复后，只有执行器明确证明物理动作尚未开始的拒绝才记录 REJECTED，并在原有预算内重新观察，最多两次。真正的超时、崩溃及结果不明仍为 UNKNOWN，隔离且不重放。专项与最终完整基准通过，最终正常任务 UNKNOWN=0。

后续复跑还捕获了一个时钟边界问题：两次取时会偶发形成 2001 毫秒的快照有效期，严格检查因此回退。该轮 239/240 的结果保留在 [时钟回归前报告](../mock-second-regression/summary.md)。确定性测试稳定复现 2001 与 2000 的差异；已改为同一次取时生成两个时间字段，没有放宽有效期限制。

独立审查还推动修复了实际重定向越界、页面状态及输入属性检查、取消/关闭竞态和服务清理问题，均有回归测试。基准异常会刷新为失败报告并保留已启动任务，不能留下旧的成功结果。故障测试故意制造的 UNKNOWN 在临时账本中验证隔离行为后清理，不表示可以重放。

## 环境与边界

实际机器是 Mac mini Apple M4、16 GB、macOS 27.0.1，与交接包假设的 M4 Pro 64 GB 不同。具体 Node、Chromium、依赖锁 hash、seed 和模式见 [基准 manifest](../mock/manifest.json)。本次代码集合指纹与产物扫描结果见 [验收 manifest](manifest.json)。

初始目录没有 Git 仓库；未创建远程、提交、合并或部署。没有申请辅助功能或屏幕录制权限。

coordinator 异常退出后的残留 socket/服务锁需人工核验后清理并保留账本，不会绕过活进程锁。底层账本可对已确认死亡的 PID 安全恢复。真实网站、原生 macOS 应用、图像/Box、上传下载、付款和删除均未执行。

## 真实 API 状态

**not-run：真实 Jev、真实主 agent 付费基线，以及真实加速或降本结论。** 所有 provider 结果来自 mock 或合成 HTTP 响应测试。未读取机器已有 API key，没有计费请求；零 mock 费用不是对真实费用的测量。

下一步按 [S6 准备](../../docs/live-testing.md)，确认仅发送合成数据、请求/费用上限、测试窗口和密钥的本机安全注入方式。不要在聊天或源码中粘贴密钥。
