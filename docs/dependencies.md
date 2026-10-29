# 固定直接依赖

| 包 | 精确版本 | 许可 |
|---|---|---|
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| playwright | 1.61.1 | Apache-2.0 |
| zod | 4.6.7 | MIT |
| @types/node | 24.10.0 | MIT |
| eslint | 9.39.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| typescript-eslint | 8.46.4 | MIT |

安装使用 `--ignore-scripts`；完整传递依赖与 integrity 见 package-lock.json。开发中 npm audit 发现 Zod <4.6.6 的高危内存耗尽问题，已更新到 4.6.7；最终 audit 结果写入验收产物。

不使用 TypeSafe SDK；直接 fetch 实现单层受预算控制的重试。Node 原生 test runner，无额外测试框架。