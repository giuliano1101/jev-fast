# 测试题目、结果与经验索引

当前结构为各主机独立执行库。最新拆除与离线回归见[2026-11-04 报告](reports/2026-11-04-per-host-core.md)。以下材料保留原任务题目、seed、计时、成功判断、失败与优化记录；不能把旧入口配置当作当前接入步骤，也不能把历史固定样本成功率外推为任意网站/主机保证。

| 范围 | 题目/方法与结果 |
| --- | --- |
| 合成页面十二类、三档与异常 | [初始任务](../fixtures/tasks.ts) · [稳定性报告](../artifacts/stability/report.md) |
| 本机、CLI、MCP 同条件配对 | [配对协议](../artifacts/parity/paired-protocol.md) · [历史结果](../artifacts/parity/report.md) |
| 日常网页与筛选条件丢失 | [真实网站实验](../artifacts/real/report.md) · [混合策略](../artifacts/hybrid/report.md) |
| 安卓同机固定题与执行耗时 | [题目协议](../artifacts/mobile/protocol.md) · [实测](../artifacts/mobile/report.md) · [诊断](../artifacts/mobile/diagnosis.md) |
| 本机/网络稳定性、真实网站和手机 | [2026-11-02 实测](reports/2026-11-02-unrestricted-service.md) |
| Windows 本机浏览器与 CDP | [已有浏览器与恢复](reports/2026-11-02-local-browser-uptime.md) |
| 原生 App、计算器、TextEdit Unicode 与保存 | [原生报告](reports/2026-11-02-native-desktop.md) |
| 日常 Chrome、窗口截图、凭据与实例 fencing | [Mac 实测](reports/2026-11-03-public-mac-automation.md) |
| 请求压缩、批量读状态和开源对照 | [优化查阅](optimization-review.md) |

执行器保留：新鲜观察验证、导航后重新读取、实际后验、物理主机排序、签名选择验证、逐请求凭据读取、持久幂等与 UNKNOWN 隔离。混合执行保留教师/学生、已验证规则与异常触发逻辑。费用记录保留已知/未知用量的区分。

集中服务特有的 relay、continuation 和准入设计已[归档](archive/service-era/README.md)；历史 artifacts、JSON 和报告不重写、不删除。离线 CI 不调用 hosted API，物理 Windows、真实登录态和付费模型的验收范围要单独报告。
