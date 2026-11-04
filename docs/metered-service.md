# 直连费用与历史账本

UsageLedger 逐请求记录 token、状态及当时单价。缺失 usage 保留未知，传输故障不自动重发；本地估算不替代官方账单。

明确的付费活动传入 `TestBudget({directory:原活动预算目录,limitUsd:已批准总额})`。请求前保守预留、返回后结算，未知继续占用预留，事务与重启保留历史；不得换目录绕过累计上限或沿用另一电脑/过去活动的授权。

普通安装、skill 渲染和 CI 不调用付费 API，真实验收另需授权。`.runtime`、Key、私有 profile、账本和锁不提交到 GitHub；新机不复制另一机器的凭据或未决输入。

[历史实测费用及失败记录](reports/2026-11-05-official-direct-acceptance.md)。旧服务式计量入口已退出默认安装。
