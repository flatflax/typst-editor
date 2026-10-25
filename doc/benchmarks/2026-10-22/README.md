# 2026-10-22/23 预览实验原始观察

2026-10-23 文档复核时，从 `src-tauri/target/preview-benchmark/` 保存的既有小型 JSON 产物。**本次没有重新运行实验。** 保留原始字节及 SHA-256，来源路径和修改时间见 [provenance.json](provenance.json)。

| 文件 | 现有内容 | 范围与缺口 |
|---|---|---|
| [backend.json](backend.json) | 81 项观察：14/40/120 sections，各 start/middle/end 位置 9 次；实际 5/14/40 页 | 源码同步、编译、merged/按页 SVG、3 个范围几何、序列化及响应大小；不是 Tauri 提交到屏幕显示 |
| [browser.json](browser.json) | 浏览器版本 155.0.4283.62；merged/paged 各 9 项重放观察 | 真实 SVG 的浏览器重放，含解析、提交、双 rAF 代理与节点保留；不经过实际 Tauri IPC |
| [tinymist.json](tinymist.json) | 同版本浏览器中 9 项观察及一次初始记录 | 文件写入到接收/绘制机会的计时，起点与本项目重放不同；缺少固定源码/配置/构建版本，不能作为直接整体速度比较 |

这些文件没有完整的构建 revision、原始文档哈希、机器/电源配置和测量环境清单。source_mtime 仅是文件最后修改时间，不是完整执行时间证明；本次归档日也不是测量日。不得补填未知字段或把当前 HEAD 当作当时的构建版本。

较大的 `browser-frames.json` 与截图没有复制；复现脚本入口及解释见 [性能分析](../../preview-performance.md#reproducible-entry-points-and-artifacts)。原始生成目录可能被清理或重跑，不能再依赖其中同名 `.typ` 始终保持测量时内容。

从 JSON 计算中位数时，每个规模的后端统计合并三种位置共 27 个样本；它适合描述已有观察，不代表每个位置相同。浏览器两个模式各 9 个样本，不将少量样本写成稳定 p95。正式评估须补环境清单和同输入、同计时起点的重测。
