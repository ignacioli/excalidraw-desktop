# 候选common性能binary准备（2026-10-04）

当前有效产物见[corrected binding](corrected-binding.json)：Tauri CLI no-bundle / e2e-harness、custom-protocol、dev=false与内嵌前端已确认；用途仅startup/canvas/soak，不是production包，也不具备History专项frontend flag资格。构建源码`eb961ca`与之后仅文档/证据HEAD分别记录，源码等价已核实。

原[binding](binding.json)与日志保留：首次raw Cargo虽然编译成功，却为devUrl模式，不能用于离线性能；原binary另存invalid-dev-mode。最初过宽的文档guard中止及wrapper EPERM见[incident](guard-incident.json)，不写成产品失败。corrected CLI使用独立target，没有改变sealed production `.app`；ignored dist正常重建。

构建不产生性能PASS；当前candidate工作负载尚未运行。日志以gzip保留原始字节。
