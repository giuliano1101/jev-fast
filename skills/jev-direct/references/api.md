# 本地模块 API

本机 App 和 Chrome 在适用且就绪时优先使用下列 Jev 官方直连 API，观察、准备、截图与核验优先复用同一执行器。不支持或已确认派发前失败且无未决效果时，可在任务授权内选择后备工具并说明原因；UNKNOWN 不跨工具重放。用户当次明确指定的工具优先。

宿主模块统一导入：

```js
import {
  openDesktopSession, nativeCandidate,
  openBrowserSession, BrowserWorkflow, browserCandidate, browserProjection,
  createJevRuntime, TestBudget,
} from {{JEV_MODULE_JSON}};
```

导入不会启动服务、浏览器或物理输入。`openDesktopSession` 复用原生 helper；第一次观察才读取 App。`openBrowserSession` 启动自己拥有的独立 Chrome（默认无头），不复制 cookie，也不附着日常资料。需要当前登录态时使用原生路径。

## Chrome / 本机 App 原生操作

先读取真实状态，确认目标窗口与任务一致；候选回调每次都用其传入的新观察。以下是针对真实、唯一、已授权按钮的示例，按钮名应替换成当次观察值：

```js
const session = await openDesktopSession({app:'com.google.Chrome'});
try {
  const state = await session.observe(); // 检查本任务窗口及真实控件
  const result = await session.step({
    goalId:'stable-task-id', idempotencyKey:'task-step-001',
    intent:{action:'open-authorized-details'},
    task:'Open the visible Details panel once.',
    project:s => ({window:s.window.title,
      details:s.elements.filter(e=>e.role==='AXButton'&&e.label==='Details')
        .map(e=>({label:e.label,enabled:e.enabled,value:e.value}))}),
    candidates:s => [nativeCandidate(s,{
      id:'open_details', description:'Click the observed Details button',
      method:'desktop_click', label:'Details', role:'AXButton',
    })],
    verify:s => s.elements.some(e=>e.label==='Expected details heading'),
  });
  // result.status 必须是 VERIFIED；否则按 code 核查，不能改键重放。
} finally {await session.close();}
```

不把整棵 AX 树或其他窗口发给模型。`project` 不含观察/元素编号，且含足以判断前提和已完成状态的语义字段。Session 重新观察后若语义投影或目标 guard 改变，返回 STALE，物理输入次数为零。

`nativeCandidate` 支持原生点击、文本输入/赋值、命名组合键、滚动、拖拽、已观察动作、App 激活/启动和打开本地文档；真实 AX 是否支持某操作须现场确认。窗口级键操作省略 label/role，提供 `params:{key:'cmd+s'}`。字段赋值使用实际可赋值控件和 `params:{value:'宿主提供的内容'}`。截图按需：`await session.adapter.screenshot('/absolute/private/output.png')`。

初次需打开 App/文档或创建专用测试窗口时，宿主可使用导出的 `DesktopExecutor` 做有明确授权的准备；标明是宿主准备，不冒称模型选择。实际候选选择仍走 Session。不要让多个 Session 绕过默认 `native-session` 目录争抢同一主机。

## 独立网页操作

```js
const session = await openBrowserSession({url:'https://用户指定的网站', headless:true});
try {
  const observed = await session.observe();
  const result = await session.step({
    goalId:'web-task', idempotencyKey:'web-task-fill-city',
    intent:{field:'City',value:'Kyoto'}, task:'Fill City with Kyoto.',
    project:browserProjection,
    candidates:s => [browserCandidate(s,{
      id:'fill_city', description:'Fill the observed City field with the requested city',
      method:'fill', label:'City', params:{value:'Kyoto'},
    })],
    verify:s => s.elements.some(e=>e.label==='City'&&e.value==='Kyoto'),
  });
} finally {await session.close();}
```

方法 `click`、`fill`、`select`、`press` 分别支持按钮/勾选/链接、宿主文本、已观察下拉值、命名按键；使用 `params:{value}` 或 `params:{key}`。目标来自当前 DOM 节点引用，模型不提供 selector、坐标或 JavaScript。观察仅列当前视口的常见 HTML/ARIA 控件；password、一次性验证码和信用卡自动填充字段的值会隐藏。复杂 iframe、shadow DOM、canvas、文件上传和弹窗尚无通用封装，必要时改用本机原生路径并说明边界。

连续操作使用 [BrowserWorkflow](browser-workflows.md) 减少宿主重写和调度空档。`browserCandidate` 还支持 `navigate`、`back`、`forward`、`newTab`、`switchTab`、`scroll`；它们同样交给 Session 选择、绑定、记账与核验。`target:{name,dom_id,type,value,href,role,label}` 按当前观察精确匹配且必须唯一；不要猜测不存在的控件属性。

`browserProjection` 包含可见文本和控件值；对带敏感数据的站点，应提供更小的任务投影并遵守已有传输授权。不能把默认脱敏当作任意页面内容都可上传的保证。

## 多问题与纯选择

```js
const jev = createJevRuntime();
try {
  const result = await jev.ask({
    state:{status:'ready'},
    questions:{
      operation:{type:'choice',instructions:'Which operation is appropriate?',
        criteria:{act:'State is ready for the authorized action',wait:'State is still loading'}},
      ready:{type:'noul',instructions:'Is status ready?'},
    },
  });
  // 一个 HTTP 请求，多项独立判断。宿主只使用相关答案，不批量执行所有返回项。
} finally {jev.close();}
```

当前 `ask` 公开 Choice 和 Noul；未实现的类型不能冒充可用。每个 Choice 验证选项集合、概率、最高项及置信度；模型固定 1.14。单一动作选择可用 `choose({idempotency_key,task,state,actions:[{id,description}],timeout_ms})`；该方法只记模型用量，不执行动作，也不提供物理幂等，真实输入优先 Session。

## Session 状态、超时与预算

- `VERIFIED`：执行一次并经宿主核验；同键重调返回 cached，不再次调用模型/输入。
- `REJECTED` / `STALE`：没有物理输入；由宿主读状态判断后续步骤。
- `POSTCONDITION_FAILED`：输入已确认，后验没有满足；禁止把同一步换键重放。
- `FAILED` + `dispatch:'not-executed'`：官方驱动在提交本次输入前拒绝（例如 `AMBIGUOUS_APP`）。账本已按 rejected 结束，同键不重放；换新键前先消除拒绝原因。
- `UNKNOWN` / `SURFACE_QUARANTINED`：输入可能已经发出，或进程停在提交窗口。保留 `steps.sqlite`、`physical/executions.json` 和租约。不要删库、改 SQLite、清锁、换目录或自动重放。只调用下面的桌面核查入口。单独调用 `FileExecutionJournal.reconcile` 只会清 pending，不会解除 steps 隔离。

## 桌面隔离核查与恢复

所有原生 Session 仍共用默认目录和 `physical-host` 租约。一个未决步骤会挡住后续无关的桌面任务。恢复入口不执行动作、不重放 UNKNOWN、不删除账本，也不移走 `owner.lock`。模型选择、标题或 URL 没变、旧 observation id，都不能当作“按键没有发出”。

```js
import {inspectDesktopSession, reconcileDesktopSession, DESKTOP_PRE_DISPATCH_REJECTIONS}
  from {{JEV_MODULE_JSON}};

const before = inspectDesktopSession(); // 默认同 native-session；不抢锁
// before.status: CLEAR | QUARANTINED | BUSY | UNREADABLE
// before.lock.owner 只是 pid 存活性提示。dead 也不许删锁或删账本。
// before.steps[].code / before.matchingResolutions[] 用来核对旧结论。
```

`BUSY`：锁还在。先确认锁里的 pid 没有对应进程，备份整个会话目录（`steps.sqlite`、`-wal`、`-shm`、`physical/executions.json`、`physical/owner.lock`），再只把确认属于死进程的 `owner.lock` 移到备份里。不要删除 `executions.json` 或步骤库。活着的 owner 会让 `reconcileDesktopSession` 返回 `JOURNAL_BUSY`。

`QUARANTINED`：先只读观察，记下新的 `observation_id`，然后关闭 Session 释放锁。不要在 Session 仍打开时调用恢复，否则返回 `JOURNAL_BUSY`。

```js
const session = await openDesktopSession({app:'com.google.Chrome'});
let observationId;
try { observationId = (await session.observe()).observation_id; }
finally { await session.close(); }
const result = await reconcileDesktopSession({
  verify: (pending, context) => {
    const preDispatch = context.step?.status === 'PLANNING' || context.step?.phase === 'armed'
      || DESKTOP_PRE_DISPATCH_REJECTIONS.includes(context.step?.code);
    if (!preDispatch) throw Error('HUMAN_REVIEW_REQUIRED');
    return {
      eventId: pending.eventId, leaseKey: pending.leaseKey, actionId: pending.actionId,
      observationId, evidenceId: 'operator-read-1', verdict: 'not-executed', basis: 'pre-dispatch',
    };
  },
});
```

这段只自动放行有持久派发前证据的记录。其它记录让本次调用失败并不改账本；人工确认后再显式返回 `verdict:'unconfirmed', basis:'human-confirmed'`，或在账本已记录 `input_submitted` 时返回 `executed`。`verify` 只能读 `pending`、`context` 和刚才的观察。不要在里面调用模型，也不要调用 `execute`。`context.journalKind` 为 `partial` 表示账本先前已经 reconcile、步骤仍是 UNKNOWN。

| 能写的结论 | 条件 |
| --- | --- |
| `not-executed` + `pre-dispatch` | 步骤仍是 `PLANNING` / `armed`，或 `code` 属于 `DESKTOP_PRE_DISPATCH_REJECTIONS`。`AMBIGUOUS_APP` 属于这一组：当前 Mac 驱动在解析 App 时抛出，发生在按键投递之前。 |
| `executed` + `observed-effect` 或 `human-confirmed` | 账本已经记下 `input_submitted`（resolution `executed`，或先前的 reconciled verdict 就是 `executed`），并且这次观察是新的。 |
| `unconfirmed` + `human-confirmed` | 无法证明未派发，也不能证明按键已生效。这只表示人工确认后放行后续任务，不重放原步骤，也不宣称按键没发生。 |

下列证明一律拒绝，隔离保持：重复 `pending.observationId`、重复旧 proof 的 observation id、错误 `actionId`、用标题/URL 未变充当 `not-executed`、用人工确认充当 `not-executed`、对未确认派发写 `executed`、超时后才返回的 proof。拒绝原因分别是 `INVALID_RECONCILIATION`、`NOT_EXECUTED_UNPROVEN`、`EXECUTED_UNPROVEN`、`HUMAN_CONFIRMATION_REQUIRED`、`DEADLINE`。

成功后 `inspectDesktopSession()` 为 `CLEAR`。同一 `goalId` + `idempotencyKey` 返回缓存且 `replayed:false`。新的幂等键才可以进入下一步。再调用一次恢复入口是 `CLEAR` / `NO_PENDING_ACTION`，不会改账本。若仍有 pending 或 UNKNOWN/PLANNING/EXECUTING 步骤，新的 `step()` 继续 `SURFACE_QUARANTINED`。

2026-11-07 的实际形状：创中心 `desktop_press_key` `cmd+l` 得到 `UNKNOWN` / `AMBIGUOUS_APP`，进程退出后留下死 pid 的 `owner.lock`。操作员只调用了 `FileExecutionJournal.reconcile`，verdict 用了 `not-executed`，依据是当时标题未变。结果是 journal pending 变为 0，`openDesktopSession` 和 `observe` 恢复，但 `steps.sqlite` 仍是 UNKNOWN，新步骤仍被 `SURFACE_QUARANTINED`。处理时先按上面的死锁备份流程移锁，再 `inspect`。只有步骤 code 仍是 `AMBIGUOUS_APP` 这类派发前拒绝时，才可以用一次新的 observation id 和 `basis:'pre-dispatch'` 写 `not-executed`。不要复用旧的“标题未变”observation。如果 code 不是派发前拒绝，保持隔离，直到人工写出 `unconfirmed`。

`intent` 是稳定语义参数，禁止同键改意图。`project` / `candidates` / `verify` 是可信宿主回调，verify 只能读取。默认 minConfidence=0.90、单步 timeoutMs=20000、异步后验只读 settleMs=1500；这些是可调请求/稳定等待期限，不是任务总时长或总次数限制。没有新增全局付费或动作数量上限。

显式测试额度示例：

```js
const budget = new TestBudget({directory:'/absolute/private/campaign-budget',limitUsd:0.5});
const session = await openDesktopSession({app:'com.apple.TextEdit',runtimeOptions:{budget}});
try {/* 所有该活动的 runtime/session 都传同一个 budget；不可另建目录绕过 */}
finally {await session.close();console.log(budget.summary());budget.close();}
```

每个请求按当前固定模型官方默认 64k 上下文上界预留，已知 usage 按存储单价结算，未知继续占用全额预留；保留跨进程事务与重启账本。费用是本地计量估算，不是官方账单审计。既有常规调用默认 usage-only；测试额度不自动续用为未来授权。
