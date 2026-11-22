# Delta Browser Use 中央实测

此项测试在 Action Worker **可信 Linux Runner** 中执行。使用仓库锁文件指定的 `@playwright/mcp@0.0.80`、Runner 自带的 Chrome/Chromium 和本机临时 HTTP 页面，**不访问互联网网站、用户 Profile、密钥或真实会话**。

当前覆盖：MCP stdio 初始化与工具发现、真实 Chromium 启动、导航、输入、点击、DOM 结果核查、独立 MCP 进程间浏览器存储隔离、关闭一个客户端后另一客户端仍可工作。测试工作目录和浏览器配置均为临时目录，进程最终销毁。没有 Chrome/Chromium 或工具缺失时失败，不做假成功或静默跳过。

范围边界：这是 **Playwright MCP 服务端的真实浏览器集成测试**，不是 Delta 桌面 UI 手动启用流程、Cordis SessionResources 跨 Session 的端到端测试，也不等同 macOS GUI 实测；这些仍需补充。Windows 打包及运行测试仍在现有中央 Windows 作业执行。性能冒烟沿用本测试包中的 `performance-smoke.mjs`，未建立有统计依据的延迟回归阈值。
