> 历史环境快照（2026-10-30），不是当前权限或接口状态。当前版本见[快速开始](quickstart-agent.md)。

# 开发环境（2026-10-30，Asia/Shanghai）

实际检查：Mac mini / Apple M4 / 16 GB RAM，macOS 27.0.1 (26A434)，arm64。交接包假设的 M4 Pro 64 GB 与本机不同，所有性能结果须使用实际环境。

工作目录 `/Users/yubinai/Documents/jev` 初始为空，没有 Git 仓库、历史代码或项目级 AGENTS.md；使用用户在会话提供的工程技能要求。此目录本身是新项目隔离目录，无已有分支需要保护。

Node.js v24.19.0 来自 Codex 本机 runtime；系统 PATH 中没有可用 node，原 npm wrapper 指向不存在的 node。没有修改全局配置。开发使用下列项目外只读 runtime：

```
/Users/yubinai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
/Users/yubinai/.local/lib/npm/package/bin/npm-cli.js
```

本机安装 Chrome，且存在 Playwright 测试浏览器缓存。本项目仅创建临时 browser context，不连接日常用户 profile。最终实际 browser 版本与锁文件 hash 由 benchmark manifest 自动记录。

未申请 Accessibility/屏幕录制权限，未读取 API 密钥，未访问真实业务页面。依赖安装需要访问 npm registry；运行 fixture 和 mock 测试不需要外网。
