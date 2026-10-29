# GitHub 初始阶段基线

目标仓库：`giuliano1101/jev-fast`，保持私有，主分支 `main`。初始阶段标签 `v0.1.0-s6`。

本次将 S0–S6 源码、测试、文档、校准和正式实验结果以展开文件上传，保留历史失败证据。未上传本地 ZIP、依赖、构建目录、运行账本或 API 密钥。内容检查同时匹配本轮已知密钥和常见凭据格式，未发现匹配。

初始化补充仓库说明、贡献说明、安全边界、阶段记录、Node 24 版本提示和离线 CI。未改变正式真实评测的执行源码；其 hash 仍匹配原 manifest。测试代码仅清理了一处行末空格。

上传前本机完整复测记录在 [verification/](verification/)：静态检查、79 项单元/核心、29 项浏览器集成、40 项安全测试通过；集合间有交集，不合计为唯一用例数。GitHub 上的实际 CI 状态以 Actions 为准。

[content-manifest.json](content-manifest.json) 记录主体源码与阶段证据的路径、字节数及 SHA-256；不包含本 publication 目录本身，避免自引用。仓库初始提交 hash 可由 Git 历史查询。

CI 只使用本地合成页面和 mock，不配置 TypeSafe 密钥、不调用付费 API。Actions 固定在官方 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) 的完整提交 SHA。完整测试目前以 macOS 为支持平台。

历史文档中的本机绝对路径及“尚无 Git 仓库”是当时的可追溯环境信息，不是新机器的安装要求。新机器按根目录 README 克隆并安装。
