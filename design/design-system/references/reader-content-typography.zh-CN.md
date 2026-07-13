# Reader Content Typography · 阅读器原文排版规范

> 状态：正式规范（Normative）
>
> 适用范围：阅读器中由 EPUB 提供的正文、章节标题内联内容和原书注正文；不包含裁读生成的导读、注释卡、工具栏和其他产品 UI。
>
> 视觉样例：[`../guidelines/type-reader-content.card.html`](../guidelines/type-reader-content.card.html)

## 一、核心原则

**书籍拥有语义，阅读器拥有排版。**

- EPUB 决定哪些内容是标题、段落、强调、引用、列表、表格、图注和脚注。
- 阅读器统一决定字体、字号、行高、颜色、间距、边框和响应式行为。
- 原书的 `<strong>`、`<em>`、`<u>`、`<s>` 不使用裁读品牌色表达。它们必须保留作者语义，而不是看起来像裁读添加的内容。
- 墨绿只用于裁读拥有的交互与信息：注释锚点、原书注入口、选中态、进度和产品自有强调文案。
- 排版必须优先保证连续阅读。任何元素都不能迫使正文缩小，也不能让页面出现不可恢复的横向溢出。

规范分为三个作用域：

- `.rt-reader-content`：正文完整排版。
- `.rt-reader-heading-content`：重建后的章节标题，只接受行内语义和原书注入口。
- `.rt-reader-note-content`：原书注中的紧凑排版，支持与正文相同的富文本语义。

生产阅读器可以将现有 `.reader-original`、`.reader-outline-heading` 和 `.note-dialog-content` 分别映射到这三个 profile。

## 二、内容清洗边界

阅读器必须保留语义，移除出版社对阅读体验的强制覆盖。

### 保留

- NB-1.0 语义元素：标题、段落、`strong`、`em`、`u`、`s`、`sup`、`sub`、引用、列表、表格、图片、图注、链接、脚注和代码。
- 内容属性：`lang`、`dir`、`href`、`src`、`alt`、`title`、`cite`、`datetime`。
- 结构属性：`colspan`、`rowspan`、`scope`、`start`、`reversed`、`value`。
- 裁读规范化阶段生成并拥有的 `data-role` 属性。

### 移除或归一化

- 出版社内联的 `font-family`、`font-size`、`line-height`、`color`、`background`、`text-indent`、段落 margin。
- 依赖固定页面尺寸的绝对定位、浮动、多栏和固定宽高。
- 冗余的纯装饰性 class。确有语义用途的 class 应在规范化阶段映射为受控的 `data-role`；规范允许保留的表格和代码语言 class 不得承担结构语义。
- 会覆盖阅读主题、字号设置或夜间模式的表现层样式。

不得为了方便排版而把 `<strong>`、`<em>`、`blockquote`、列表或表格扁平化为普通文本。

## 三、正文基线

| 属性 | 默认值 | 规则 |
|---|---:|---|
| 字体 | `var(--rt-read)` | 默认 `Songti SC`，跨平台回退 `Noto Serif SC`；不使用展示明朝体或楷体 |
| 字号 | `var(--rt-reading-size)` / `18px` | 用户设置可覆盖；移动端不得自动缩小 |
| 行高 | `var(--rt-reading-line-height)` / `1.95` | 标题、表格、代码可使用独立行高 |
| 字重 | `var(--rt-weight-reg)` / `400` | 正文不使用整体中黑或粗体 |
| 字距 | `0` | 原书正文禁止品牌式大字距 |
| 颜色 | `var(--rt-ink)` | 只使用主题 Token，不写死颜色 |
| 对齐 | 左对齐 | 两端对齐是用户设置，不是默认值 |
| 阅读版心 | 外框 `680px`，左右内边距 `24px` | 小屏降为 `100%`，保持同等内边距 |

长单词、URL 和没有空格的字符串使用 `overflow-wrap: anywhere`，但普通中文正文不主动断字。

## 四、段落与缩进

### 中文及其他使用段首缩进的语言

- 普通段落首行缩进 `2em`。
- 段后距离 `0.8em`，不用空行模拟段落。
- 标题、分节符之后的第一段不缩进。
- 引用、列表项、表格单元格、图注、脚注、代码块中的段落不缩进。
- 连续的对白、诗歌、书信落款若有明确结构，服从其语义结构，不强行增加缩进。

### 拉丁文字及其他不使用段首缩进的语言

- 默认不缩进。
- 段后距离 `1em`。
- 允许按 `lang` 开启 `hyphens: auto`，但不得对未标注语言的文本猜测断词。

## 五、标题层级

标题必须保持语义层级，不通过字号伪造层级。

| 层级 | 建议值 | 用法 |
|---|---|---|
| 部标题 `part` | `10px / 1.8 / 400` | mono 大字距，居中，两侧中性规则线 |
| 章标题 | `25px / 1.45 / 600` | 居中，章开始处使用；不使用全大写 |
| 节标题 | `21px / 1.55 / 600` | 居中，使用 `var(--rt-green-deep)` |
| 小节标题 | `17px / 1.65 / 600` | 居中或左对齐，由全书结构统一决定 |
| 更深层级 | `1em / 1.8 / 600` | 左对齐，用间距而不是继续缩小字号 |

- 标题上方留白必须大于下方留白。
- 标题中的原书注入口与正文使用同一套脚注交互。
- 原书标题自身不因包含 `<em>` 而变成品牌绿色。
- `book` 不重复渲染已在阅读器书名区出现的标题。
- `preface`、`foreword`、`introduction`、`prologue`、`epilogue`、`appendix` 等叶节点按实际 outline 深度映射到章、节或小节视觉层级；不因类型名称统一伪装成 chapter。
- `epigraph`、`dedication` 可以没有标题；`titlepage`、`colophon`、`bibliography`、`glossary`、`index` 等有标题时同样按 outline 深度呈现。

## 六、行内语义

### 加粗：`strong`、`b`

- 使用 `font-weight: 600`，颜色继承正文。
- 中文长段落避免 `700`，防止形成过重墨块。
- 不增加背景、下划线或品牌色。
- `<b>` 在视觉上与 `<strong>` 一致，但规范化阶段不得伪造其语义。

### 斜体：`em`、`i`

- 使用 `font-style: italic`，颜色继承正文。
- 不自动使用 `var(--rt-green-deep)`。绿色斜体仅属于裁读自有文案，不属于 EPUB 原文。
- 字体缺少真实斜体时允许浏览器合成倾斜，不能改用楷体模拟。
- 规范化产物应使用 `<strong>` / `<em>`；`<b>` / `<i>` 只作为渲染层的防御性兼容选择器。

### 原书下划线：`u`

- 使用当前文字色的 `1px` 实线，`text-underline-offset: 0.14em`。
- 不使用虚线、点线或绿色，因为这些视觉语言属于裁读注释锚点。
- 连续大段下划线按源语义保留，但不得增加背景色强化。

### 链接

- 普通外链使用正文色和细下划线，hover 时才切换为 `var(--rt-green-deep)`。
- 不依赖颜色单独表达可点击状态。
- 链接必须允许换行，长 URL 不撑破版心。
- `focus-visible` 使用清晰但克制的绿色外轮廓；访问过的链接不变成浏览器默认紫色。

### 上下标与删除线

- `sup`、`sub` 使用 `0.72em`，`line-height: 0`，不得改变正文行距。
- `s` 使用当前文字色的细删除线，不降低到不可读透明度。

`mark`、`del`、`ins`、Ruby 和 `kbd` 不属于当前 NB-1.0 保证输出的语义。未来若加入，必须先更新规范化契约，再在本规范中定义正式视觉规则；渲染器不得仅凭浏览器默认样式宣称支持。

### 特殊换行：`br`

- 只在诗歌、地址和其他源语义明确要求的行内换行中保留。
- 普通 prose 中不允许用连续 `<br>` 模拟段落间距。
- `<pre><code>` 依靠原始换行，不用 `<br>` 逐行拼接代码。

## 七、块级元素

### 引用：`blockquote`

- 引用是原书内容，不使用裁读注释卡的绿色左边框。
- 使用 `1px solid var(--rt-rule)` 的中性左规则线。
- 左内边距 `1.25em`，上下间距 `1.8em`。
- 文字使用 `var(--rt-ink-2)`，字号保持 `1em`，行高继承。
- 引用内段落不缩进；多段之间保留 `0.8em` 间距。
- `.attribution` 使用 `0.82em` UI 字体、`var(--rt-ink-3)`，右对齐，不增加引号。
- 嵌套引用继续使用中性线，第二层降低对比度，不叠加背景。
- 不加卡片背景、阴影、引号水印或装饰性大字号。

### 无序与有序列表

- 左缩进 `1.7em`，列表上下间距 `1.2em`。
- 条目间距 `0.45em`，嵌套列表间距减半。
- 列表项内段落不做段首缩进。
- 有序列表保留 EPUB 的 `start`、`reversed` 和条目 `value`。
- 标记颜色使用 `var(--rt-ink-3)`；不得用绿色圆点制造产品功能感。

### 定义列表

- `dt` 使用 `600` 字重，颜色为 `var(--rt-ink)`。
- `dd` 左缩进 `1.5em`，颜色为 `var(--rt-ink-2)`。
- 每组定义之间留 `0.9em`，组内不使用卡片容器。

## 八、表格

表格的目标是“可扫描的数据页”，不是缩小后的网页组件。

- 表格使用 `var(--rt-demo)`，字号 `0.82em`，但计算后不得低于 `13px`。
- 行高 `1.65`；表头字重 `600`，正文 `400`。
- 表头使用 `var(--rt-bg-2)` 淡底；只使用横向 hairline，避免完整方格网造成表单感。
- 单元格内边距：纵向 `8px`、横向 `10px`。
- 表格 caption 位于上方，左对齐，使用 `12px` UI 字体和 `var(--rt-ink-3)`。
- 数字列只在源数据或规范化结果提供可靠依据时，由渲染增强阶段标记 `data-align="number"`；随后右对齐并使用 `font-variant-numeric: tabular-nums`，不得凭内容猜测整列语义。
- 文本列左对齐；不得用居中对齐掩盖结构。
- 表格单元格中的段落不缩进。
- `thead th` 使用淡底；行表头 `th[scope="row"]` 不铺满强调底，只使用 `600` 字重和正文强色。
- `tfoot` 使用上方 hairline 与 `600` 字重，不能通过更小字号弱化汇总信息。
- `rowspan` / `colspan` 单元格默认顶部对齐；空单元格保持结构尺寸，不显示占位符。
- 单元格包含多段时段距 `0.45em`，首段和末段不增加额外外边距。

移动端必须为表格提供独立横向滚动容器，页面本身不能横向滚动。推荐由渲染层包裹，不改变规范化书籍包中的表格语义：

```html
<div data-role="table-scroll" tabindex="0" aria-label="可横向滚动的表格">
  <table>...</table>
</div>
```

不得通过无限缩小字号让宽表格硬塞进屏幕。

## 九、图片、图注与媒体

- `figure` 上下间距 `2.2em`，整体居中。
- figure 中的块级图片和视频最大宽度 `100%`，最大高度 `min(70vh, 680px)`，使用 `object-fit: contain`。
- 段落、链接、代码或 span 中的行内图片保持 `inline-block`，高度以约 `1.2em` 为上限并跟随文字基线，不能被强制变成独占一行。
- 不裁切原图，不添加装饰性圆角或阴影。
- `figcaption` 上间距 `10px`，使用 `12px` UI 字体、`1.65` 行高和 `var(--rt-ink-3)`。
- 图注中的段落不缩进。
- 源图片缺少 `alt` 属性时可在 EPUB 质量检查中报告“源属性缺失”，但不得判断图片是否信息性、不得生成描述、不得把缺失值改写为 `alt=""`。
- 音频与视频控件使用浏览器原生能力，宽度不超过版心。
- `source` 与 `track` 不产生额外视觉盒；加载失败时保留浏览器可理解的替代文本。

## 十、代码与技术文本

### 行内代码：`code`

- 使用 `var(--rt-mono)`，字号 `0.84em`。
- 中性淡底、`1px` hairline、`3px` 圆角，内边距约 `0.08em 0.3em`。
- 不使用绿色，避免与注释锚点混淆。

### 代码块：`pre`

- 使用 `var(--rt-mono)`，字号 `0.78em`，但不得低于 `13px`。
- 行高 `1.7`，背景 `var(--rt-bg-2)`，边框 `1px solid var(--rt-rule)`，圆角 `6px`。
- 内边距 `1.1em 1.2em`，上下间距 `1.8em`。
- 保留空格和换行，独立横向滚动；不自动换行代码。
- 代码块及其内部元素不做首行缩进。

## 十一、脚注与注释入口

- 原书注入口使用上标形式，字号 `0.7em`，UI 字体，颜色 `var(--rt-green)`。
- 点击区域应通过透明 padding 扩大，视觉字号不等于实际触控面积。
- 标题和正文中的注释入口必须保持一致。
- 原书注正文属于阅读内容，使用 `.rt-reader-note-content`：默认 `14.5px` 阅读字体、`1.9` 行高、段距 `0.7em`，不做段首缩进。
- 原书注允许包含图、表、列表、代码和全部行内格式；这些元素沿用正文规则，只收紧块间距，不能回落到浏览器默认样式。
- 返回原文的 backref 可隐藏，但关闭注释必须不依赖它。
- `data-broken="true"` 的断链 noteref 保留原可见文本，使用 `var(--rt-ink-3)` 和中性虚线下划线，不显示 pointer，也不打开空弹窗。
- `data-orphan="true"` 的孤儿 note 不在正文中生成虚构入口；它只可在原书已有的注释附录或质量诊断中呈现。

## 十二、规范化结构角色

### 场景分隔：`[data-role="separator"]`

- 源 `<hr>` 在 NB-1.0 中必须无条件转换为 separator；阅读器不为裸 `<hr>` 定义正式样式。
- 空 separator 必须仍然可见，渲染为居中的 `72px` 中性细线。
- separator 包含源符号时，原字符原样显示，使用阅读字体和 `var(--rt-ink-3)`；不得用生成的 `§` 替换。
- 上下间距 `2.4em`，其后一段不缩进。

### 原子单元：`[data-role="unit"]`

- unit 是普通块级容器，不是单行标签，必须保持正常文档流。
- 禁止对整个 unit 使用 `display: flex`；其内部可能包含多段文字、列表、图或表。
- `data-unit-num` 可以渲染为单独的小号 mono 单元号，但不能把正文内容挤进同一行。
- 相邻 unit 以 `1px solid var(--rt-rule-2)` 和纵向留白区分，不使用卡片背景。

### 诗歌：`[data-role="verse"]`

- 保留源 `<br>` 换行，段落不做首行缩进。
- 使用 `white-space: pre-wrap` 或等效结构保留有意义的行首空格，同时允许窄屏换行。
- 使用阅读字体、`1.9` 行高和 `1.8em` 上下间距。
- 不为了居中视觉而破坏原始行首空格；超长诗行允许局部横向滚动或按源语言自然换行。

### 数学：`[data-role="math"]`

- 行内公式跟随正文基线，块级公式居中并提供独立横向滚动。
- 不使用代码块背景代替数学排版。
- 渲染引擎不可用时保留原始公式文本，不显示空白占位。

### 未识别内容：`[data-role="unknown"]`

- 采用低干预的正文继承样式，保留可见文本与媒体。
- 不渲染成警告卡、错误红或产品提示，因为“未知”是处理状态，不是书籍语义。

## 十三、主题、响应式与无障碍

- 所有颜色必须来自 `--rt-*` 主题 Token，纸白、纸黄、夜间模式不写三套选择器。
- 正文最小可用字号为 `16px`；表格和代码最小 `13px`，图注最小 `12px`，关键数据与交互文本最小 `13px`。
- 用户调整字号或行高时，表格、代码和图注可以按比例收敛，但不得固定为不可读尺寸。
- `strong`、`em`、链接、引用和表头都不能只依赖颜色表达语义。
- 保留 `lang` 与 `dir`，支持混合语言和 RTL 段落；RTL 内容的引用边线和内边距应跟随逻辑方向。
- 焦点样式必须可见；横向滚动容器可通过键盘聚焦。
- 不对原书正文使用逐字浮现、滚动视差或持续动画。
- 竖排 EPUB、复杂数学公式和交互式媒体不在 MVP 的统一排版范围内，应保留内容并采用降级展示，不得静默删除。

## 十四、参考 CSS

以下代码表达规范意图。生产代码可以调整选择器结构，但不能改变语义边界和视觉优先级。

```css
:where(.rt-reader-content, .rt-reader-note-content) {
  color: var(--rt-ink);
  font-family: var(--rt-read);
  font-weight: var(--rt-weight-reg);
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.rt-reader-content {
  font-size: var(--rt-reading-size);
  line-height: var(--rt-reading-line-height);
}

.rt-reader-note-content {
  font-size: 14.5px;
  line-height: 1.9;
}

:where(.rt-reader-content, .rt-reader-heading-content, .rt-reader-note-content) strong,
:where(.rt-reader-content, .rt-reader-heading-content, .rt-reader-note-content) b {
  color: inherit;
  font-weight: var(--rt-weight-semi);
}

:where(.rt-reader-content, .rt-reader-heading-content, .rt-reader-note-content) em,
:where(.rt-reader-content, .rt-reader-heading-content, .rt-reader-note-content) i {
  color: inherit;
  font-style: italic;
}

:where(.rt-reader-content, .rt-reader-heading-content, .rt-reader-note-content) u {
  color: inherit;
  text-decoration-color: currentColor;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.14em;
}

.rt-reader-content blockquote {
  margin: 1.8em 0;
  padding-inline-start: 1.25em;
  border-inline-start: 1px solid var(--rt-rule);
  color: var(--rt-ink-2);
}

:where(.rt-reader-content, .rt-reader-note-content) :is([data-role='table-scroll'], pre) {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.rt-reader-note-content p {
  margin: 0 0 0.7em;
  text-indent: 0;
}

.rt-reader-note-content :is(blockquote, ul, ol, dl, figure, pre, [data-role='table-scroll']) {
  margin-block: 1.2em;
}

.rt-reader-note-content :is(table, pre) {
  font-size: 13px;
}

.rt-reader-note-content figcaption {
  font-size: 12px;
}
```

## 十五、验收清单

- 原书加粗是 `600`，没有变绿。
- 原书斜体保持正文颜色，没有被当作裁读强调。
- 中文普通段落缩进 `2em`，标题、列表、引用、表格后的规则正确。
- 引用使用中性规则线，与裁读注释卡明显不同。
- 宽表格和代码块只在自身内部横向滚动。
- 表格在移动端没有缩到不可读。
- 图片完整可见，图注不缩进。
- 行内图片仍然留在文字行内，块级图片才独占一行。
- 标题与正文中的原书注入口都可识别、可点击。
- 原书注里的列表、表格和代码使用紧凑版内容规范，而不是浏览器默认样式。
- 空 separator 可见，unit 容器不会被压成一行，诗歌不被中文首行缩进误伤。
- 纸白、纸黄、夜间模式均只依赖 Token 完成换肤。
- 放大字号后没有文字遮挡、横向页面溢出或固定高度截断。
