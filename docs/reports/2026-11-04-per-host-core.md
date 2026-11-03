# 2026-11-04 · 每主机执行核心与服务拆除

按用户要求移除项目的 CLI/MCP 服务，改为各主机独立布置 Jev。随后用户明确确认，同时停用旧公网 MCP、中继和本机连接器。本轮没有请求模型 Key，没有改付费策略、重置额度或清理历史账本。

## 删除与保留

| 范围 | 结果 |
| --- | --- |
| 产品 CLI、stdio/网络 MCP、relay/connector、准入、公网 Mac 桥 | 删除源码、启动脚本、部署模板及专属传输测试 |
| 原生桌面 MCP 外壳、Windows 本机浏览器 MCP / 公共决策连接器 | 删除外壳；改为 DesktopExecutor 与本机 DecisionPort |
| 浏览器、Mac Swift、Windows PowerShell、安卓 HostService 客户端 | 保留执行器与 grounding / 后验 / journal |
| Jev 决策、签名验证、模型网关、usage-only、私有配置 | 保留；模型网关不是已删除的业务 MCP 服务 |
| 本机控制台 | 保留单页开关，直接调用生命周期函数，不再派生 CLI 或显示集中式准入 |
| 幂等、UNKNOWN、人工开关、profile 匹配与 proven-dead 恢复 | 保留；删除网络 owner dispatch 外部接线 |
| 混合执行、教师规则、历史题库/结果/失败与优化经验 | 保留；旧手册归档并明确不是当前接入方式 |

本地入口 `src/index.ts` 导出生命周期、DesktopExecutor、LocalBrowserService、HostService、真实浏览器与决策配置 API。构建清理旧的 dist/src、tests、bench、fixtures，避免已删除的入口仍留在旧编译目录；单独编译的 native 二进制保留。安装/维护命令不等于对 AI 发布业务 CLI；第三方 MCP 客户端库仍用于驱动官方浏览器/安卓后端。

## 部署停用

实际检查旧公网 `/mcp`、`/connector/register`、`/connector/sync`、`/health` 均返回 HTTP 410。Jev 专用 Nginx 配置验证通过后重载，其他站点和 HTTPS 证书保留。服务器 jev-network 与 jev-mac-public 两项 systemd 服务均 inactive / disabled；未删除服务器数据或证书。

Mac 已停用自动准入、公网 Mac 桥和公网反向隧道的 launchd 任务；旧连接器与旧 relay 管理隧道停止。先从旧 watchdog 排除 connector/tunnel，保留本机网关/控制台恢复，避免停完被自动重新拉起。

本机随后部署了不含 CLI/MCP 的执行库快照，新控制台通过库调用；原 watchdog 改为私有本地库恢复程序，采用原网关/协调器，不再调用旧 CLI，不恢复 relay/connector。实际面板检查为 running / Jev；旧产品 CLI/MCP/连接器进程均不存在。

停用时核对原协调器与模型网关仍是原 PID；原 Android 配置保留。Key 与原 profile 文件做私有校验，未改写。历史 ledgers/journals 未删除或重置；运行历史不上传 Git。旧公网 continuation 不再可用，任何未决请求不得在新主机换键重放。

第一版包含整体关闭共享 watchdog 的停用脚本被自动审批拒绝，未执行；随后改为仅移除旧连接器/隧道恢复任务，保留本地服务的方案并完成停用。

## 回归方法

先新增库导出、原生直调与旧 dist 残留回归，观察预期失败后实现。保留并迁移原生命周期、持久 off、启动恢复、profile 冲突、CDP/现有浏览器、原生驱动与控制台的行为测试；删除的测试对应不再存在的产品传输层，不是降低执行成功判定。

| 检查 | 结果 |
| --- | --- |
| typecheck / lint | 通过 |
| 单元（含 core 安全） | 458 / 458 通过 |
| 集成 | 87 通过 / 0 失败 / 1 可选 headed 跳过 |
| 安全套件 | 40 / 40 通过 |
| 原生驱动离线检查 | 8 / 8 通过 |
| 独立范围与代码质量审查 | 通过；Windows POSIX 文档问题已修正 |

完整机器可读结果见[同名 JSON](2026-11-04-per-host-core.json)。离线测试不调用付费 API；本轮不宣称新增真实网站/GUI 或实体 Windows 成功率。Windows headed 题仍按 opt-in 规则在本机跳过，runner 验证不替代用户实体 Windows。

## 使用与迁移

平台边界：DesktopExecutor、LocalBrowserService 和宿主 DecisionPort 可用于 Windows；现有生命周期/profile loader/Unix socket 仍依赖 POSIX uid/mode，仅适用于 macOS / Unix。Windows 使用自己的既有 Jev 宿主注入 DecisionPort。本轮未实现 Windows 凭据/协调器移植，不将 Mac 的通过结果当作 Windows 完整服务安装验收。

各主机导入本地模块：[快速开始](../quickstart-agent.md)、[AI 集成](../agent-integration-guide.md)、[本机浏览器](../local-browser.md)、[原生桌面](../native-desktop.md)、[本地控制台](../control-panel.md)。旧 MCP URL 和 stdio 配置不可继续用于新版，不另起兼容公网或 mock 服务。

直接 DesktopExecutor 只提交原生动作；宿主需要组合本机 Jev、持久 journal 和实际后验。LocalBrowserService 接受本机 DecisionPort；各主机自行验证浏览器登录态和 OS 权限，不再借服务 Mac 的无头窗口冒充 Windows 本机执行。

历史对照、题目和优化索引见[验收与经验](../acceptance.md)。保留原结果，不据不同样本数量比较新旧成功率，也不把删掉网络开销当作已经测出的端到端加速。
