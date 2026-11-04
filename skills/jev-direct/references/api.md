# 本地模块 API

操作本机 App 和 Chrome 默认使用 Jev 官方直连执行器，不使用 Computer Use、MCP 或 CLI。以下 API 是唯一默认 GUI 控制路径；准备、观察、截图与故障核查也不改走 Computer Use。执行器暂不支持时补齐该路径或告知用户人工操作，不自动切换控制通道。

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
- `UNKNOWN` / SURFACE_QUARANTINED：保留步骤库、物理日志、租约证据，只读核对。不要删除数据库或锁文件来“恢复”。可信核对可使用导出的 FileExecutionJournal 协议；不是模型自己宣布解除。

`intent` 是稳定语义参数，禁止同键改意图。`project` / `candidates` / `verify` 是可信宿主回调，verify 只能读取。默认 minConfidence=0.90、单步 timeoutMs=20000、异步后验只读 settleMs=1500；这些是可调请求/稳定等待期限，不是任务总时长或总次数限制。没有新增全局付费或动作数量上限。

显式测试额度示例：

```js
const budget = new TestBudget({directory:'/absolute/private/campaign-budget',limitUsd:0.5});
const session = await openDesktopSession({app:'com.apple.TextEdit',runtimeOptions:{budget}});
try {/* 所有该活动的 runtime/session 都传同一个 budget；不可另建目录绕过 */}
finally {await session.close();console.log(budget.summary());budget.close();}
```

每个请求按当前固定模型官方默认 64k 上下文上界预留，已知 usage 按存储单价结算，未知继续占用全额预留；保留跨进程事务与重启账本。费用是本地计量估算，不是官方账单审计。既有常规调用默认 usage-only；测试额度不自动续用为未来授权。
