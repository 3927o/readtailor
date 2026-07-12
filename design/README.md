# ReadTailor 设计工作区

这个目录集中保存 ReadTailor（裁读）的设计规范、可复用组件和产品原型。

## 从这里开始

| 目标 | 入口 |
| --- | --- |
| 查看品牌与设计规范 | [`design-system/README.md`](design-system/README.md) |
| 查看完整 MVP 产品流程 | [`prototypes/readtailor-mvp.dc.html`](prototypes/readtailor-mvp.dc.html) |
| 查看移动端独立原型 | [`prototypes/readtailor-mobile.dc.html`](prototypes/readtailor-mobile.dc.html) |
| 在手机壳中预览 MVP | [`prototypes/readtailor-mvp-phone-preview.dc.html`](prototypes/readtailor-mvp-phone-preview.dc.html) |

## 目录结构

```text
readtailor-design/
├── design-system/  # 设计规范、tokens、组件、UI kits、模板
└── prototypes/     # MVP 原型、移动端原型与预览壳
```

### 设计系统

- `tokens/`：颜色、字体、排版、间距、动效与阅读主题。
- `guidelines/`：颜色、字体、空间与品牌规范卡片。
- `components/`：按 `core`、`reading`、`library`、`chrome` 分类的 React 组件。
- `ui_kits/`：阅读器与 pitch 的完整界面示例。
- `templates/reader-app/`：书架、详情和阅读页组成的应用模板。
- `references/`：设计规范等来源说明。

### 产品化梳理

- `readtailor-mvp.dc.html`：覆盖登录、画像、书架、上传、试读策略、阅读和回顾等阶段的主原型。
- `readtailor-mobile.dc.html`：针对窄屏交互单独整理的移动端版本。
- `readtailor-mvp-phone-preview.dc.html`：将主原型装入固定手机外框的评审视图。
- `support.js`：`.dc.html` 原型的运行支持文件。

## 文件关系

产品原型通过相对路径引用 `../design-system/` 和同目录的 `support.js`。移动目录或原型文件时，需要同步更新这些引用。

设计系统目录是唯一维护源，产品原型不再保存重复快照。设计系统的 token 或 bundle 更新后，三个原型会直接使用最新版本。

## 维护约定

- 新的通用设计规则放进设计系统，不直接散落在产品原型中。
- 新原型优先复用现有 tokens 和组件，并在产品化目录 README 中补充用途。
- 临时导出物单独放入明确命名的子目录，不与当前有效原型混放。
