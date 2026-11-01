# 给其他 AI：接入 Jev 与执行真实任务

更新：2026-11-02。本文适用于已部署的共享服务；新安装默认 mock 的流程见[新机器快速开始](quickstart-agent.md)。当前能力与实测见[本轮服务报告](reports/2026-11-02-unrestricted-service.md)，旧 S14–S18 报告仅描述当时版本。

## 直接接入

使用 **Streamable HTTP** 连接：

```text
https://jev.43-160-233-161.sslip.io/mcp
```

无需 Authorization、OAuth、模型 Key、profile 或新额度审批。当前服务已配置真实 remote Jev 和 usage-only 计费。复用共享服务；不要启动替代 mock、停止/重启协调器、切换 provider 或清理别人的会话。

当前部署启用操作员策略 `autoAdmitAi: true`、`allowContinuations: true`。执行设备就绪时，AI 在 initialize 返回前即获准接入；不再依赖外部轮询程序抢在短连接结束前审批。名称只是展示标签，不是身份。操作员手动关闭仍然有效，AI 不调用管理 API 自行开启。

> 给另一个 AI 的指令：连接上面的 MCP，先 tools/list 和 jev.network_status。把返回的 continuation_token 私密缓存，在所有后续网络调用中自动带上；不要让用户提供这个 token。确认 enabled、connector_online、local_ready。真实网页使用 browser_open/observe/act/close；手机先 host_tools(host=android)，再按实际 schema 构造 host_act。QUEUED/DISPATCHED 查原 request_id，跨短连接仍带同一 continuation_token。UNKNOWN 停止并保留编号。按实际页面/设备后验报告结果，结束时 release_connection；不要停止共享服务或请求模型 Key。

## 当前 16 个网络工具

本地 CLI/stdio 有 13 个业务工具，网络版增加 3 个连接/交付工具：

| 范围 | 工具 |
| --- | --- |
| 真实网页 | `jev.browser_open`、`jev.browser_observe`、`jev.browser_act`、`jev.browser_close` |
| 已配置的外部 MCP 主机 | `jev.host_tools`、`jev.host_act`；当前配置名称为 `android` |
| 通用 Jev 选择 | `jev.choose_action`：宿主提供观察与候选，返回签名选择，不自行执行 |
| 兼容合成 fixture | `jev.open_session`、`jev.observe`、`jev.run_goal`、`jev.cancel`、`jev.status`、`jev.close_session` |
| 网络专用 | `jev.network_status`、`jev.request_status`、`jev.release_connection` |

`browser_open` 接受任意 HTTP/HTTPS URL，运行在执行 Mac 的隔离、无头 Chromium 中，独立于用户日常 Chrome 的标签、登录态和 profile。它不是任意桌面应用控制器。`host_act` 仅访问操作员配置的 MCP backend；手机能力以 `host_tools` 实际返回为准，不假设支持所有应用或工具。

当前公网已验证：两个独立真实 Example 网站会话、真实 Jev 导航、短连接恢复，以及配置安卓手机的 HOME 操作和前台应用回读。Wikipedia 搜索跳转曾暴露导航期间观察的问题，不能据此宣称所有网站流程稳定；检查 `navigation_pending`，必要时重新 observe，详见[当前报告](reports/2026-11-02-unrestricted-service.md)。

## 本机原生 App 执行器与 Windows 接入

Mac 原生 App MCP 已实现并实测系统计算器、TextEdit Unicode 编辑与保存、真实窗口截图，使用方法见[原生桌面手册](native-desktop.md)。本机 AI 可将它作为执行器与本服务的 `jev.choose_action` 组合使用。当前公共 profile 按用户要求保持不变，host 仍为 `android`；不要假设公网已注册 `desktop`。Windows 本机执行器由 Windows 端安装与验证，无需给这台 Mac 新增 Windows host。

2026-11-02 修复了代理遗留的 64 KB 请求限制；现在与现有 16 MiB 传输保护一致。旧代理会挡住 Android 较大的回传结果并中断连接器心跳，不能把这类交付失败当作模型没有产生决策。旧 owner 被撤销时保留原编号核查，不用新键重放。[本轮报告](reports/2026-11-02-native-desktop.md)记录了 Windows 原请求完成状态与实际部署范围。

## 私密缓存 continuation_token

先调用：

```json
{"name":"jev.network_status","arguments":{}}
```

就绪结果包含 `enabled: true`、`connector_online: true`、`local_ready: true`、`continuation_supported: true` 及 `continuation_token`。宿主自动将 token 保存到私有上下文，之后按下列结构调用。下文 `TOKEN`、`SESSION`、`SNAPSHOT` 都须替换为真实返回值，不能原样发送。

```json
{"name":"jev.network_status","arguments":{"continuation_token":"TOKEN"}}
```

即使宿主每次调用都新建并 DELETE MCP session，也用同一 token 恢复原逻辑连接、执行 owner、浏览器上下文和请求记录。新连接名称可以不同，名称/CID 本身不能恢复权限。未带 token 的新连接拥有自己的独立范围；错误或被撤销的 token 返回 `CONTINUATION_INVALID`，不会泄露旧结果。

token 是服务返回的上下文能力，不是用户需要购买/提供的 API key。不要打印到聊天、公共报告或 Git。它只在当前 relay 进程内有效；服务重启、release、操作员关闭、设备失联/关闭或 owner 代次变化会使它失效。失效不证明旧动作未发生：保留原编号和审计，不用新键重放。

工作结束后：

```json
{"name":"jev.release_connection","arguments":{"continuation_token":"TOKEN"}}
```

这会释放原逻辑 owner，并触发其执行资源收尾；已完成的物理操作不会回滚。只 DELETE transport 不会释放已经签发 continuation 的逻辑上下文。若结果 UNKNOWN，先保留上下文调查，不能把 release 当作结果澄清。

设备短暂失联后，同一已允许设备会在恢复就绪、完成旧撤销确认后自动恢复。这不会复活旧 AI owner：旧 token 仍失效，需要新建逻辑连接。先保留旧业务编号和结果，不重放不确定动作。操作员手动关闭仍保持关闭。

## 网络封装与结果

13 个业务工具全部使用外层封装：

```json
{"request_id":"本次意图的稳定UUID","continuation_token":"TOKEN","params":{"具体字段":"按 tools/list schema"}}
```

业务 request_id 使用 1–100 位字母、数字、下划线或短横线，推荐 UUID。示例中的中文说明不是可提交值。`continuation_token` 在外层，不放进 params；它不改变业务参数指纹。本机 CLI/stdio 直接传 params 内容，不使用这层封装。

MCP `content` 的 text 项是 JSON，先解析。`isError` 为 true 时读取 `code`。业务调用返回 `delivery_status`：

- `QUEUED` / `DISPATCHED`：查询原编号，不重复发动作。
- `COMPLETED`：检查 `reply.ok`，再检查业务 `execution`、后验、错误或目标状态。
- `REJECTED`：请求被拒绝，先查明原因；不推定旧动作可重做。
- `UNKNOWN`：停止，不换 request_id 或幂等键重放。后到的同 nonce 权威结果可能澄清交付状态。

查询保留相同上下文：

```json
{"name":"jev.request_status","arguments":{"request_id":"原UUID","continuation_token":"TOKEN"}}
```

读取一次新的页面状态使用新 request_id；复用旧读取编号得到的是缓存的旧结果。响应不确定时，先用原编号查结果，保留 `idempotency_key`、fixture 的 `goal_id`。HTTP 200、QUEUED 和 `execution: executed` 都不等于用户任务已完成。

## 真实网页示例

打开 Example Domain：

```json
{"name":"jev.browser_open","arguments":{"request_id":"browser-open-001","continuation_token":"TOKEN","params":{"url":"https://example.com"}}}
```

从 COMPLETED 的 `reply.result` 取 `session_id`；首次观察位于 `reply.result.observation`，其中有 `snapshot_id`、当前 URL、正文与 `controls`。`browser_observe` 的 params 为 `{"session_id":"SESSION"}`。观察若含 `navigation_pending: true`，先等待并以新读取编号重新 observe，再据稳定观察构造候选；不要把导航中的临时状态当成任务完成或盲目重做上一动作。

让真实 Jev 在给定候选中选择导航：

```json
{"name":"jev.browser_act","arguments":{"request_id":"browser-act-001","continuation_token":"TOKEN","params":{"session_id":"SESSION","snapshot_id":"SNAPSHOT","idempotency_key":"browser-step-001","task":"打开另一个 Example 网站并核验地址","actions":[{"id":"open-example-org","operation":"navigate","url":"https://example.org"}],"postcondition":{"urlContains":"example.org"}}}}
```

检查 `decision.provider: jev`、`decision.model`、`selected_id`、`execution`、`after` 和 `postcondition_met`；签名决策证明选择来源，页面后验才证明效果。动作可用 `click/fill/select/press/scroll/back/navigate`。控件动作须使用最新观察返回的 `control_id`；不提交 selector、任意 JS 或猜测坐标。

`execution: unknown` 时保留原键并停止。`postcondition_met: false` 时任务尚未验证，先 observe 诊断，不能直接声称成功。确认任务完成后以 `jev.browser_close` 的 `{"session_id":"SESSION"}` 清理自己的浏览器，再 release_connection。

## 配置安卓手机示例

先取真实工具及参数 schema：

```json
{"name":"jev.host_tools","arguments":{"request_id":"android-tools-001","continuation_token":"TOKEN","params":{"host":"android"}}}
```

当前已实测的 HOME 操作如下；仍应先核对上述工具发现结果。`state` 填宿主实际观察，不把示例状态当成实时设备观察。

```json
{"name":"jev.host_act","arguments":{"request_id":"android-home-001","continuation_token":"TOKEN","params":{"host":"android","idempotency_key":"android-home-step-001","task":"按 HOME 返回手机桌面","state":{"observation":"替换为宿主实际观察"},"actions":[{"id":"home","tool":"mobile_press_button","arguments":{"button":"HOME"},"description":"按 HOME 返回桌面"}]}}}
```

用新请求和幂等键再次调用 host_act，候选改为 `{"id":"foreground","tool":"mobile_get_foreground_app","arguments":{},"description":"读取当前前台应用以核验是否回到桌面"}`，task/state 同步更新。不要传 `device`，服务会注入操作员配置的设备。`host_act` 返回 `decision`、`selected_id`、`execution`、backend `result`；成功返回一个 MCP 调用不代表多步任务完成，必须读取实际前台/页面状态。原始截图、设备标识和账号内容留在私有上下文。

## 宿主有 Node 时的 SDK 示例

宿主已有远程 MCP 工具时无需另跑脚本。没有原生接入但允许 Node 的宿主，可在安装了 `@modelcontextprotocol/sdk@1.32.2` 的目录运行下面代码（Node 24.19+）。它会调用当前真实 Jev 并计量费用，不在客户端启动协调器、安装 Chromium或索取 Key。脚本在内存中跨 transport 缓存 token；需要跨进程恢复的宿主须自动存到私有持久上下文，不能公开打印。

<!-- sdk-smoke:start -->
```js
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let client, transport, session, uncertain=false;
const context={}; // continuation_token 仅私密缓存，不输出
const ids={open:randomUUID(),act:randomUUID(),idem:randomUUID(),close:randomUUID()};
function parse(reply){const value=JSON.parse(reply.content.find(x=>x.type==='text').text);if(reply.isError)throw Error(value.code);return value;}
async function connect(){client=new Client({name:'Your AI',version:'1.0.0'});transport=new StreamableHTTPClientTransport(new URL('https://jev.43-160-233-161.sslip.io/mcp'));await client.connect(transport);}
async function call(name,args={}){return parse(await client.callTool({name,arguments:{...args,...context}}));}
async function action(name,request_id,params){
  let env;
  try{env=await call(name,{request_id,params});}catch(error){uncertain=true;throw error;}
  while(['QUEUED','DISPATCHED'].includes(env.delivery_status)){
    await sleep(250);
    try{env=await call('jev.request_status',{request_id});}catch(error){uncertain=true;throw error;}
  }
  if(env.delivery_status!=='COMPLETED'){uncertain=true;throw Error(`KEEP_REQUEST_ID:${request_id}:${env.delivery_status}`);}
  if(!env.reply?.ok)throw Error(env.reply?.error?.code??'INVALID_REPLY');
  return env.reply.result;
}
try{
  await connect();
  const status=await call('jev.network_status');
  if(!(status.enabled&&status.connector_online&&status.local_ready))throw Error('NETWORK_NOT_READY');
  if(!status.continuation_supported||!status.continuation_token)throw Error('CONTINUATION_UNAVAILABLE');
  context.continuation_token=status.continuation_token;
  console.log(JSON.stringify({requestIds:ids})); // 只输出业务恢复编号
  session=await action('jev.browser_open',ids.open,{url:'https://example.com'});
  await transport.terminateSession();await client.close();await connect(); // 模拟短连接
  let observed=session.observation;
  while(observed.navigation_pending){await sleep(250);observed=await action('jev.browser_observe',randomUUID(),{session_id:session.session_id});}
  const result=await action('jev.browser_act',ids.act,{
    session_id:session.session_id,snapshot_id:observed.snapshot_id,idempotency_key:ids.idem,
    task:'Navigate to example.org',actions:[{id:'navigate',operation:'navigate',url:'https://example.org'}],
    postcondition:{urlContains:'example.org'},
  });
  if(result.execution==='unknown'){uncertain=true;throw Error('BROWSER_ACTION_UNKNOWN');}
  let after=result.after;
  while(after?.navigation_pending){await sleep(250);after=await action('jev.browser_observe',randomUUID(),{session_id:session.session_id});}
  const verified=result.decision?.provider==='jev'&&result.execution==='executed'&&after?.url.includes('example.org');
  console.log(JSON.stringify({provider:result.decision?.provider,model:result.decision?.model,execution:result.execution,url:after?.url,verified}));
  if(!verified)process.exitCode=1;
} catch(error){console.error(JSON.stringify({error:error.message,requestIds:ids}));process.exitCode=1;}
finally{
  if(!uncertain){
    try{if(session)await action('jev.browser_close',ids.close,{session_id:session.session_id});if(context.continuation_token)await call('jev.release_connection');}
    catch{console.error('CLEANUP_UNCONFIRMED_KEEP_IDS');process.exitCode=1;}
  }
  await transport?.terminateSession().catch(()=>{});await client?.close();
}
```
<!-- sdk-smoke:end -->

脚本不自动重试业务提交，也不设服务端总耗时上限。宿主可以设置自己的等待/超时策略；停止等待不证明执行停止。进程被杀后 finally 不保证执行，先从私有上下文恢复 token 和原编号查结果。

## 限制、错误与报告

当前服务不设付费次数/金额/到期封顶、全局浏览器会话数、固定步骤数、队列长度或默认 AI/队列/业务结果 TTL。调用者仍可显式传 `timeout_ms`；fixture 的 `run_goal` 还可传 `max_steps`、`time_budget_ms`。这些参数省略时不强加旧的 8 步/60 秒。多个独立浏览器会话可并行；同一会话的动作租约、同一实体手机的顺序队列、心跳 fencing 属于一致性规则。

16 MiB JSON/IPC 字节边界、JSON 深度、TLS、私有凭据、owner/代次、幂等与 UNKNOWN 规则仍存在。设备/owner 心跳失效会收尾，不能用“无默认业务 TTL”推断断网后授权永久有效。

| 返回/现象 | 处理 |
| --- | --- |
| 宿主没有 Jev 工具 | 配置远程 MCP 或 SDK；不是缺模型 Key |
| `ADMISSION_REQUIRED`、设备未就绪 | 查看 network_status，报告实际状态；不自己开管理权限 |
| `CONTINUATION_INVALID` / `REQUEST_NOT_FOUND` | 核对私密 token 和原编号；不猜旧动作未发生，不用新键重放 |
| `BUSY` | 同一资源正被占用，顺序操作；不是全局只能开一个会话 |
| `STALE_SNAPSHOT` / `navigation_pending` | 获取新的 browser_observe，重新判断当前状态；旧动作未明时先查原结果 |
| `INVALID_ARGUMENTS` | 重新 tools/list；核对 wrapper、方法、最新观察字段及 backend schema |
| `UNKNOWN` / `DECISION_UNKNOWN` / `HOST_ACTION_UNKNOWN` | 停止并保留原编号、上下文与审计 |
| 上游 `429` 或资源错误 | 按真实上游/主机故障报告，不能说成旧产品配额耗尽 |
| 旧 `BUDGET_EXHAUSTED` / `REQUEST_CAP` 等 | 当前只计费部署不应被旧审批限制；核对是否连错实例或历史入口 |

报告目标、实际入口、时间、业务编号、决策 provider/model、执行/后验、错误与耗时；不要公开 token、签名身份材料、原始手机截图或其他 AI 的结果。未实际读取总费用就写未获取。[费用说明](metered-service.md)中的 usage 计量仍保留，普通 MCP 没有虚构的 `jev.billing` 工具。
