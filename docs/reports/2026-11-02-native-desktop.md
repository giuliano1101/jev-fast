# 原生 App 能力与 Windows 接入核查

日期：2026-11-02，亚洲/上海。此报告区分已实测功能、已部署修复与尚未上线的代码。

## 实际交付范围

新增独立原生桌面 MCP：Mac 使用 AppKit / AX / CoreGraphics / ScreenCaptureKit；Windows 可选后端使用系统 PowerShell / UI Automation / Win32。工具覆盖 App 启动、文档打开、窗口与控件回读、截图、点击、Unicode 输入、按键、赋值、滚动、拖拽及原生控件动作。没有 App 白名单、模型付费次数、费用或任务步骤配额。

本轮用户后续明确要求保留当前 private profile、Key、账本和既有 Windows 连接，不切换设备、不重启 relay。因此原 `/tmp/jev-501` coordinator、connector 及 relay 进程均未重启，公共 profile 没有增加 desktop 或 Windows host。Mac 本地 AI 可按[原生手册](../native-desktop.md)启动原生 MCP，结合既有公网 `jev.choose_action` 使用。真实验收采用独立 HostService + 原生 MCP + 原有真实 Jev coordinator 接线；没有启动替代 mock，也不代表公网已经注册 desktop host。

## 真实 Mac 题目及结果

| 题目 | 执行与独立验证 | 结果 |
| --- | --- | --- |
| 系统计算器 `37 × 19` | Jev 从真实 AX 按钮候选选出清除、3、7、乘、1、9、等于；回读显示 703 | 两轮均通过，各 7 次真实 Jev 决策 |
| 原生窗口截图 | 截取计算器窗口，核对真实 PNG、460 × 816 和 scale=2 | 首轮崩溃；修复命令行 AppKit 初始化后通过 |
| TextEdit 原生赋值并保存 | 新建专属临时文本，AX 赋值中文后 Cmd+S，独立读文件逐字比对 | 83 字节完全一致 |
| TextEdit 原生键盘输入并保存 | 新建另一个专属空文件，用真实键盘事件输入中文、勾号、emoji 后 Cmd+S，独立读文件 | 45 字节完全一致 |

合计 20 次真实 Jev 调用均返回已执行，并用既有公钥独立验证了 20 份决策签名；模型为 `jev-1.14.0`；输入 9,864、输出 618 tokens。按现有 usage-only 计量单价，已知费用为 **$0.000414288**，不是新额度或成本上限。截图及原始 AX 状态只保存在私有本地目录，公共[脱敏证据](../../artifacts/native-desktop/mac-live.json)包含题目、阶段耗时、用量、失败及复测结果。

这些是小样本能力验收，不是对全部 App 的成功率保证，也不是 Windows 实体电脑验收。滚动、拖拽、所有应用自定义控件还不能据此宣称完成跨应用稳定性测试。

## Windows 两个连接与原请求

用户指定 `64d7b3b2`（Windows Codex）和 `b4dbbc71`（Windows executor）。两者均曾由操作员接口开启；没有清理或 release 这两个连接。

只读查询原请求 `c9ec927c-2c46-42d8-9557-3f35cfa89b6a-decision`：

- `COMPLETED`，`reply.ok=true`。
- `jev.choose_action` 已产生真实 `jev-1.14.0` 签名决策，`selected_id=open`。
- 输入 478、输出 24 tokens。
- 没有重放。这个结果证明决策已产生，不证明 Windows 本地 App 已执行成功。

持续核查发现原设备 3 秒心跳阈值会被真实网络抖动触发，撤销 AI owner，连接重新变为 pending。重新开启旧连接不会恢复已撤销的 continuation；因此不能把某一瞬间的 enabled=true 写成已稳定保持开启。最后核查状态保存在[脱敏连接证据](../../artifacts/native-desktop/windows-connections.json)。Windows 端应保留原编号，从新的独立测试开始；旧请求决策已完成，不能重放。

## 已部署的故障修复

公网 Nginx 仍残留 `client_max_body_size 65536`，而现有 Node 协议保护已为 16 MiB。连接器账本有一份约 73.6 KB 的 Android 回传结果，旧代理无法接收，导致结果交付和后续心跳被阻断。

已将专用 vhost 的请求保护同步为 16 MiB，`nginx -t` 通过后仅 reload Nginx。原 coordinator PID 85892、connector PID 85895 未改变；原 profile、Key、账本及 relay 未重启。之后独立公网核验 `enabled/connector_online/local_ready=true`，`host_tools(android)` 返回 COMPLETED 和 33 个真实工具。初次恢复时的一次未完成核验及后续成功核验均保留在[恢复证据](../../artifacts/native-desktop/windows-recovery.json)。

## 已完成、尚未切换线上进程的稳定性改进

原 connector 每次轮询都新建 TLS 连接，增加握手开销。新增其专属 keep-alive Agent，不重试不确定业务动作；退出只销毁自己拥有的连接。回归测试先观察到 5 次心跳需要 6 条 TLS 连接，修复后注册加 5 次心跳共用 1 条已验证 TLS 连接。

private relay 配置现可显式传入既有 `leaseMs`，建议有真实网络抖动的部署使用 30 秒设备心跳宽限。它不改变模型额度、AI 会话 TTL 或任务时限；本轮未改线上配置或默认值。部署这些代码需要操作员允许的进程升级窗口。当前用户明确禁止 relay 重启，故没有为了上线而破坏正在使用的 continuation。

## 代码检查与边界

独立规格及质量审查修复了：缺失焦点的误放行、未确认窗口时发送输入、父进程死亡后继续发键、关闭时鼠标/按键未释放、观察树永久累积、Windows 同名进程路径误匹配、键盘自身改变焦点导致错误失败、新弹窗遮住旧坐标等问题。

保留基于实际观察的目标检查、每台物理主机的输入顺序、用户手动关闭、OS 权限事实、UNKNOWN 与禁止盲目重放。它们用于防止误操作，不是 App 允许列表或费用配额。Windows CI 只做编译、协议、合成引用与释放清理验证，实体 Windows 的实际交互仍由 Windows 端安装后验收。

最终完整检查与 CI 结果见本报告末尾的验证记录。

验证记录（本机最终源码检查）：

- `npm run typecheck`、`npm run lint`：通过。
- `npm test`：514/514；`npm run test:integration`：110/110；`npm run test:safety`：40/40。
- Mac 原生编译/只读协议、焦点/生命周期/协作释放：7/7。
- Python 部署检查：16/16。
- 独立最终审查：通过；额外聚焦桌面/主机/配置检查 22/22。

Windows runner 已实际编译 C# 并运行合成输入释放检查。其协议 CI 定位到 .NET Framework stdin writer 自动 BOM 与 JSON 首行解码兼容问题；已加入精确 UTF-8、单 BOM、双 BOM、后续畸形行恢复回归。[最终 Windows CI 已通过](https://github.com/giuliano1101/jev-fast/actions/runs/41359322371)，验证提交为 `91ec4e9`；不把它等同于实体桌面交互。
