# 集中式服务阶段归档

2026-11-04 改为每主机独立部署。此目录保留早期 CLI/MCP、relay、准入、continuation 和公网 Mac 桥的设计与操作经验。它们是历史资料，不能用其中的 URL/路径/命令连接当前版本；相应服务源码与部署模板已移除。

保留的经验包括：同条件入口对照、TLS 连接复用、心跳宽限、稳定 owner、UNKNOWN 不重放、持久人工开关、凭据逐请求读取、实例 fencing，以及模型选择与物理后验分离。集中服务所需的连接管理不再进入各主机的产品流程。

- [原 CLI/MCP](cross-machine-cli-mcp.md) · [运维](cross-machine-operations.md)
- [网络协议](network-mcp.md) · [准入管理](manual-admission.md)
- [公网 Mac 桥](mac-public-automation.md) · [其他 AI 旧手册](other-ai-real-testing.md)
- [公网快速开始](public-service-quickstart.md) · [服务器部署](server-deployment.md) · [早期 MCP](mcp.md)

原始结果继续在 docs/reports 和 artifacts，未重算、覆盖或删除。当前 API 见[本机快速开始](../../quickstart-agent.md)。
