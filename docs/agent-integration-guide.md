# Jev agent 接入指南（未安装到宿主）

本指南可供支持 skills 的宿主改写为工作流，也可直接供其他 agent 阅读。它不是技术强制边界，不会替用户登记设备或授权付费。

1. 先查看本机 `doctor` 与 `policy status`，核对身份、构建、模式和范围。当前主流程仅支持 `standard` 合成 fixture。真实网站/手机任务不要伪装成合成输入。
2. 用 CLI 或本地 MCP 的同一协调服务，按 `schemas --json` 提交严格字段。不得通过普通工具参数改变 provider、预算或身份，也不直接请求 hosted API。
3. 新目标固定 goal_id 和 idempotency_key。成功以本地后验和账本的 SUCCEEDED 为准，不以 HTTP 200 或模型选中候选为准。
4. BUSY 时等待或按用户要求取消。网络中断先 status；同一请求保留同一键。UNKNOWN 停止并报告不确定结果，不能换键重做可能已发生的动作。
5. FALLBACK、拒绝、低置信度、过期和网关离线都不代表自动获准改用原生控制工具。本阶段没有正式 approved_fallback route。
6. 用户要求停止时立即使用本地 cancel 或操作员 stop，不等待远程决策。只关闭自己有权管理的会话，不声称已经撤销物理动作。
7. 报告目标、状态、实际 route、已验证结果与限制；不把 key、token、真实正文或截图塞进摘要。本地 target/params 由执行器绑定，中央只看合成白名单投影。

操作员负责安装配置、登记/续期/撤销、预算审批和宿主工具隔离。若宿主仍开放等价 shell/CUA/浏览器通道，报告 advisory-only；安装本指南不等于消除了绕过路径。
