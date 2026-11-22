# Delta Browser Use 中央实测

此项测试在 Action Worker **可信 Linux Runner** 中执行。使用仓库锁文件指定的 `@playwright/mcp@0.0.80`、Runner 自带的 Chrome/Chromium 和本机临时 HTTP 页面，**不访问互联网网站、用户 Profile、密钥或真实会话**。

当前覆盖：MCP stdio 初始化与工具发现、真实 Chromium 启动、导航、输入、点击、DOM 结果核查、独立 MCP 进程间浏览器存储隔离、关闭一个客户端后另一客户端仍可工作。测试工作目录和浏览器配置均为临时目录，进程最终销毁。没有 Chrome/Chromium 或工具缺失时失败，不做假成功或静默跳过。

范围边界：这是 **Playwright MCP 服务端的真实浏览器集成测试**，不是 Delta 桌面 UI 手动启用流程、Cordis SessionResources 跨 Session 的端到端测试，也不等同 macOS GUI 实测；这些仍需补充。Windows 打包及运行测试仍在现有中央 Windows 作业执行。性能冒烟沿用本测试包中的 `performance-smoke.mjs`，未建立有统计依据的延迟回归阈值。

此外，Action Worker 提供只读 macOS Runner 作业 `delta-macos-smoke.yml`，由每周计划和受信任的测试代码主分支变更自动触发。该作业从 Delta 公共 main 固定检出当前提交，执行冻结安装、Host/桌面构建以及真实 Chromium MCP 无头测试；不请求签名密钥、用户配置或外网业务站点。**仅当对应 macOS Actions 执行结果成功时**才标记 macOS 自动验收通过。macOS 桌面 GUI 权限交互仍需单独验收。
