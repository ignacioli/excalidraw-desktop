# T048 HISTORY-01 capture after window lookup repair

**当前结果：capture integrity PASS；独立视觉 review FAIL。** 本目录保存 2026-09-29 生成的原始 collection。采集只证明声明的包、窗口、隔离及图像完整性，不证明画面符合批准设计。两项组件样式偏差及证据见 [独立报告](history01-review.md)。

## Binding

- Product commit: `9c1e6a37a10b72ec8213af9d3e45d81667ad73c7`
- Production package: `Excalidraw.app`, bundle ID `excalidraw-desktop`, version `0.3.0`
- Package SHA-256: `2420a8a8f5af8253c7ebcd90747e8e0430c1a7cee9d65585322c7e9e5e6aeae3`
- macOS: `26.6.2`, `arm64`; display backing scale `2`
- Window: logical `1280 × 760`, frontmost, two stable samples; captured once at `2026-09-29T09:15:51.135Z`
- Collection digest: `a4db47bdeb17c503b84ca214a8bd23d41878a22eccf5181ce095e40bf0447620`
- Normalized `actual.png` SHA-256: `fc16509157d6b55a3212795bed95dbc6420236113757be40606301fd672a6423`
- Guard attempt: `2791496a-c642-408e-a905-63ac477b5796`
- Validator: `854c48e`

Collection 从 `/private/tmp/t048-window-repair-20260929/collection-HISTORY-01/` 按原字节归档，`diff -qr` 与 `actual.png` digest 均一致。原始报告记录 `HISTORY-01-capture-integrity` 为 `PASS`，只采集一次，使用 `lanczos3-srgb-v1` 归一化，backend app-data isolation 为 `PASS`；没有应用状态 claim，也不声称 WebKit filesystem isolation。

## Review status

独立 reviewer 对照批准的 `Default History · Light · 360 px` 画板，判定 Mark 按钮及 Restore 主色两项样式偏差；`history01-review.md` 由该 reviewer 独立维护。修复后的新包必须重新采集与复审；当前没有产品负责人最终接受决定。

此前同包尝试在截图前报 `owned-window lookup failed: expected exactly one CoreGraphics owned window`，保留于 [postfix-003](../../local-version-history-t058/postfix-003/README.md)。本次只在 capture integrity 范围越过该阻塞，没有覆盖旧记录或把视觉结果改为通过。
