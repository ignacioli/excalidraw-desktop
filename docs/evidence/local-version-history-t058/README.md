# T058 原生入口验证

## 最新状态：PASS（2026-09-28）

最终 collection `final-pass-002/` 绑定产品提交 `28854d5ef75c87f4aafb778ea03586f026061a7b`，macOS 原生入口验证 13/13 项 PASS。环境为 macOS 26.6.2、arm64、显示 backing scale 2。验证覆盖归档的 package manifest、候选 `.app` 身份与来源、T023b 隔离 profile、原生 Version History 菜单层级/文案/可用状态、1280×760 窗口、菜单路由，以及正常打开 fixture 未改变。manifest 由构建后包检查生成，本轮没有运行独立的 `seal` 命令。

- 候选 `.app` artifact SHA-256：`82fc45410b871b5142cc9a8e70dd76a7d7fd22c56cfcba23d8e5de9b10febfb0`。
- 该候选包绑定的 HF-2 manifest：[`docs/design/desktop-shell/hf-2/manifest.json`](../../design/desktop-shell/hf-2/manifest.json)，SHA-256 `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`。
- T048 已批准高保真设计 manifest：[`docs/design/local-version-history/high-fi/t048/manifest.json`](../../design/local-version-history/high-fi/t048/manifest.json)，SHA-256 `7e50c65e24b66df8eb0a2840e2bf7b714a26ebfbb0f6dc8f8e423eeb819dd8dc`。
- 原生报告：[`final-pass-002/collection/native-report.json`](final-pass-002/collection/native-report.json)。采集器、路由确认与版本历史入口报告分别在同目录；包清单、最终计划、binding、fixture manifest 和本次声明的启动文档均一并归档。

## 尚未关闭的验收

- **T048 人工视觉验收仍 PENDING。** [`history-plan/`](history-plan/) 归档了 12 个 HISTORY 采集目标，其中六个绑定已批准 T048 高保真 frame；均为 `operator-assisted`。此目录没有 T048 截图 collection 或人类视觉 verdict。
- **T049 正式性能测量仍 PENDING。** 上述采集计划中的 `operator-assisted` 只表示视觉采集准备方式，不是性能测量或验收结果。
- 旧版 T047 package PASS 保存在 [`../local-version-history-t047/`](../local-version-history-t047/)；它绑定不同产品包，不能替代本次 T058 结果或关闭 T048。

## 历史失败尝试

`attempts/diagnostic-001/` 单独保留早期 binding、计划和诊断报告，报告结果为 FAIL，**不属于最终 collection**。初次生成 binding 时，native-entrypoint profile 尚未完成 materialization，摘要使用了解析前的 profile 状态；随后诊断运行又因另一已安装实例仍在运行，触发 Tauri single-instance 行为，系统事件未能确认候选 app 的原生菜单。退出该实例后，重新准备隔离 profile 并按解析后的 profile 摘要生成 binding，得到上方独立的 `final-pass-002` PASS。原失败报告未改写或计入 PASS。

## 证据文件

- `package-manifest.json`：本次 production `.app` 的签封 package manifest。
- `final-pass-002/`：最终 T058 原生入口验证的原始计划、binding、collection 和所声明的启动文档。
- `attempts/diagnostic-001/`：早期失败尝试的原始诊断、binding 和计划。
- `history-plan/`：T048 History 专属 12 项采集计划与 fixture manifest；尚无采集结果。
