# 开发与验证

当前支持的完整测试环境为 macOS、Node.js 24+、npm 与独立 Playwright Chromium。先按 README 安装依赖；CI 使用 macOS，并且只运行离线/本机合成测试。

提交前运行：

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:safety
```

修改动作执行、预算、超时、幂等或结果判断时，先补针对性失败回归，再修复。不要通过跳过测试、放松阈值或重放 UNKNOWN 动作隐藏失败。

`artifacts/` 中已提交的目录是阶段证据。新的评测使用独立目录与 seed，记录源码/执行文件 hash、全部启动任务、失败和费用；不要覆盖旧结果。`npm run bench:mock` 可能更新 mock 产物，提交前检查差异。

付费实验不属于默认测试。仅在用户明确授权的预算与时间窗口内，使用本机隐藏输入提供密钥。CI、issue、PR、源码和日志不得包含密钥。不要删除预算账本重置额度。

提交说明应描述问题、行为变化、验证结果和适用边界。涉及结果统计时同时报告成功率与条件性耗时，不只挑选成功任务宣称普遍加速。

本仓库当前为私有阶段交付，尚未授予开源许可证；`package.json` 使用 `UNLICENSED`。第三方依赖按其自身许可证使用。
