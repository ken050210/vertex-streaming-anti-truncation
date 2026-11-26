# 项目协作约定

## 用户问题的回归验证

- 修复用户报告的问题时，从用户实际使用的入口复现。保留会影响结果的条件，例如浏览器使用的 HTTP 地址、酒馆实际发送的字段、响应流被取消的时机。缺少用户现场信息时，说明本地复现覆盖了哪种情况。
- 让同一个回归用例在修复前因用户报告的症状失败，再在修复后通过。断言用户能看到的最终结果。涉及保存并应用时，同时验证运行状态和刷新后的配置。
- 将可稳定复现的路径加入 push 和 pull request 的 CI。测试使用临时配置、测试凭据和本地上游响应，保留引发故障的真实组件。交付时说明哪些步骤会在 CI 重跑，哪些仅做了人工或真实服务验证。

网关控制台的浏览器回归位于 `test/browser/`。先在仓库根目录运行 `npm ci --ignore-scripts`，再进入 `test/browser/` 运行 `npm ci --ignore-scripts`、`npx playwright-core install --only-shell chromium` 和 `npm test`。Linux CI 安装浏览器时同时传入 `--with-deps`。
