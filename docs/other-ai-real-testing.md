# 给其他 AI：接入 Jev 与进行真实模型测试

更新：2026-11-01。适用于已经部署的共享 Mac 服务。先读这一份，不要套用新安装 mock、旧实验审批或旧阶段剩余额度。

## 先判断你想测什么

| 目标 | 当前正式 MCP 能力 |
| --- | --- |
| 调用真实 Jev 模型，驱动真实 Chromium 中的内置测试页面 | **支持，已实测成功**；页面是合成 fixture，不是生产网站 |
| 用多个 AI 客户端连接服务 | 支持多个连接；浏览器业务会话目前只能同时存在一个 |
| 打开任意 URL、控制用户日常 Chrome、抖音 App 或安卓手机 | **正式 MCP 尚未接入这些执行适配器** |
| 将截图、坐标、selector、自然语言网页任务直接提交给本服务 | 当前工具 schema 不接受这些参数 |

因此，“无法用正式 MCP 测试真实网站/App”可能是准确的能力判断。仓库以前确实做过真实网站、抖音和安卓研究实验，但它们是独立研究适配器，不会因为服务开启就自动成为公网 MCP 工具。不要把缺少适配器说成用户没给 Key，也不要把普通 computer use 执行的成绩冒充 Jev MCP 成绩。

本说明书给出**目前可以完成的真实 Jev 模型验收**。它不新增通用网页/桌面能力。研究工具细节见[真实网站实验](real-testing.md)和[安卓实验](mobile-testing.md)；其中旧入口仍有历史实验参数/预算要求，不是当前共享服务的接入流程，不要让用户重复提供这些文件。

## 可以直接转发给 AI 的指令

> 请阅读 docs/other-ai-real-testing.md。使用 Streamable HTTP 连接 https://jev.43-160-233-161.sslip.io/mcp，无需 Authorization。服务已经配置真实 Jev 和只计费策略，新 AI 自动接入；不要向用户索取 API key、profile、证书或新额度审批，不要另起 mock，不要重启/停止共享服务。先 tools/list，再轮询 jev.network_status，等 enabled、connector_online、local_ready 都为 true。按文档用 standard/cancel/en/seed1 做一轮验收：open_session → run_goal → status 检查动作 receipt.route=jev → close_session。网络动作必须带 request_id 和 params 外层。QUEUED/DISPATCHED 查原 request_id；COMPLETED 仍需检查 reply.ok 和业务 status。UNKNOWN 停止并保留原编号。BUSY 表示共享执行器已被占用，不要关别人的会话；最终只关自己的会话。报告实际错误码、目标状态和路由。若用户要求任意真实网站/App，请明确报告该执行适配器尚未接入，不能用文档或换参数补足。

## 1. 连接地址和宿主条件

```text
https://jev.43-160-233-161.sslip.io/mcp
```

传输选择 **Streamable HTTP**，不是旧式 SSE。无需模型 API key、Authorization 或 OAuth。AI 展示名使用标准 initialize 的 `clientInfo.name`。

宿主必须实际支持并启用远程 MCP。仅在聊天里看到网址或读取 GitHub，并不等于该宿主已经有 MCP 工具。若工具列表中没有 Jev，先使用宿主的远程 MCP 设置添加上面地址；若宿主不支持远程 MCP，但允许执行 Node，可以使用第 6 节 SDK。宿主自身没有工具/网络权限时，报告缺的是宿主能力，不要要求用户重新提供 Jev 模型 Key。

本地 `127.0.0.1:47831` 是 Mac 控制面板；`47832` 是私有管理台，两者均不是外部 AI 的 MCP 地址。公网 `/` 返回404正常，使用 `/mcp`。`/health` 返回成功只证明 relay 存活。

## 2. 确认可用

发现的工具应有八个：

```text
jev.open_session  jev.observe  jev.run_goal  jev.cancel
jev.status        jev.close_session
jev.network_status  jev.request_status
```

先调用：

```json
{"name":"jev.network_status","arguments":{}}
```

等以下字段均为 true，再提交业务请求：

```json
{"enabled":true,"connector_online":true,"local_ready":true}
```

新连接短时间返回 `admission: pending` / `enabled: false` 是自动接入轮询过程；可每500ms查询，先等待15秒。持续不就绪时保留实际状态，报告连接器/自动接入故障；不要据此索取用户 Key 或用管理接口自己开启。网络状态不包含模型 provider，不能凭这些字段声称已用到真实 Jev；后面还要检查动作路由。

## 3. 网络参数与异步结果

六个业务工具的参数外层必须是：

```json
{"request_id":"你生成并保存的UUID","params":{"具体业务参数":"放在这里"}}
```

上面是结构示意，中文占位文字不能原样提交。ID只允许1–100位英文字母、数字、下划线、短横线，推荐UUID。`session_id` 必须取 open 返回的真实值。

工具结果通常位于 MCP `content` 的 text 项中，是 JSON 字符串。先解析它；若 `isError: true`，读取其中的 `code`。业务工具返回的是交付信封，例如：

```json
{"request_id":"原编号","delivery_status":"QUEUED"}
```

QUEUED 或 DISPATCHED 时，**不重复提交动作**，改查：

```json
{"name":"jev.request_status","arguments":{"request_id":"原编号"}}
```

COMPLETED 后检查：

```json
{"delivery_status":"COMPLETED","reply":{"ok":true,"result":{"status":"SUCCEEDED"}}}
```

`reply.ok: false` 时错误在 `reply.error.code`。`reply.ok: true` 也可能返回业务 FALLBACK/CANCELLED/UNKNOWN；HTTP200、工具发现成功和 QUEUED 都不算目标成功。网络 UNKNOWN 与业务 UNKNOWN 都不能通过换编号重做原动作。

本机 stdio/CLI 不使用网络 request_id/params 外层。不要混用两套 schema。

## 4. 最短真实 Jev 验收

每个新的业务调用使用自己的 request_id，并保存到日志。同一请求响应丢失时保留原编号查询。

**A. 打开测试会话**

```json
{"name":"jev.open_session","arguments":{"request_id":"open-REPLACE_WITH_UUID","params":{"fixture_id":"standard"}}}
```

取 COMPLETED → reply.result.session_id，后续示例中的 SESSION_ID_FROM_OPEN 全部替换为它。

**B. 提交一步取消题**

```json
{
  "name":"jev.run_goal",
  "arguments":{
    "request_id":"run-REPLACE_WITH_UUID",
    "params":{
      "session_id":"SESSION_ID_FROM_OPEN",
      "goal_id":"goal-REPLACE_WITH_UUID",
      "idempotency_key":"idem-REPLACE_WITH_UUID",
      "goal":{"task":"cancel","language":"en","seed":1},
      "success":{"kind":"task_complete"},
      "max_steps":1,
      "time_budget_ms":15000
    }
  }
}
```

等结果交付，成功标准为 result.status=SUCCEEDED。保存 result.action_ids。

**C. 核对真实 Jev 路由**

对属于这个目标的 action_id 调用：

```json
{"name":"jev.status","arguments":{"request_id":"action-status-REPLACE_WITH_UUID","params":{"session_id":"SESSION_ID_FROM_OPEN","action_id":"ACTION_ID_FROM_RESULT"}}}
```

确认 action 的 `status: SUCCEEDED` 和 `receipt.route: jev`。该 receipt 是协调器验签并消费后的账本元数据。仅声称“工具执行成功”不能区分 Jev 和 mock。需要重新查询目标可用同一工具的 `goal_id` 参数；不要同时传 goal_id 和 action_id，以免只取到目标结果。

**D. 释放自己的会话**

```json
{"name":"jev.close_session","arguments":{"request_id":"close-REPLACE_WITH_UUID","params":{"session_id":"SESSION_ID_FROM_OPEN"}}}
```

确认 closed 后，结束自己的 MCP session。不要运行全局 service stop，不要关闭别人的业务会话。

## 5. 更多内置题与当前限制

任务枚举：`form/filter/detail/back/cancel/correction/duplicate/async/scroll/select/wait/navigation`。可以替换上面的 goal.task，使用 `max_steps: 8`、`time_budget_ms: 60000`；依然逐题打开、执行和关闭，不承诺每次一定成功。

远程首测省略 `goal.values`，避免非规范测试值。确需传入时必须与seed一致：name=`Synthetic-${seed}`，email=`synthetic-${seed}@example.invalid`，category=`beta`，query=`item-${seed}`；不是任意真实姓名、邮件和搜索内容。

| 当前工程事实 | 对 AI 的影响 |
| --- | --- |
| 多个 MCP 连接、全局仅一个已打开/正在打开的浏览器业务会话 | 第二个 open 返回 BUSY；不会自动等到空闲再执行 |
| 一个业务会话内最多一个活动目标 | 不并发 run_goal/observe，按顺序调用 |
| run_goal 最多8步、最长60秒 | 不要提交更大参数或长流程；这些是执行参数约束，不是付费封顶 |
| 一个 relay 当前选择一台执行设备 | 不是多机器任务调度器 |
| fixture_id 只允许 standard | 不传url、截图、坐标、selector或任意脚本 |

**单会话是本项目 MVP 的硬限制，不是 Jev 官方 API 的限制。** 代码位置：`src/core/engine.ts` 的 openSession 全局判忙检查，健康接口也固定报告 active_session_limit=1。这次说明书没有修改该行为。

BUSY 已确认 open 失败时，可先等待正在使用的 AI 正常 close，再用新的 open request_id 发起一次新的打开尝试；旧 request_id 已缓存 BUSY 时反复查询只会得到旧失败。若是原打开请求响应丢失且结果未明，应先查原编号，不能按BUSY处理。不得通过停止协调器、清锁、读取别人凭据或关别人会话解决占用。

## 6. 宿主有 Node 时的完整 SDK 示例

宿主已有 Jev 工具时无需跑此代码。没有原生远程 MCP 工具但允许 Node 的宿主，可以在有 `@modelcontextprotocol/sdk@1.32.2` 的目录把下面代码存为 `jev-smoke.mjs`，运行 `node jev-smoke.mjs`。仓库目录已有锁定依赖时直接可用；新 checkout 只需 `npm ci --ignore-scripts` 安装客户端依赖，无需在客户端启动协调器、安装 Chromium 或提供模型 Key。Node需24.19+。

这会进行一次真实模型调用并入账。每次独立新测试的ID随机产生；执行中断后保留已打印的ID，查询原结果，不盲目重新运行。

<!-- sdk-smoke:start -->
```js
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({name:'Your AI Jev Test',version:'1.0.0'},{capabilities:{}});
const transport = new StreamableHTTPClientTransport(
  new URL('https://jev.43-160-233-161.sslip.io/mcp'),
);
const ids = Object.fromEntries(['open','run','goal','idem','close'].map(k=>[k,randomUUID()]));
console.log(JSON.stringify({testIds:ids})); // 业务恢复编号；不打印网络 session header 或凭据
function parse(reply) {
  const value = JSON.parse(reply.content.find(x=>x.type==='text').text);
  if(reply.isError) throw new Error(value.code);
  return value;
}
async function action(name,request_id,params) {
  let env = parse(await client.callTool({name,arguments:{request_id,params}}));
  const deadline = Date.now()+90000;
  while(['QUEUED','DISPATCHED'].includes(env.delivery_status)) {
    if(Date.now()>=deadline) throw new Error(`RESULT_UNCONFIRMED_KEEP_REQUEST_ID:${request_id}`);
    await sleep(250);
    env = parse(await client.callTool({name:'jev.request_status',arguments:{request_id}}));
  }
  if(env.delivery_status!=='COMPLETED') throw new Error(`KEEP_REQUEST_ID:${request_id}:${env.delivery_status}`);
  if(!env.reply?.ok) throw new Error(env.reply?.error?.code??'INVALID_REPLY');
  return env.reply.result;
}
let session;
try {
  await client.connect(transport);
  console.log(JSON.stringify({tools:(await client.listTools()).tools.map(x=>x.name)}));
  let ready=false;
  for(let n=0;n<30;n++) {
    const s=parse(await client.callTool({name:'jev.network_status',arguments:{}}));
    if(s.enabled&&s.connector_online&&s.local_ready) {ready=true;break;}
    await sleep(500);
  }
  if(!ready) throw new Error('NETWORK_NOT_READY');
  session=await action('jev.open_session',ids.open,{fixture_id:'standard'});
  const result=await action('jev.run_goal',ids.run,{
    session_id:session.session_id,goal_id:ids.goal,idempotency_key:ids.idem,
    goal:{task:'cancel',language:'en',seed:1},success:{kind:'task_complete'},
    max_steps:1,time_budget_ms:15000,
  });
  const actions=[];
  for(const action_id of result.action_ids??[]) {
    const row=await action('jev.status',randomUUID(),{session_id:session.session_id,action_id});
    actions.push({status:row.status,route:row.receipt?.route??null});
  }
  const verified=result.status==='SUCCEEDED'&&actions.length>0&&
    actions.every(x=>x.status==='SUCCEEDED'&&x.route==='jev');
  console.log(JSON.stringify({goalStatus:result.status,reason:result.reason,actions,verified}));
  if(!verified) process.exitCode=1;
} catch(error) {
  console.error(JSON.stringify({error:error.message,testIds:ids}));
  process.exitCode=1;
} finally {
  if(session) {
    try {await action('jev.close_session',ids.close,{session_id:session.session_id});}
    catch {console.error(JSON.stringify({cleanup:'UNCONFIRMED',request_id:ids.close}));}
  }
  await transport.terminateSession().catch(()=>{});
  await client.close();
}
```
<!-- sdk-smoke:end -->

SDK脚本不自动重试业务提交，故障保留原ID。原请求查询属于原MCP网络会话；脚本不持久保存私有transport session handle，进程死亡或原会话失效后，新建客户端不能读取旧连接的请求。这时保留业务编号交给操作员核查，不能换编号重发。若进程被强制中断，finally不保证执行；不要据此推定原会话或动作未发生。

## 7. 报错时怎么判断

| 现象/错误 | 含义与处理 |
| --- | --- |
| 宿主没有 Jev 工具 | 宿主尚未接入MCP；添加远程地址或使用SDK，不是模型Key缺失 |
| ADMISSION_REQUIRED | 初次先等自动接入；持续不变时报告状态，不自己调用管理API |
| connector_online=false / local_ready=false | Mac连接器或协调器未就绪，报告运维故障，勿另起mock |
| BUSY | 共享业务会话/目标被占用，按第5节等待与释放自己的会话 |
| INVALID_ARGUMENTS | 重新 tools/list 核对schema；常见为缺request_id/params、中文ID、传url/坐标、超8步/60秒 |
| NONCANONICAL_SYNTHETIC_VALUE | 传了任意values；首测省略values，或使用seed对应规范值 |
| SESSION_NOT_FOUND / HANDLE_EXPIRED | 网络会话已失效；旧请求先保留核对，新连接自动登记，别猜原动作没发生 |
| REQUEST_NOT_FOUND | 检查是否原MCP连接和原request_id；其他AI不能读你的记录 |
| FALLBACK | 目标未完成；读reason和status，不改用其他执行器后记作Jev成功 |
| UNKNOWN / DECISION_UNKNOWN | 结果不确定，停止新动作并保留原编号/审计，不换键重放 |
| RATE_LIMITED / 429 | 技术限流/上游配额，按错误处理；不是旧金额预算耗尽 |
| BUDGET_EXHAUSTED / REQUEST_CAP / COST_CAP / LIVE_NOT_AUTHORIZED | 当前共享服务是无预算封顶的只计费模式；若出现这些旧费用错误，应报告可能连错实例/旧研究入口/配置回退，不能认定为用户未授权 |
| 路由mock | 连到了模拟实例；不能作为真实Jev结果，也不要自行重启共享服务改provider |

明确区分宿主MCP接入、网络交付、Mac执行器、Jev决策和目标后验，报告实际返回的哪一层错误。遇到任意真实站点需求时，报告“真实站点执行适配器未接入正式MCP”，而不是继续试不存在的navigate/click工具。

## 8. 费用与报告

用户已明确取消共享服务的金额、累计次数和预算有效期拦截；[费用账本说明](metered-service.md)。不要复用旧文档里“剩余2次”或请求新付费批准。费用按返回usage记录，缺失用量单列未知；普通MCP不提供总费用查询工具，原Mac操作员可用 usage CLI。不要编造 jev.billing/jev.doctor 等不存在的工具。

建议报告：测试目标、宿主/连接方式、时间、原request_id/goal_id、goal终态、action路由、失败码/原因和实际耗时。不要上传完整账号页面、凭据、网络session header或其他AI结果；未实际读取费用时标为未获取，不猜数值。

已有真实证据：[S17接通](../artifacts/live-service/report.md)、[S18只计费](../artifacts/metered-service/report.md)。本说明书的只读在线契约核验见[核验记录](../artifacts/agent-manual/verification.json)，完整SDK示例已实测SUCCEEDED/route=jev并确认自己的会话已关闭，见[结果](../artifacts/agent-manual/sdk-result.json)。初次open遇到的BUSY也保留为[占用记录](../artifacts/agent-manual/busy-observation.json)；未关闭其他AI会话。
