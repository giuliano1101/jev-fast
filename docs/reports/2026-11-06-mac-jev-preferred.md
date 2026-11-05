# 2026-11-06 · Mac 更新与 Jev 优先设置

按用户要求，Mac 正式安装与工作区已拉取主分支 `254b48103ce659f15b5bf7c1422a247f4dc2f984` 的官方直连执行器，再将默认使用规则调整为 Jev 优先。未合并旧服务阶段的独立 Windows/Cursor 分支，未恢复已退役公网 MCP、CLI、中继或网关入口。

## 本轮继承的工具

- 官方 `createJevRuntime().choose()` 与 `ask()`：动作选择、同状态下多个 Choice/Noul 判断。
- 原生 `openDesktopSession` / NativeAdapter：日常登录态 Chrome、Mac App、14 项原生方法与窗口观察。
- `openBrowserSession` / BrowserWorkflow：独立本机 Chrome、导航与前进/后退、标签页、滚动、控件消歧、填写、选择、勾选、提交、下载事件与文件核验。
- JevSession：观察、选择、新鲜重绑、持久幂等、一次派发、独立后验和阶段计时。
- UsageLedger / TestBudget 与既有混合模块：逐请求计量、明确测试额度、经验证的流程经验；没有复用历史活动额度或新增全局封顶。
- Codex 安装器：渲染本机路径、备份原文件、安装 skill、更新单个全局托管块。

## Jev 优先的准确含义

支持且就绪、能由有限候选和独立后验表达的本机 GUI 任务优先走 Jev，同一路径优先用于观察/准备/核验。用户明确指定的工具优先于默认偏好；确定性连接器、API/文件读写和编码继续使用对应工具。

Jev 不支持、不可用或确认派发前失败，且没有未决效果时，可在原授权范围使用 Computer Use/专用工具等后备路径，记录原因、真实执行器及结果。UNKNOWN、派发未确认、未决输入和遗留锁仍禁止新输入或跨工具重放。走 Jev 的请求不静默改模型，不把其他工具的结果冒称 Jev。

该偏好已同时写入项目 AGENTS、可移植全局准则模板、skill、默认提示和 API/集成说明。Mac 使用规范安装目录，不将隔离开发工作区作为另一个物理主机安装；未改模型或 MCP 配置。

## 本机安装与验证

安装 `direct/` 依赖，构建 TypeScript 与最新 Swift helper；安装 `jev-direct` skill 并在本机 Codex 全局 AGENTS 中更新一个托管块。原 Superpowers/其他用户准则完整保留，路径占位符全部渲染；重复安装验证内容不变、托管块仍只有一个。

复用本机已授权的私有 TypeSafe Key，原文件未改；新模块规定的私有路径仅在不存在时初始化，不覆盖既有文件。未读取到聊天/参数/日志，未向用户索取 Key。旧 profile、运行账本和服务进程未因本次更新删除或重置。direct 模块独立记录后续官方直连用量，不将旧账本或保守预留伪装成新模块的实际消费。

| 检查 | 结果 |
| --- | --- |
| build / typecheck / lint | 通过 |
| 单元测试 | 120 / 120 通过 |
| 集成测试 | 4 / 4 通过 |
| 安全测试 | 4 / 4 通过 |
| Mac 原生离线协议/窗口匹配 | 8 / 8 通过 |
| 正式安装目录的 native status | macOS，accessibility=true，screen_capture=true，14 项方法 |
| 全局规则安装与幂等 | 原规则保留，1 个托管块，路径渲染通过 |
| 本轮付费模型请求 / UI 输入 | 0 / 0 |

Swift 编译保留既有 NSWorkspace.fullPath 弃用警告，未造成构建失败。未将 Windows 源码、离线替身或历史 Chrome 基准当作本次实体 Windows / 付费模型验收。本次只读状态证明权限与模块可用，没有声称模型认证、所有站点操作或端到端成功率已重新实测。

当前会话已接收到更新后的全局规则；其他已有会话如仍显示旧规则，可重载/新开以读取最新准则。[Codex 官方 AGENTS 说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

[快速开始](../quickstart-agent.md) · [本机集成](../agent-integration-guide.md) · [Jev skill](../../skills/jev-direct/SKILL.md) · [网页工作流](../../skills/jev-direct/references/browser-workflows.md)
