# Chrome 官方直连执行器

| 情况 | 路径 |
| --- | --- |
| 个人登录态、当前 Chrome 窗口 | 原生 `openDesktopSession`，AX / 键鼠 / 窄窗口截图 |
| 公开站点、无个人登录态依赖 | `openBrowserSession` + `BrowserWorkflow`，直接 Playwright 库和独立本机 Chrome |
| 受阻 | 同路径只读核查或补齐；仍不支持则请用户操作 |

没有 MCP、GUI CLI、网关、远程 CDP、扩展 relay 或第三方模型接入。独立会话不复制日常 profile。默认无头；需要可见窗口时设 `headless:false`，不能把无头验收写成有头。

导航、历史、新页、切页、正文滚动及 click/fill/select/press 已封装。可见控件来自新鲜 DOM 节点，模型不输出 selector、坐标或 JavaScript；离屏摘要仅用于滚动揭示，不把隐藏控件变为可操作。

点击前注册真实 Chrome download 事件，保存 Chrome 已下载字节，独立核对图片格式/解码/哈希和下载历史。只读布局等待、观察过渡重试和等价 URL 编码处理不重放输入。

[连续流程 API](../skills/jev-direct/references/browser-workflows.md)。复杂 iframe/canvas/任意 shadow DOM/上传尚无通用封装；下载历史有专门只读导出。历史 LocalBrowserService/extension/MCP 后端仅保留追溯，不作为当前安装路线。
