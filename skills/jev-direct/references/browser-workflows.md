# 连续网页操作：复用宿主，保留逐步 Jev 决策

适用于独立网页 Session。依赖用户日常登录态时仍使用原生 Session；不要复制个人 Chrome profile。`BrowserWorkflow` 不新增操作授权或预算。

先导入现有接口，不必为导航和下载重写 adapter：

```js
import {openBrowserSession, BrowserWorkflow, TestBudget}
  from {{JEV_MODULE_JSON}};

// 仅当本任务已有相应预算授权时传入原活动账本；不要新建账本绕开累计上限。
const budget = new TestBudget({directory:existingCampaignDirectory, limitUsd:authorizedLimit});
const session = await openBrowserSession({headless:false, runtimeOptions:{budget}});
const w = new BrowserWorkflow(session, {
  goalId:'stable-authorized-task', outputDirectory:'/absolute/private/task-output',
});
try {
  await w.run({id:'navigate', task:'Open the user-authorized page',
    method:'navigate', params:{url:authorizedUrl},
    verify:s=>s.title===expectedTitle});
  // 先观察确认真实 name。此示例字段与值须替换为任务实际值。
  const state = await w.observe();
  await w.run({id:'fill-city', task:'Fill the requested City field',
    method:'fill', target:{name:'city'}, params:{value:'Kyoto'},
    verify:s=>s.elements.some(e=>e.name==='city'&&e.value==='Kyoto')});
} finally {await w.close(); budget.close();}
```

在一个宿主内顺序 await 已确定的合法步骤，减少外层工具往返。每次 `run()` 都重新观察、单次 Jev 请求、新鲜绑定、持久幂等输入及独立后验；同键缓存会标明 `cached`，不计为新请求或新输入。未知页面先观察，遇到低置信、STALE、UNKNOWN 或后验失败会落证据并停止，交由同路径核查；不自动换键或重放。

## 已封装的方法

| 方法 | 参数与用途 |
| --- | --- |
| `run({method:'click'/'fill'/'select'/'press',...})` | `label` 或 `target:{name,dom_id,type,value,href,role,label}` 必须来自最新观察；支持 `params:{value}` / `{key}` |
| `run({method:'navigate'/'newTab',params:{url},...})` | HTTP(S)、about:blank、chrome://downloads/；执行一次 |
| `run({method:'back'/'forward',...})` | 等待 DOMContentLoaded 后独立验证终态 |
| `run({method:'switchTab',params:{tabId},...})` | `tabId` 来自当前 `state.tabs`，仅限拥有的上下文 |
| `run({method:'scroll',params:{delta,region:'main'},...})` | 绑定当前主内容区域，避免滚动侧栏；每次滚动仍请求 Jev |
| `scrollUntil({id,task,visible,target,delta,maxSteps})` | 先只读等布局稳定，再有界揭示控件；可选 `target:{label/name/...}` 用实际离屏位置判断上/下，每个滚动独立编号和核验，找不到就停 |
| `read({id,task,operation,verify,timeoutMs})` | 可信宿主只读操作和核验，允许有界等待，不算模型调用 |
| `decide({idempotency_key,task,state,actions,timeout_ms})` | 官方窄候选判断，记录真实请求；低置信不输入，不替代 GUI 的 `run()` |
| `screenshot(name)` | 用同一 adapter 保存核验截图 |
| `close()` / `export()` | 关闭拥有的资源；导出 JSON/CSV，不删账本 |

## 下载与独立核验

Workflow 在 Session 启动后、点击下载前注册真实 Chrome download 事件。页面内的下载链接仍通过 `run({method:'click',...})`。`w.adapter.downloads` 记录 STARTED / SAVED / FAILED、真实 URL、文件路径、字节及哈希；保存使用 Chrome 已下载的字节，不向宿主另发 HTTP 下载请求。

点击下载的 verify 检查新事件的 SAVED 状态；在下一步前用 `await w.adapter.verifyImage(path)` 读取实际保存文件并在同一 Chrome 解码，得到格式、尺寸、字节及 SHA-256。保留来源页作者和许可，用 `readDocument({selector,maxCharacters})` 读取必要全文。`readDocument` 是只读宿主接口，selector 由可信宿主提供，不由 Jev 输出。

通过 Jev `newTab` 打开 chrome://downloads/ 后，`await w.adapter.downloadHistory()` 只读导出完成记录，已处理 BigInt；对照 URL、字节和完成状态。该专用只读核验支持下载历史的 shadow DOM，不代表所有 shadow DOM 控件均可操作。

默认语义投影只传当前目标、页面标题和不含 query 的路由，scroll / switchTab 添加相关状态；敏感页面仍须按任务缩小 `project`。密码等字段保持私密标记，输入值在宿主保留。宿主回调、描述和自行读取的正文仍须避免泄露敏感内容。

`observe()` 中 `elements` 仅含当前视口的可操作控件；`scroll_targets` 只给已渲染离屏控件的最小定位摘要，供宿主滚动揭示，不用于直接点击，也不默认发送给模型。隐藏控件不能由此变成可操作控件。滚动坐标在新观察中重新定位；绑定保持页面、查询参数语义和滚动位置检查，纯布局坐标变化不等于换目标。等价 URL 编码会规范化，真正的参数变化仍拒绝输入。

`await w.adapter.waitForLayout({timeoutMs:5000,stableMs:200})` 只读检查文档、字体和布局稳定，返回 `settled` 及耗时；`scrollUntil` 自动使用。超时不会声明成功或重新发送真实输入。页面过渡的只读 observe 另有有界重试，诊断日志保留。

## 计时与复跑

自动输出 actions.jsonl / actions.json / actions.csv、requests.jsonl / requests.json / requests.csv、downloads.json、observation-diagnostics.json。Session 每步 `result.timings` 区分观察、模型、准备、重新绑定、执行、后验观察和验证；余下日志与等待开销体现在整步墙钟，不假定为零。模型与网络无法精确分离。

公共测试题的可复用宿主为 `{{JEV_ROOT}}/direct/benchmarks/chrome-acceptance.mjs`。运行它会真实登录演示站点、填测试表单、下载图片并请求付费 Jev，只有用户明确授权这些测试及沿用对应 $0.50 历史额度时才运行。它不是一般用户任务的默认副作用。新一轮使用新的输出目录，保留先前失败尝试；不得覆盖旧 run.json。
