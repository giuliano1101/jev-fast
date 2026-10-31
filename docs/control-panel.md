# Jev 本机服务开关面板

这个面板用于开启、关闭和检查 **CLI/MCP 共用的本地协调服务**。它不需要托管 API key，默认使用离线 mock。开启不会自动执行任务或消耗模型额度；remote 模式的健康检查只查询网关健康状态。已有任务在 remote 模式下的调用仍受私有审批和持久预算约束。

## 打开面板

macOS 安装完成后可在 Finder 双击仓库根目录的 **`打开Jev控制面板.command`**。它检查 Node 24.19+、编译当前 checkout 并打开浏览器，使用默认 `/tmp/jev-<uid>` 运行目录，不自动开启协调服务。终端窗口负责运行面板，保留它即可。若已有面板占用端口，使用原面板或先退出原终端。脚本不执行依赖安装；找不到可用 Node 时可设置 `JEV_NODE` 为绝对路径。

在已安装依赖和 Chromium 的 checkout 中：

```sh
npm run build
npm run control -- --runtime /tmp/jev-operator
```

终端会打印一个 `http://127.0.0.1:端口/#...` 本机链接，在浏览器打开完整链接。片段中的随机令牌授予本次面板的操作权限，请勿分享完整链接。初次载入后页面会移除地址栏片段，并将令牌仅保存在当前标签页的 sessionStorage 中供刷新使用。新开无令牌页面需要使用终端中的完整链接。

加 `--open` 可以自动用系统浏览器打开链接；默认端口是 47831，`--port 0` 自动分配空闲端口。

原开发 Mac 的 Node/npm wrapper 不可用时，先在该 checkout 根目录运行 `. scripts/env.sh`；其他机器不要使用这份专用环境配置。

查看启动选项：

```sh
node dist/src/control/main.js --help
```

runtime 必须与 AI 的 CLI 参数和 MCP 凭据路径一致。面板不会扫描或控制其他 runtime。端口冲突时更换 `--port`，不会接管已有进程。

使用[网络 MCP 连接器](network-mcp.md)时，其 credentialFile 也必须指向这个 runtime 的 client-a.json。面板停止同一个本地协调服务后，远程任务同样受阻；云端没有重新开启本机服务的工具。连接器和 relay 独立管理，面板不负责启动它们。

## 使用开关

- **启动服务**：调用既有 `service start`，等待鉴权健康检查确认运行，重复开启不会创建第二个协调服务。
- **停止服务**：调用本地操作员 `service stop`，阻止新动作、取消目标并等待浏览器和账本收尾。已完成的物理动作不会撤销，结果不明仍保留 `UNKNOWN`。
- **刷新状态**：检查实际服务和安装环境。不可达或诊断失败不能证明进程已退出；残留锁、权限异常等需按运维手册处理。
- **接入信息**：按当前 Node、checkout 和 runtime 显示 MCP 配置与 CLI 示例。先开启服务，再让宿主启动 MCP。服务重启会轮换凭据，宿主需要重新连接。

面板会显示本地 `mock`，或远程 `remote · Jev` / `remote · 网关模拟` / `remote · provider 未知`，以及远程可达性和兼容状态。`ready` 仅代表本地协调服务可用；`remoteReachable: false` 或 `routeCompatible: false` 时应先解决远程配置问题。主接口仍只支持本地合成 fixture，无法在面板开启后直接控制任意网站或手机。

## 使用已经配置的真实 Jev

由操作员先按[CLI/MCP 手册](cross-machine-cli-mcp.md)准备好私有 remote profile 和有效授权，然后显式运行：

```sh
npm run control -- --runtime /tmp/jev-operator --config /absolute/private/profile.json
```

配置文件路径和 runtime 在面板启动时固定，网页不接受 API key、任意路径或 provider 修改。已有服务与启动 profile 不同会返回 `SERVICE_PROFILE_MISMATCH`，不会静默改用 mock。停止服务仍依赖本地操作员凭据，不依赖远程网关可用。

面板不负责启动中央网关、签发或续期 token、登记设备、批准或重置付费预算。先前实验的限时预算不会因开启服务而续期。若要更换配置，先安全停止协调服务，再退出面板，用新的参数启动；保留原账本。

## 面板与服务的生命周期

关闭浏览器标签页只关闭页面。终端按 Ctrl+C 退出面板进程，协调服务可以继续供 AI 使用。要关闭 Jev，请先点击“停止服务”，或者运行：

```sh
node dist/src/cli/index.js service stop --runtime /tmp/jev-operator --json
```

无需自动登录、开机自启或全局 agent 配置。关闭这个服务也不会禁止 AI 使用它本来拥有的 shell/CUA 等其他工具。

## 本机访问保护

控制端只绑定 `127.0.0.1`，校验精确 Host、Origin 和每次启动生成的令牌，不提供跨域权限。令牌不放进查询参数、cookie 或请求日志。页面使用 CSP、禁止缓存和 referrer；操作只映射到固定 CLI 参数，不执行网页提交的 shell。

这仍是同一 macOS 用户下的本机操作工具。它不能抵御已拥有同一用户文件/浏览器访问权限的恶意程序。不要将监听端口代理到公网，不要公开完整面板链接。残留锁、未知动作、升级与回滚见[运维手册](cross-machine-operations.md)。
