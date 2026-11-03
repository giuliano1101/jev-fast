# 每台主机的本地控制台

当前控制台与协调器的私有 runtime 校验依赖 POSIX，仅支持 macOS / Unix；不能把此命令作为 Windows 本机安装步骤。Windows 执行器由本机宿主管理。

控制台仍保留在一页，管理固定 runtime 的启动、停止和状态。集中式 AI/设备准入、relay 地址、MCP 配置和 CLI 命令已移除；控制台直接调用本地生命周期模块。

```sh
npm run build
npm run control -- --runtime /absolute/private/jev-runtime --config /absolute/private/profile.json --open
```

不提供 config 是明确的离线 mock 新安装，不会把已运行的真实 profile 切成 mock。已有服务 fingerprint 不匹配会报错并保留原服务。使用 Node 24.19+；原开发 Mac 可 `. scripts/env.sh`，其他主机用自己的 Node。

控制台仅绑定 127.0.0.1，默认端口 47831，`--port 0` 可选择空闲端口。打开终端输出的完整私有链接；页面移除 URL 片段后保存到当前 sessionStorage。不要把面板代理公网。精确 Host/Origin、本地访问能力、CSP、禁缓存和 no-referrer 保留。

打开或关闭面板不自动开关执行服务；只有操作员点击启动或停止才改变意图。启动保留原选定配置和私有文件校验。停止先保存 stopped，再取消/收尾，不依赖上游模型在线，不能撤销已完成动作。

状态明确区分真实 `remote · Jev`、remote mock、本地 mock 与不可用。仅协调器 ready 不代表浏览器或 OS 权限已就绪；请用实际执行器检查。

原私有 panel 配置若带 `--admission-config`，升级后须移除此参数。不要直接覆盖正在运行的构建目录来升级；先安排维护，再使用本机已保存的 profile。Key、账本和手动 off 意图不删除。
