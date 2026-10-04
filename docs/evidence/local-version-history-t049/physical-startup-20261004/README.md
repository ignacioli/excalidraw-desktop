# M5 Pro物理基线startup-idle（2026-10-04）

**最新结果：修正构建后的同项复验PASS（physical diagnostic）。** [原始复验报告](corrected/startup-idle.json)包含10/10 editable启动与61个idle样本，启动P95 1769.799375ms、idle进程树RSS P95 315113472bytes；[binding](corrected/binding.json)绑定custom-protocol corrected binary。样本数、timeout和断言未变。这里只完成baseline startup-idle，不预支candidate/配对/其余workload，也不声明VM或release结果。

**首次结果：INVALID / `not_evaluated`，准备错误已定位并在上述复验消除。** 不代表产品性能回归；不把60个空闲资源样本当作editable场景有效测量。

- 固定baseline：`babc027d64c2c50e6922482b416ef1099ea9d07e`，物理M5 Pro / 48GiB / macOS26.6.2。VM已由owner明确从本轮范围撤销。
- 有效启动0/10；第1次process-alive为46.05ms，但15秒内无ready.json；idle阶段也未证明editable readiness。原始[报告](startup-idle.json)、[身份与命令](binding.json)、[原始日志压缩](runner.log.gz)和exit-code保留。
- 本轮raw Cargo准备命令缺少Tauri custom-protocol；实际tauri build输出为`cargo:dev=true`，baseline配置指向`http://localhost:1420`。构建过的dist没有被这份dev-mode binary消费，不能当作离线内嵌前端测量。此结论仅归因本次新binary，不反推2026-09-29旧失败。
- 针对性修正：用项目Tauri CLI的no-bundle测试构建流程，分别保留原invalid binary、修正binary/hash与mode证据；不改工作负载、timeout、样本数或断言。没有原样自动重试。

双方runner的差异仅新增binary provenance、optional报告schema与CPU表达式换行；工作负载、seed、采样窗口、计时起点、统计与预算未变。原baseline JSON不含binary字段，身份由独立binding补充，不改写原报告。candidate build commit与后续仅文档commit分别记录，不伪装成同一次构建。
