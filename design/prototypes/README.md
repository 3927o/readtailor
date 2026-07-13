# ReadTailor 产品化梳理

这里保存 ReadTailor 从 0 到 1 的可交互产品原型。

## 使用原则

- 项目从 0 到 1 实现时，页面结构、产品流程、响应式布局和交互节奏主要参考主原型。
- 产品行为和数据契约仍以 PRD、contracts 与架构文档为准，不直接照搬原型中的 mock 数据和定时器逻辑。
- 0 到 1 基线完成后，新增功能主要参考 `design-system/` 的 tokens、组件和设计规则，并与已经落地的产品界面保持一致。

## 原型入口

| 文件 | 定位 | 适合检查 |
| --- | --- | --- |
| [`readtailor-mvp.dc.html`](readtailor-mvp.dc.html) | 主原型，一套代码适配宽屏与窄屏 | 完整用户流程、桌面端布局、响应式行为 |
| [`readtailor-mvp-phone-preview.dc.html`](readtailor-mvp-phone-preview.dc.html) | 主原型的固定手机壳预览 | 演示与评审时的真实设备比例 |

两个文件都依赖当前目录中的 `support.js` 与上一级的 `design-system/`，请保持相对位置不变。

## 运行资产

- `support.js`：Design Canvas 原型标签和交互的运行支持。
- `.thumbnail`：工作区生成的缩略图资产。
