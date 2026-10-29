# 分阶段开发任务

按依赖推进，不承诺未经验证的工期。下列路径是未来工程建议；当前仓库只有 Markdown。后续 Codex 应先阅读仓库 AGENTS.md 和适用的 `.agents/skills`，不安装技能包来替代理解本契约。

## 拟议工程布局

```text
src/core/            goal 状态机与共享 schema
src/session/         租约、fencing、幂等账本
src/browser/         隔离浏览器与候选编译
src/policy/          allowlist、数据最小化与批准检查
src/providers/       mock 与默认关闭的 Jev adapter
src/verification/    独立后置条件与 no-op 检测
src/mcp/             MCP 薄壳
src/cli/             CLI 薄壳
fixtures/            本地中英模拟页面与任务
tests/               单元、集成、故障与契约测试
bench/               测量、对照与报告生成
artifacts/           脱敏运行结果；默认不提交原始轨迹
```

## S0 环境与设计冻结

负责人角色：后续实施 Codex；需用户决定的授权交给用户。

任务：确认目标确为 Mac mini M4 Pro 64GB、工作目录及仓库；只读检查 OS、架构、Node、浏览器可用性；读取工程约束。复核官方 API、运行时要求、价格、许可及 SDK 重试行为，选择最小依赖与固定版本。列出拟安装依赖及用途，按当时授权执行，不自动申请 Accessibility 或屏幕录制权限。

产物：`docs/environment.md`、`docs/decisions.md`、依赖及锁文件计划、固定验收任务清单。阶段门：确认 isolated browser 可用且不会读取用户 profile；没有 API key 也能继续 S1–S5。当前没有实现，无启动命令可直接运行。

## S1 离线 fixture 与基线支架

依赖 S0。建立本地服务和独立临时 browser context；拦截除该 fixture origin 外的所有浏览器请求、重定向及弹窗。fixture 支持 reset、seed、可查询的模拟提交计数和事件序列。生成中英任务、隐藏重复按钮、异步更新、验证错误、返回和取消场景。

实现确定性 scripted baseline 与 mock provider，用于工程回归，不将其命名为真实 LLM 基线。记录观察/决策/执行/验证耗时，建立运行 manifest 与成功 oracle。

产物：可离线运行的 fixture、任务 JSON、seed、baseline JSONL、网络阻断证据。门：无 key、无外网时 happy path 和 reset 可重复。

## S2 核心安全状态机

依赖 S1。优先实现 Snapshot/Candidate schema、策略过滤、租约/fencing、持久幂等账本与取消；再接入执行器。实现状态过期拒绝、执行后验证、UNKNOWN 隔离、no-op 和预算控制。不要先做自由点击再补安全层。

产物：单元测试、状态转换表、故障注入集成测试、双客户端并发测试。门：安全测试全部通过，重复 action、旧 epoch、过期 snapshot、越界候选不能触发动作；崩溃重启不重复模拟提交。

## S3 Mock provider 与可选 live adapter

依赖 S2。mock 可脚本化返回正确、低置信、非法、延迟、429/529 与超时结果。实现 Jev adapter 的请求/响应契约测试，但只使用录制的脱敏合成响应或本地 HTTP fake；不请求官方服务。typed Choice 是完整动作候选的单选。

产物：provider 接口、默认 mock 配置、live 双重开关（明确授权记录及安全 key 注入缺一不可）、网络 payload 脱敏测试、预算拒绝测试。门：live 未授权时即使机器已有 key 也不能发送；禁用自动探测 API key 或发送健康检查。

## S4 MCP 与 CLI 接入

依赖 S3。实现薄壳并复用同一 core，不复制安全逻辑。两个可控 MCP 测试客户端分别以独立身份连接，一个 browser session 下争用同一目标，验证 BUSY、取消、租约隔离及状态查询。CLI 输出机器可读结果和简短人类摘要。

产物：工具 schema、错误码、最小 client 连接说明、两客户端测试报告。门：跨客户 session 访问被拒绝；工具不暴露任意脚本或绕过 gate 的入口。若实际 agent 不支持本工具，记录兼容性限制，不声称接入成功。

## S5 离线 P0 验收

依赖 S4。执行 [测试验收](04-tests-and-acceptance.md) 的全部离线项目；复核日志/提交无 secret。落地并验证拟议命令 `npm run test`、`npm run test:integration`、`npm run test:safety`、`npm run bench:mock`；若选用其他工具链，更新所有文档与 handoff，不能留下不可用命令。

产物：测试摘要、运行 manifest、脱敏 JSONL、benchmark CSV、已知限制、回滚说明。门：明确区分 passed/failed/blocked/not-run；不能用 mock 指标宣称 Jev 提升。此处是默认停止点。

## S6 可选真实 Jev 对照实验

仅在用户后续明确授权后启动；S5 通过不是授权。开始前取得：允许发送的合成数据范围、模型与 API 账户、费用上限及币种、请求上限、测试窗口、密钥的安全输入方式，以及主 agent 基线所需模型的额外授权。缺一则保持 blocked，不索要聊天明文密钥。

先只对合成 fixture 测试，不自动扩大到真实网站。冻结模型版本、阈值、任务和基线策略；跑中英校准集后锁参数，再用独立测试集配对 A/B。所有请求预估成本计入保守预算，额度不足先停止，超时和重试不算免费；记录 usage 并与账户实际费用核对可得部分。

产物：真实与 mock 分开的报告、全部失败、费用与预算差异、建议是否继续。门：没有安全违规，结果能复现，不虚构加速；负结果可以通过“实验已完成”门，但不能通过“值得推广”门。

## P1 另行立项

只有 P0 证据支持且用户授权后才评估 native macOS AX；单独设计进程边界、Accessibility 授权、前台焦点、窗口切换、不可逆动作和退出恢复。截图/Box、真实业务、更多并发会话不自动包含在 P1 授权内。

## 停止与恢复

发现密钥泄漏、策略绕过、双执行、未知真实副作用或超预算迹象，立即停止新动作，保留脱敏证据，报告目标/动作/原因/状态。禁止通过放宽 allowlist、关闭 TLS、绕过权限或换执行器来“修复”验收失败。恢复须先修复并重跑相关安全用例，未知副作用需先核实。
