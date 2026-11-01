# 只计费模式：不设付费上限

操作员在 2026-11-01 明确要求取消服务的付费限制，只计算其他 AI 使用的费用。当前部署采用可信本机 `metering` 策略：**不设金额封顶、不设累计调用次数上限、不设预算截止时间**。不会用一个巨大数值假装“无限”，也不再读取此前的父预算/子预算来拒绝请求。原历史账本和原审批原样保留，S17 的“剩余 2 次”不再适用于当前服务。

其他 AI 的入口不变：Streamable HTTP，`https://jev.43-160-233-161.sslip.io/mcp`，无需 Authorization；初始化填写展示名后等待自动接入。模型 Key、计费配置和凭据轮换由本机操作员进程处理，各 AI 不需要再次向用户索取或申请付费额度。停止自己的会话不会停止共享服务。

## 费用怎么计算

每次托管 HTTP 尝试之前，先持久写入一条独立记录；重试是新尝试，缓存命中/重复业务请求不重复调用或计费。收到有效顶层 usage 后，记录输入/输出 token、HTTP 状态和按该次价格计算的费用。即使答案无效、目标失败或返回非成功状态，也尽可能记录其有效 usage。

截至 2026-11-01，[TypeSafe 官方模型页](https://docs.typesafe.ai/models)列出 Jev 1.14 输入为 **$0.042 / 百万 token**，输出免费。因此当前计算式为：

```text
已知费用（USD）= 已返回的 input_tokens × 0.042 / 1,000,000
```

这叫按已返回用量计算的费用，不是从供应商账户直接拉取的最终账单。不把保守预留当作消费。未返回 usage、网络异常、进程中断后的未完成记录单独计入 `unknown_usage_attempts`；总已知费用不能代表这些请求免费，也不能据此宣称最终费用完整。预写记录与实际发出之间中断时，该记录也保留未知，不擅自删掉或自动重发。

目前费用按网关 identity 和 request_id 关联。公网 AI 名称是 relay 的自报展示名；共享 Mac 使用同一个网关 identity，所以这里的 `by_identity` 不能直接解释为每个 AI 的精确独立账单。需要按 AI 名称核对时须结合其原请求和协调器/relay 审计；本轮未新增跨层 AI 名称传递。

## 查看用量

这台已配置 Mac 可以直接运行以下命令。它只读本地统计，不读取模型 Key、不调用付费模型、不新增审批：

```sh
/Users/yubinai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/yubinai/Documents/jev/dist/src/remote/main.js usage \
  --config /Users/yubinai/Documents/jev/.runtime/live-service/gateway-config.json
```

输出包括已记录尝试数、已知/未知用量数、输入/输出 token、已知输入费用和按 identity/request 分组的信息。当前只计费阶段的记录位于私有 `.runtime/live-service/state/usage.sqlite`；它与旧 `gateway.sqlite`、部署预算账本独立。旧阶段账本可以核对历史用量，不把旧的 $0.08 预留合并为已消费金额。私有文件和完整请求关联信息不要上传 GitHub。

## 操作员配置

新安装默认仍为离线 mock。只有操作员显式配置私有网关时才开启托管调用。现有网关 config 的 `live.approvalFile` 可以指向如下 0600 私有文件：

```json
{"metering":{"policy_id":"operator-usage-only"}}
```

此格式与旧 `{authorization, approval}` 有上限格式互斥；不混入 expires_at/max_requests/max_cost_usd，也不把 metering 放进普通 AI/MCP 工具参数。旧有上限模式仍可供其他安装使用，不被全局删除。

本机私有 runner 已脱离旧 RequestBudget，持续为同一客户端证书签发短期 token。凭据续期不再受旧预算到期时间限制，服务配置和协调器身份保持不变。TLS 证书仍按正常有效期维护，模型供应商自身的配额、余额和故障由供应商决定；本项目不另外设置付费封顶。

本机手动总开关、动作后验、幂等和 UNKNOWN 规则照常工作。当前正式执行范围仍为 standard 合成页面十二道任务。这次是计费方式修改，没有增加任意网页/桌面/手机执行能力。

当前实测和运行证据见[报告](../artifacts/metered-service/report.md)。共享服务保持运行，不在任务清理时停止；本轮未增加 Mac 重启后自动恢复的承诺。
