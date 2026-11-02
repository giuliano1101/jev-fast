# 心跳稳定性维护与重新接入验收

2026-11-02，亚洲/上海。用户已明确批准现在维护，并由 Windows 随后建立新的独立连接。

## 已上线

- 原 Mac 网络连接器加载 `0267559` 的专属 TLS keep-alive Agent，复用已验证的连接，不重放不确定业务请求。
- relay 配置显式设为 `leaseMs: 30000`，将设备心跳宽限由 3 秒调整为 30 秒；`autoAdmitAi: true`、`allowContinuations: true`、`sessionTtlMs: null` 保持原值。
- relay 和连接器各进行一次维护重启。本机 coordinator 与 Jev 网关进程未重启；原 Mac private profile、模型 Key 和原 connector 配置指纹均相同。
- TLS Key / 证书未更换，usage-only 不变，历史账本未重置或改写；两次新模型验收正常追加计量记录。没有新增 desktop 或 Windows host，原 `android` 保留。
- 统一控制台继续使用原页面和地址。约 343 KB 的历史连接列表在未压缩 SSH 链路上曾超过 10 秒管理等待时间；现有管理隧道启用 SSH 压缩后，两次完整列表读取分别约 3.50 秒、4.21 秒，历史没有删除。

首次部署脚本在 systemd 刚启动、端口尚未监听时立即探测健康，误报失败；随后实际健康检查通过，没有为此再次重启 relay。控制台恢复期间的临时探针已关闭。首次开关探针曾返回管理通路不可用；随后新建独立探针，完成下述关闭验收。没有对未知的物理动作换键重放。

## 实际验收

| 验收题目 | 结果与范围 |
| --- | --- |
| 两个新的独立 AI 同时接入 | 均为 enabled、connector_online、local_ready=true，拥有不同逻辑连接 |
| 当前网络工具发现 | 16 个工具 |
| 原 Android host 发现 | 33 个工具 |
| 原 Android 设备只读查询 | 真实 Jev 选择 inventory，后端确认原配置设备连接；未改变手机内容或界面 |
| 新的真实 Jev 决策 | `jev-1.14.0` 返回 read-status，用既有公钥独立验证签名；没有执行系统动作 |
| DELETE / 新 MCP transport 后续接 | 缓存的本轮 continuation 恢复原逻辑连接 |
| Nginx 热重载后的 TLS 重连 | relay 未再次重启，连接器自动恢复传输，本轮两个逻辑连接保持 |
| 连续稳定性 | 验收总计 187 秒，采样窗口 156.9 秒、20 次采样，两个连接全部保持就绪，没有退回 pending |
| 统一控制台 | 原页面显示真实 remote / Jev；完整连接历史可读取 |
| 控制台手动关闭 | 只关闭本轮自有测试 AI；其 continuation 立即失效，查询仍为关闭，没有自动重新准入；未重新自批准 |

设备和全局开关没有在生产环境做关闭试验，以免打断其他 AI。本轮手动关闭实测仅限自己的测试连接。稳定性样本为约三分钟，不等于长时间压力测试或 Windows 实体桌面交互验收。

30 秒参数是 relay 的设备心跳宽限。本机协调器原有 5 秒网络 owner 失联保护没有改变，因此不能承诺任何 30 秒以内的断线都保留 continuation。更长失联、撤销或 relay 重启后，保留原业务编号并建立新连接，不重放未知结果。

## Windows 现在如何继续

入口不变：`https://jev.43-160-233-161.sslip.io/mcp`。

1. Windows Codex 和 Windows executor 都重新初始化独立 MCP 连接。
2. 首次 `jev.network_status` 不传旧 continuation，确认三个就绪状态均为 true。
3. 私密缓存新返回的 continuation，后续调用自动带上；新独立测试使用新的 request_id / idempotency_key。
4. 原 `c9ec927c-2c46-42d8-9557-3f35cfa89b6a-decision` 已完成，带签名的 Jev 决策为 open。维护前后对原完成记录做哈希比对，完全一致，没有重放。原 CID / token 不恢复身份，也没有删除其历史记录。

不需要提供模型 Key、profile 或申请新额度。Windows 本机执行器继续由 Windows 端安装与验证，不在 Mac 上增加 Windows host。

## 用量、证据与检查

本轮真实验收调用模型 2 次，输入 775、输出 57 tokens；按原有计量配置，已知费用 **$0.00003255**。无新次数、费用或有效期限制。

[脱敏验收数据](../../artifacts/heartbeat-maintenance/verification.json)包含部署保留检查、逐项后验、20 次采样和控制台耗时。原始屏幕、设备数据、管理 token、SSH Key 与 private profile 不入库。

维护前重新构建并运行连接复用 / private lease 配置回归，6/6 通过；本轮没有修改产品源码。部署源码 `0267559` 的[完整离线 CI](https://github.com/giuliano1101/jev-fast/actions/runs/41359469715)与[Windows 只读 CI](https://github.com/giuliano1101/jev-fast/actions/runs/41359469698)均通过。后者不代表实体 Windows App 验收。
