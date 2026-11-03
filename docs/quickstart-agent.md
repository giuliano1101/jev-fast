# 各主机本地接入

2026-11-04 起不再安装 Jev CLI/MCP 服务或网络连接器。每台主机运行自己的决策配置和执行器，宿主通过本地模块接入。既有私有 profile、Key 和账本不随仓库分发，也不要复制另一台机器的操作系统凭据。

## 安装

使用本机 Node 24.19+，按 README 安装依赖并构建。Mac 原生驱动另运行 `npm run desktop:build`；Windows 使用本机 PowerShell 原生驱动。浏览器及 OS 权限必须在实际执行机器验证。

## macOS / Unix 生命周期与本机调用

以下生命周期、私有 profile 加载和 Unix socket 辅助函数目前依赖 POSIX uid / mode，仅适用于 macOS / Unix。Windows 直接使用 DesktopExecutor，或使用 LocalBrowserService + 宿主提供的 DecisionPort；不能调用下例 startService/loadServiceProfile 作为 Windows 安装验收。本轮没有新增 Windows 凭据/协调器移植。

保存为 macOS / Unix 宿主程序的模块，调整为本机的真实绝对路径：

```js
import {startService, serviceHealth, inspectService, stopService,
        ipcCall, readCredential, toolDefinitions} from './dist/src/index.js';
import {join} from 'node:path';

const runtime = '/absolute/private/jev-runtime';
await startService({runtime, configFile: '/absolute/private/profile.json'});
const health = await serviceHealth(runtime);
console.log({ready: health.ready});
const credential = await readCredential(join(runtime, 'client-a.json'));
const invoke = (name, params) => ipcCall(credential, name, params);
// toolDefinitions 包含本机业务参数 schema；没有公网 wrapper 或 continuation。
console.log(toolDefinitions.map(tool => tool.name));
// 仅在操作员明确要关闭这个 runtime 时：await stopService(runtime);
// 只读安装/运行诊断：await inspectService(runtime);
```

导出的生命周期保留原 profile 匹配、启动锁、手动开关意图和未知结果规则。服务重启后重新读取本机凭据，不能一直缓存旧 token。只管理自己的 runtime；不要清理别人的会话或历史账本。

省略 configFile 是离线 mock 开发模式，不请求付费模型；不会静默把已有真实服务切成 mock。默认 mock 仅支持合成流程，不代表任意网站或 App 的真实 Jev 已配置。

本机业务接口仍包含 fixture 的六个方法、choose_action、browser_open/observe/act/close 和 host_tools/act。这些是模块/私有 IPC 方法，不是 MCP 工具服务。查看导出的 toolDefinitions 与实际 health，确认 choose_action、真实浏览器和已配置 host 是否存在。

## 真正执行的位置

- `browser_*`：该主机上的隔离 Playwright 浏览器，独立于日常 Chrome。
- 日常已登录 Chrome / Edge：本机 LocalBrowserService 的 attach/extension，或本机原生桌面驱动；见[本机浏览器](local-browser.md)。
- 已装 App：直接使用 DesktopExecutor；见[桌面手册](native-desktop.md)。
- 安卓：保留 HostService 对本机已配置 mobile backend 的客户端调用；先 tools 发现实际 schema，配置设备，不假设所有手机工具可用。

`remote` profile 指模型决策网关，不再表示由公共 MCP 把操作转到另一台电脑。每台机器自行配置已有的 Jev 决策接入；不需要为本次代码拆除新增 Key。

## 升级与旧部署

先保存原私有目录，不覆盖运行中的 dist 或删掉账本。更新依赖并构建时，编译目录会清理旧入口；已经运行的旧进程不会因此自动停止。旧部署是否停用请看[本次报告](reports/2026-11-04-per-host-core.md)，不能仅因源码文件已删除就宣布公网下线。

旧 MCP 客户端配置不再适用于新版。支持本地模块的宿主导入本项目；只支持 MCP 的 AI 客户端不能直接把模块当作 MCP URL 使用，由该主机的宿主程序集成执行器。
