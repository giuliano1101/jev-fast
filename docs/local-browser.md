# 本机浏览器执行器

Windows / Mac 在各自主机运行浏览器和 Jev，不再通过公共 MCP 转到 Mac 的无头窗口。保留 LocalBrowserService 与官方 Playwright 后端的客户端适配，删除本项目的 stdio MCP 外壳、公共云连接和 setup CLI。

## 选择执行方式

| 方式 | 登录态与窗口 |
| --- | --- |
| launch | 本机独立浏览器 context，默认可见，不复用日常 profile |
| attach | 明确连接本机 Chrome / Edge 的调试端点，复用其已有 context |
| extension | 官方后端扩展连接用户选定的本机浏览器，需浏览器自身授权 |
| 原生 DesktopExecutor | 直接操作正在运行的日常 Chrome / Edge GUI |

attach 仅接受本机 loopback 调试端点或已支持的浏览器原生连接。不要把调试端口开放公网。模式选择不代表连接成功，必须 tools / 实际 snapshot 验证；缺少浏览器不静默切换主机或无头模式。

## 在宿主程序中组合

下例通过 `loadServiceProfile` 接上既有 Jev，适用于 macOS / Unix。Windows 的私有凭据不能走该 POSIX loader；应由 Windows 现有 Jev 宿主实现同一 DecisionPort，再传给 LocalBrowserService。浏览器执行器本身与 DecisionPort 注入已保留 Windows runner 回归。

```js
import {LocalBrowserService, localBackendConfig, selectBrowser,
        loadServiceProfile} from './dist/src/index.js';
const profile = await loadServiceProfile('/absolute/private/profile.json');
if (!profile.chooseAction) throw new Error('REAL_JEV_NOT_CONFIGURED');
const decisionPort = {
  async status() {
    const h = await profile.health();
    return {...h, ready: h.provider === 'jev' &&
      h.remoteReachable === true && h.routeCompatible === true};
  },
  choose: (args, signal) => profile.chooseAction('a', args, signal),
  close: async () => {}
};
const browser = new LocalBrowserService({
  stateDir: '/absolute/private/browser-state',
  backend: localBackendConfig({
    mode: 'attach', browser: selectBrowser(),
    stateDir: '/absolute/private/browser-state',
    endpoint: 'http://127.0.0.1:9222'
  }),
  decision: decisionPort
});
try {
  const available = await browser.tools();
  const snapshot = await browser.observe({tool: 'browser_snapshot'});
  // 按 available 的真实 schema 与 snapshot 生成候选：await browser.act({...});
} finally {
  await browser.close();
}
```

`decision` 是宿主注入的本机决策端口，不要求公共服务。`status()` 返回 `{ready: boolean,...}`，`choose(args,signal)` 返回经本机 Jev 接入校验的 ChoiceResponse，`close()` 收尾该端口。宿主负责在此处接上自己的配置，不能把“接口已安装”当成真实决策已就绪。

`act` 参数保留 `idempotency_key`、task、state、actions；候选形如 `{id,tool,arguments,description}`。选择一个候选后在本机执行。只读 observe 接受严格白名单观察参数，点击/导航等走 act；不能用 observe 绕过策略执行任意 JS。

同一 stateDir 有持久 owner 和 journal，不能通过换目录重试 UNKNOWN。不同物理设备使用自己的状态目录；关闭借用 CDP/扩展后端与明确关闭页面不同，接入后必须在实际浏览器核对生命周期行为。

离线 CI 只验证 runner 上的浏览器和决策桩；不能代替用户 Windows 现有登录态/扩展或真实 Jev 的验收。保留[历史 Windows 本机浏览器报告](reports/2026-11-02-local-browser-uptime.md)。
