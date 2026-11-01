# S17：接通真实 Jev 并保持共享服务运行

2026-11-01（Asia/Shanghai）。公网 MCP 已接到本机真实 Jev 网关及执行器，真实目标完成 `SUCCEEDED`，独立核验签名回执 `route: jev`，对应上游 HTTP 200。不是仅显示运行中，也没有用 mock 代替验收。

## 其他 AI 怎么接

使用 Streamable HTTP：`https://jev.43-160-233-161.sslip.io/mcp`，不配置 Authorization。初始化提供自己的 `clientInfo.name`，等待 `jev.network_status.enabled` 为 true。按操作员最新指令，本机自动接入程序接受所有非空 AI 名称，其他 AI 不必索取模型 API key、profile、证书或逐次请求用户开启。名称不是可信身份。

网络动作仍为 `{request_id, params}`，结果不确定用原 request_id 查询；UNKNOWN 不换键重放。各 AI 只结束自己的业务/MCP 会话，不停止共享服务。详见[接入说明](../../docs/public-service-quickstart.md)。当前执行范围仍为 standard 合成页面的十二道固定题目；本轮没有接通任意网站、桌面或 Android 控制。

## 本轮解决的问题

此前公网 MCP 登记正常，但共享协调器是本地 mock，缺少可持续使用的真实私有网关配置。本轮沿用既有 TypeSafe key，在 Mac loopback 配置 HTTPS/mTLS 决策网关、登记、签名回执及 `required_jev` profile，并在保留原账本后进行一次必要的安全切换。无正在执行目标时才停启，历史动作没有重放。

内部证书绑定 token 最多有效一小时，直接长期运行会失效。新增可信 profile 的可选 `tokenReload: true`，每次请求前读取原路径私有文件；读取时间算入原截止时间，损坏/空值/多行/权限错误/不可读/超时拒绝，不使用旧 token。指纹绑定配置、profile 路径和固定信任材料，允许原路径短期 token 轮换，默认静态模式保持旧语义。没有在 AI 工具参数里增加路径、模型选择、签发或审批权限。

私有 runner 每 20 分钟原子更新一次 token，单个有效期最长 55 分钟，始终受原预算到期时间限制。健康检查和本机签发不消耗托管模型额度。离线测试验证过期 token 更新后，原 provider 实例健康/决策恢复、静态实例保持原行为；未等待一小时做长期实测。

## 真正执行了什么

唯一新增付费验收题：standard fixture，`cancel` / 英文 / seed 1，最多一步。通过公网 MCP 初始化、自动接入、open_session、run_goal、查询结果及 close_session。目标 ID 为 `live-cancel-936b6268-7960-49e8-b82d-10623cb763b9`。

- 终态：SUCCEEDED；1 步，动作 SUCCEEDED / route=jev。
- 协调器原账本存在已核验签名 Jev 回执；上游 HTTP 200。
- 原费用账本请求计数 7→8；本次已知用量折算 $0.000021756。
- 只关闭验收自身的会话，共享协调器、连接器和网关均未清理停止。

原始脱敏证据：[MCP 结果](mcp-proof.json)、[健康检查](health.json)、[费用记录](accounting.json)、[控制面板截图](panel.png)。健康证据记录本次启动所用的基线 revision 和 dirty/sourceDigest；之后提交不会改变正在运行进程的构建身份，未为更新显示字段重启服务。

## 预算仍有边界

原用户批准：最多 50 次 / $0.10，原截止为 2026-11-01 22:44:24 UTC（北京时间 11 月 2 日 06:44:24）。本轮只将未用余额用于服务决策；没有追加、重置或延期。

每个真实 HTTP 尝试（含失败和重试）都先在原 RequestBudget 持久预留 $0.01，子网关额度是原余额的镜像，不是新增资金。验收后父账本为 8 次、保守预留 $0.08，最多还剩 2 次 / $0.02 的保守尝试。子额度共 3 次，已经使用 1 次。已知实际费用较低也不会自动释放保守预留。额度耗尽或到期后付费决策拒绝，服务进程保持运行，不回退 mock、不自动申请新预算。后续其他 AI 使用会继续减少该余额。

## 运行维护（已配置，无需用户再提供）

以下路径仅定位私有配置，不包含密钥内容：

| 项目 | 本机位置/状态 |
| --- | --- |
| 共享协调器 | `/tmp/jev-501`，真实 remote Jev，required_jev |
| 网关 | `https://127.0.0.1:49443`，仅本机，mTLS |
| 私有配置/runner | `/Users/yubinai/Documents/jev/.runtime/live-service/`，目录 0700、材料 0600 |
| profile | 上述目录的 `profile.json`，tokenReload=true |
| 本机面板 | `http://127.0.0.1:47831/`，已固定同一 profile；管理令牌保存在私有启动日志/本机标签页 |
| 连接器配置 | `.runtime/public-connector/connector.json`，client-a 路径必须字面使用 `/tmp/jev-501` |
| 自动 AI 接入 | `~/Library/Application Support/jev-auto-admit/jev-auto-admit.py`，launchd `com.jev.auto-admit` |
| 接入控制台 | 私有 SSH tunnel 到 `127.0.0.1:47832`，管理端口不公开 |
| 原付费账本 | `.runtime/deployment-budget-20261101/budget.json`，原计数保留 |
| HTTP 审计/网关账本 | 私有目录的 `http-attempts.jsonl` / `state/gateway.sqlite` |

协调器、真实网关、固定 profile 的面板均已脱离启动会话独立后台运行（核验 PPID 1）。连接器和隧道保持原长驻进程，自动 AI 接入已有 launchd。尝试将网关交给 launchd 时，系统在 Node 执行前因后台访问 Documents 返回 EX_CONFIG 78；未降低 macOS 隐私设置，已卸载本次失败 job，改用 detached 进程。**不宣称 Mac 重启后自动恢复，也不宣称已经长期运行验收。**

请复用当前已打开的新面板，已显示 `运行中 / remote · Jev / 已连通`。通用 `打开Jev控制面板.command` 仍用于新安装默认 mock，不要用其替换当前面板。若面板单独退出，只需重新用相同配置启动面板，不停止协调器：

```sh
# 仅供这台已配置的 Mac 的操作员维护
/Users/yubinai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/yubinai/Documents/jev/dist/src/control/main.js \
  --runtime /tmp/jev-501 \
  --config /Users/yubinai/Documents/jev/.runtime/live-service/profile.json
```

网关若异常退出，先按运维说明确认原进程、在途请求和审计，不能盲目清锁、重复启动或换业务键。运行私有 runner 必须以仓库为 cwd；它会读取原 Key/审批/账本，不负责创建新预算。不得在其他 AI 会话结束时运行 service stop。操作员需要总停时，仍可在本机面板点击停止服务。自动接入策略持续开启新 AI；需要撤销该策略时先暂停自动接入程序，再管理单个接入开关。

## 验证

类型检查、lint 均 exit 0；默认测试 411/411，集成 77/77，安全 40/40，无失败、取消、跳过。默认测试含核心安全测试，不能把三组简单相加解释为互不重叠的独立样本。新增六项 token reload 测试覆盖轮换、坏文件、静态兼容、指纹、截止和取消；另有独立规范/质量审查通过。普通测试和 CI 没有 hosted 调用。

完整日志见 [verification](verification/)，摘要见 [checks.json](checks.json)。真实公网成功仅一题，是接通证明，不是新的成功率/性能基准。历史扩样数据保留原报告，不替换其成绩。本轮没有实体第二台电脑验收，没有新增通用电脑操控能力。
