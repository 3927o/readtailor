# ReadTailor 产品化梳理

这里保存从完整 MVP 流程到移动端呈现的可交互原型。

## 原型入口

| 文件 | 定位 | 适合检查 |
| --- | --- | --- |
| [`readtailor-mvp.dc.html`](readtailor-mvp.dc.html) | 主原型，一套代码适配宽屏与窄屏 | 完整用户流程、桌面端布局、响应式行为 |
| [`readtailor-mobile.dc.html`](readtailor-mobile.dc.html) | 移动端独立版本 | 登录、画像、书架、上传、阅读等手机交互 |
| [`readtailor-mvp-phone-preview.dc.html`](readtailor-mvp-phone-preview.dc.html) | 主原型的固定手机壳预览 | 演示与评审时的真实设备比例 |

三个文件都依赖当前目录中的 `support.js` 与上一级的 `design-system/`，请保持相对位置不变。

## 运行资产

- `support.js`：Design Canvas 原型标签和交互的运行支持。
- `.thumbnail`：工作区生成的缩略图资产。
