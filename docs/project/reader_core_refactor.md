# Reader Core 重构方案

## 一、项目背景

ReadTailor 是 pnpm monorepo，主要运行时包括：

```text
apps/web       React 阅读器
apps/api       Fastify API
apps/worker    EPUB 规范化与内容生成 Worker
```

项目尚未上线，不需要为历史生产 Manifest 保留兼容解析、双轨 schema 或降级逻辑。开发和测试环境中的旧产物可以按完成后的生成器重新生成。

书籍经过规范化后，产生不可变产物：

```text
book.normalized.html
reading_manifest.json
book_profile.json
assets/**
```

规范化 HTML 是原文事实来源。`reading_manifest.json` 是从 HTML 确定性生成的阅读索引，不包含完整原文。

当前 Manifest 版本：

```text
reading-nodes-1.0
```

裁读资格版本：

```text
tailoring-eligibility-1.0
```

当前书籍位置模型：

```text
节点：section_id + segment
节点内位置：block_index + UTF-16 offset
范围：[start, end)
block_index 从 1 开始
```

该坐标同时服务于：

- 阅读位置保存和恢复
- 试读片段
- 裁读注
- 划线和笔记
- 问 AI 原文引用
- 阅读统计和字符进度

因此，Manifest 和位置算法属于全系统核心契约。

---

## 二、当前实现情况

### Manifest 生产者

`tools/build_reading_nodes.py` 从规范化 HTML 生成 `reading_manifest.json`。

主要字段包括：

```ts
{
  version: "reading-nodes-1.0",
  tailoring_eligibility_version: "tailoring-eligibility-1.0",
  document: {
    title: string,
    language: string
  },
  outline: Array<{
    section_id: string,
    data_type: string,
    title: string,
    parent_section_id: string | null,
    first_node_order: number
  }>,
  book_total_characters: number,
  node_count: number,
  nodes: Array<{
    section_id: string,
    segment: number,
    order: number,
    region: string,
    data_type: string,
    title: string,
    parent_section_id: string | null,
    character_count: number,
    block_count: number,
    tailoring_eligible: boolean,
    exclusion_reason: string | null,
    node_absolute_start: number,
    blocks: Array<{
      block_index: number,
      kind: string,
      block_absolute_start: number,
      block_utf16_length: number
    }>
  }>
}
```

发布流程会连续生成两次 Manifest，并比较 SHA-256，保证结果确定性：

```text
apps/worker/src/normalization/publication.ts
```

但是发布流程目前没有通过统一的 TypeScript schema 校验 Manifest 的全部结构和内部一致性。

### Worker 当前处理方式

以下文件分别定义了自己的 Manifest 类型：

```text
apps/worker/src/tailoring/job.ts
apps/worker/src/normalization/book-analysis.ts
apps/worker/src/ingest-preset.ts
apps/worker/src/ingest-fixture.ts
```

常见读取方式是：

```ts
JSON.parse(bytes) as Manifest
```

这些类型只包含各自需要的部分，彼此不完全一致。

### API 当前处理方式

`apps/api/src/user-books.ts` 自己定义：

```text
ManifestBlock
ManifestNode
ManifestOutline
ReadingManifest
ManifestMeta
```

其中 `asManifest()` 主要只检查 `nodes` 和 `outline` 是否为数组。

API 使用 Manifest 完成：

- 用户位置校验
- 划线范围校验
- 试读片段校验
- 原文引用
- 阅读进度计算
- 绝对字符位置计算
- 正式内容生成窗口选择

### Web 当前处理方式

`apps/web/src/reader/api.ts` 再次定义：

```text
ReadingManifest
ReaderNode
ReaderPosition
ReaderResumePosition
```

获取 Manifest 后主要依靠泛型和 TypeScript 类型断言，没有运行时解析。

`apps/web/src/reader/content.ts` 独立实现：

- Web DOM block 枚举
- block 标准文本
- DOM selection → block/offset
- block/offset → DOM Range
- range 原文提取
- 划线和裁读注渲染

### Tailoring 当前处理方式

`packages/tailoring` 使用 Cheerio 实现 Node 环境的：

- 阅读节点提取
- block 枚举
- 标准文本生成
- 试读范围切割
- AI 注释范围验证

其内部坐标使用 snake_case：

```ts
type TextPoint = {
  block_index: number;
  offset: number;
};
```

Web/API 合约使用 camelCase：

```ts
type TextPosition = {
  blockIndex: number;
  offset: number;
};
```

当前通过 `block-consistency.test.ts` 检查 Web 和 Tailoring 的部分 block 行为是否一致，但没有统一的正式内核。

---

## 三、当前依赖问题

当前是分散的隐式契约：

```text
build_reading_nodes.py
        │
        ▼
reading_manifest.json
   ├── Worker 自己定义类型和解析
   ├── API 自己定义类型和解析
   ├── Web 自己定义类型和解析
   └── Tailoring 自己定义坐标算法
```

主要风险：

1. Manifest 字段变更后只有部分消费者更新。
2. Manifest 发布前没有统一的运行时结构与语义校验。
3. block 枚举或标准文本算法漂移后，位置静默错位。
4. API、Web、Worker 对同一坐标使用不同类型。
5. Manifest 版本存在，但消费者没有统一的版本门禁。
6. 位置算法散落，未来重写 ReaderPage 时还会再复制一次。

---

# 四、Reader Core 目标

新建：

```text
packages/reader-core/
```

它是浏览器和 Node 都能使用的纯 TypeScript 包。

它负责：

- Manifest 唯一类型
- Manifest 运行时 schema
- Manifest 版本校验
- Manifest 内部一致性校验
- 节点、block 和 outline 索引
- 节点定位
- block point/range 纯算法
- 绝对字符位置换算
- 对 HTML block adapter 输出的校验

它不负责：

- HTML 文件读取
- 对象存储
- 数据库
- React
- Fastify
- Cheerio
- DOM 操作
- AI 内容生成
- 阅读位置持久化
- V1/V2 阅读准备流程
- ReaderPage UI

---

## 五、目标依赖方向

```text
                         packages/reader-core
                         ▲       ▲        ▲
                         │       │        │
                  contracts  tailoring  normalized-book
                         ▲       ▲        ▲
                         │       │        │
                        Web     Worker     API
```

准确规则：

```text
reader-core 不能依赖 contracts
reader-core 不能依赖 tailoring
reader-core 不能依赖 normalized-book
reader-core 不能依赖 apps/*
```

允许：

```text
contracts -> reader-core
tailoring -> reader-core
normalized-book -> reader-core
apps/* -> reader-core
```

这样可以避免循环依赖。

---

# 六、Reader Core 目录设计

建议结构：

```text
packages/reader-core/
  package.json
  tsconfig.json

  src/
    errors.ts
    manifest-schema.ts
    manifest.ts
    manifest-index.ts
    point.ts
    range.ts
    blocks.ts
    index.ts

    fixtures/
      reading-nodes-1.0.valid.json

    manifest.test.ts
    manifest-index.test.ts
    range.test.ts
    blocks.test.ts
```

## `manifest-schema.ts`

定义与持久化 JSON 完全一致的 TypeBox schema。重构完成后的 Manifest JSON 字段统一使用 camelCase。

核心导出：

```ts
export const READING_MANIFEST_VERSION = 'reading-nodes-1.0';
export const TAILORING_ELIGIBILITY_VERSION = 'tailoring-eligibility-1.0';

export const ReadingManifestSchema = Type.Object(...);

export type ReadingManifest =
  Static<typeof ReadingManifestSchema>;
```

必须严格定义：

- document
- outline
- nodes
- blocks
- bookTotalCharacters
- nodeCount
- warnings
- validation
- 当前版本字面量

`outline.firstNodeOrder` 继续定义为从 1 开始的整数，第一版不接受 null。若生成器产生没有可定位 reading node 的 outline 项，发布门禁应拒绝该 Manifest，等实际出现这种输入时再单独决定处理方式。

第一版不要把未知 Manifest 版本强行解释成当前类型。

## `errors.ts`

提供明确错误：

```ts
export class ReaderContractError extends Error {
  readonly code:
    | 'unsupported_manifest_version'
    | 'invalid_manifest_shape'
    | 'invalid_manifest_semantics'
    | 'unknown_node'
    | 'unknown_block'
    | 'invalid_point'
    | 'invalid_range';

  readonly path?: string;
}
```

不要只抛出模糊的 `invalid manifest`。

## `manifest.ts`

提供：

```ts
parseReadingManifest(value: unknown): ReadingManifest
parseReadingManifestJson(json: string): ReadingManifest
validateReadingManifest(manifest: ReadingManifest): void
```

TypeBox 负责结构校验，额外代码负责语义校验。

完整结构与语义校验只用于发布门禁。Manifest 一旦通过门禁并进入不可变书籍包，API、Worker 和 Web 不再重复执行完整校验，而是统一使用 reader-core 的权威类型和纯算法。

至少验证：

- `nodeCount === nodes.length`
- `nodes[i].order === i + 1`
- `(sectionId, segment)` 唯一
- `blockCount === blocks.length`
- `blocks[i].blockIndex === i + 1`
- `characterCount === blocks[].blockUtf16Length` 总和
- `nodeAbsoluteStart` 与前序节点累计字符数一致
- `blockAbsoluteStart` 与节点和前序 block 一致
- `bookTotalCharacters` 等于节点字符数总和
- `tailoringEligible` 与 `exclusionReason` 组合合法
- outline 的 `sectionId` 唯一
- outline 的 `parentSectionId` 为 null 或指向存在的 outline 项
- outline 父子关系不形成循环
- outline 的 `firstNodeOrder` 指向存在的节点
- `validation.isValid` 和 `validation.errorCount` 不矛盾

第一版不强制同一 `sectionId` 的 segment 编号完全连续，也不在 reader-core 中重新实现完整的裁读资格算法。

不要在 reader-core 内读取文件或缓存 Manifest。

## `manifest-index.ts`

Manifest 解析后可以建立只读索引：

```ts
export type ManifestIndex = {
  manifest: ReadingManifest;
  nodeByOrder: ReadonlyMap<number, ReadingManifestNode>;
  nodeByKey: ReadonlyMap<string, ReadingManifestNode>;
  outlineBySectionId: ReadonlyMap<string, ReadingManifestOutlineItem>;
};

export function createManifestIndex(
  manifest: ReadingManifest,
): ManifestIndex;

export function manifestNodeKey(
  sectionId: string,
  segment: number,
): string;
```

还可以提供：

```ts
findNodeByOrder()
findNode()
requireNode()
findBlock()
requireBlock()
```

缓存属于 API/Web 的资源层，不放进 core。

## `point.ts`

Reader Core 内部坐标使用 camelCase，和现有 Web/API 公共契约保持一致：

```ts
export const BlockPointSchema = Type.Object({
  blockIndex: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
});

export type BlockPoint = Static<typeof BlockPointSchema>;
```

节点引用：

```ts
export const NodeLocatorSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
});

export type NodeLocator = Static<typeof NodeLocatorSchema>;
```

不要把 `clientObservedAt` 放进 reader-core，因为那是 HTTP/持久化协议，不是阅读坐标本身。

## `range.ts`

提供纯函数：

```ts
compareBlockPoints()
blockPointsEqual()
normalizeBlockRange()
blockRangesEqual()
blockRangeContains()
validateBlockPoint()
validateBlockRange()
quoteFromBlocks()
```

核心类型：

```ts
export const BlockRangeSchema = Type.Object({
  start: BlockPointSchema,
  end: BlockPointSchema,
});

export type BlockRange = Static<typeof BlockRangeSchema>;
```

范围继续使用左闭右开 `[start, end)`。

## `blocks.ts`

Reader Core 不操作 DOM 或 Cheerio，只定义环境无关的标准 block：

```ts
export type CanonicalReadingBlock = {
  blockIndex: number;
  kind: string;
  text: string;
  utf16Length: number;
};
```

提供：

```ts
validateCanonicalBlocks()
canonicalBlockLength()
validatePointAgainstBlocks()
validateRangeAgainstBlocks()
validateCanonicalBlocksAgainstManifestNode()
```

这里的 adapter 只是环境转换函数，不是框架或抽象类：

```ts
extractCanonicalBlocksFromDom()
extractCanonicalBlocksFromCheerio()
```

Web DOM adapter 和 Tailoring Cheerio adapter 都输出 `CanonicalReadingBlock[]`。`validateCanonicalBlocksAgainstManifestNode()` 至少对比 block 数量、顺序、index、kind、`text.length`、`utf16Length` 和 Manifest 中的 `blockUtf16Length`。

第一阶段不要尝试在 reader-core 中解析 HTML。

---

# 七、统一 camelCase 契约

Reader Core 所有权范围内的跨模块契约统一使用 camelCase，包括：

- `reading_manifest.json`
- Reader Core 类型
- contracts 的 point/range
- Web、API、Worker 使用的 Manifest 和位置字段
- Tailoring 的 TypeScript 类型、模型输入和模型输出

Manifest 目标形态：

```ts
{
  version: "reading-nodes-1.0",
  tailoringEligibilityVersion: "tailoring-eligibility-1.0",
  document: {
    title: "示例书名",
    language: "zh-CN"
  },
  bookTotalCharacters: 50,
  nodeCount: 1,
  outline: [{
    sectionId: "chapter-1",
    dataType: "chapter",
    parentSectionId: null,
    firstNodeOrder: 1
  }],
  nodes: [{
    sectionId: "chapter-1",
    segment: 1,
    order: 1,
    region: "bodymatter",
    dataType: "chapter",
    title: "第一章",
    parentSectionId: null,
    characterCount: 50,
    blockCount: 1,
    tailoringEligible: true,
    exclusionReason: null,
    nodeAbsoluteStart: 0,
    blocks: [{
      blockIndex: 1,
      kind: "p",
      blockAbsoluteStart: 0,
      blockUtf16Length: 50
    }]
  }],
  warnings: [],
  validation: {
    isValid: true,
    errorCount: 0,
    warningCount: 0
  }
}
```

坐标统一为：

```ts
{
  blockIndex: 1,
  offset: 10
}
```

Tailoring 不再维护 snake_case point/range，也不再增加 snake_case 与 camelCase 的转换函数。模型输入输出中的 Reader/Tailoring 协议字段同步改为 camelCase，例如 `generationScope`、`fragmentRange`、`sectionId`、`nodeOrder`、`blockIndex`、`sourceOffset` 和 `afterReading`。

统一的是跨模块 JSON/TypeScript 契约，不强制其他语言违反自身惯例：

- Python 内部变量和函数参数可以继续使用 snake_case，但输出 Manifest 时写入 camelCase key。
- 数据库列名继续使用 snake_case，数据库映射层负责转换。
- HTML `data-*` 属性继续使用 kebab-case。
- 本次重构范围外的其他持久化 JSON 产物不因 Reader Core 顺手改名。

项目尚未上线，本次直接更新 `reading-nodes-1.0` 的字段命名并重新生成开发/测试产物，不增加兼容分支，也不保留同一字段的两种命名。

---

# 八、迁移方案

迁移必须增量完成，不能一次修改所有消费者。

## R00：统一生成器输出并删除非正式的分节点 HTML

允许修改：

```text
tools/build_reading_nodes.py
tests/test_build_reading_nodes.py
相关生成器测试
```

工作：

- 删除 `--html-dir` 参数。
- 删除 node 的可选 `html_file` 字段。
- 删除分节点 HTML 文件写出逻辑和只为该逻辑服务的辅助代码。
- 正式 `reading-nodes-1.0` schema 不包含 `html_file`。
- 将 `reading_manifest.json` 的持久化字段统一改为 camelCase。
- Python 内部变量可以继续使用 snake_case，只修改写入 JSON 的 key。
- 更新 Python 测试中的期望字段，并重新生成后续 Reader Core 使用的 fixture。
- 不修改 Block v1 枚举、标准文本、UTF-16 长度或节点切分算法。

验证：

```bash
python3 -m unittest tests.test_build_reading_nodes -v
```

## R01：建立 reader-core 包

允许修改：

```text
pnpm-workspace.yaml（通常无需修改，packages/* 已覆盖）
packages/reader-core/**
package.json / pnpm-lock.yaml
```

工作：

- 创建包。
- 添加 TypeBox 依赖。
- 实现 Manifest schema、parser、semantic validation。
- 实现 point/range 和 index。
- 添加 fixture 和单元测试。

Fixture 应覆盖：

- 中文
- emoji 等 UTF-16 双 code-unit 字符
- 空文本媒体 block
- 多 segment
- 不可裁读节点
- 多级 outline
- block 绝对位置

本阶段不修改任何现有消费者。

验证：

```bash
pnpm --filter @readtailor/reader-core typecheck
pnpm vitest run packages/reader-core
```

## R02：加入发布门禁

允许修改：

```text
apps/worker/src/normalization/publication.ts
apps/worker/src/ingest-preset.ts
apps/worker/src/ingest-fixture.ts
apps/worker/package.json
packages/normalized-book/package.json
packages/normalized-book/src/*
pnpm-lock.yaml
相关测试
```

工作：

- 所有发布路径在 Manifest 确定性生成后调用同一个 `parseReadingManifestJson` 门禁。
- 正式规范化在进入 book analysis 前完成校验。
- preset 和 fixture 在生成 package manifest、上传对象和写入成功状态前完成校验。
- 检查 Manifest 内版本与 package manifest 中的 `manifestVersion` 一致。
- 发布失败时报告具体字段路径。

除 R00 已明确的 camelCase 字段改名和删除 `html_file` 外，不要继续改变 Python 生成器输出。

不要改变 package version 算法，除非 Manifest 字节本身变化。

验证：

```bash
pnpm vitest run packages/normalized-book apps/worker/src/normalization
pnpm typecheck
```

## R03：迁移 contracts 坐标类型

允许修改：

```text
packages/contracts/src/index.ts
packages/contracts/package.json
packages/contracts/src/index.test.ts
```

工作：

- `TextPositionSchema` 兼容导出 `BlockPointSchema`。
- `TextRangeSchema` 兼容导出 `BlockRangeSchema`。
- 现有名称保持不变，避免一次修改所有调用方。
- `ReaderPositionSchema` 继续在 contracts 中定义，因为它包含：
  - node locator
  - block point
  - `clientObservedAt`
- `ReaderResumePositionSchema` 继续属于 contracts，因为它包含服务端恢复元数据。

目标形态：

```ts
export const TextPositionSchema = BlockPointSchema;
export type TextPosition = BlockPoint;

export const TextRangeSchema = BlockRangeSchema;
export type TextRange = BlockRange;
```

本阶段不删除兼容名称。

## R04：迁移 Tailoring 纯算法

允许修改：

```text
packages/tailoring/src/types.ts
packages/tailoring/src/validation.ts
packages/tailoring/src/source.ts
packages/tailoring/src/index.ts
packages/tailoring/src/*.test.ts
packages/tailoring/package.json
```

工作：

- 将 Tailoring 的 TypeScript 类型、模型输入和模型输出协议字段统一改为 camelCase。
- 删除 snake_case 与 reader-core 类型之间的转换需求，不新增兼容双写或双读。
- 删除 Tailoring 自己的 `comparePoints/rangesEqual/rangeContains` 实现。
- 改用 reader-core 算法。
- `extractBlocks()` 继续使用 Cheerio。
- 将 `extractBlocks()` 结果投影为 `CanonicalReadingBlock[]` 并通过 core 校验。
- 同步更新 prompt、parser、测试 fixture 和缓存输入的字段命名。
- 开发环境旧缓存可以失效或清理，不增加 snake_case 兼容逻辑。
- 除字段命名外，不改变生成范围、注释定位、内容结构和 AI 生成语义。

更新字段命名后的 Tailoring 测试必须全部通过；不得为了保留旧 snake_case fixture 增加兼容分支。

## R05：迁移 Worker Manifest 消费者

逐个迁移，不要一次完成。

顺序：

```text
apps/worker/src/normalization/book-analysis.ts
apps/worker/src/tailoring/job.ts
apps/worker/src/ingest-preset.ts
apps/worker/src/ingest-fixture.ts
```

每迁一个文件：

- 删除本地 Manifest 类型。
- 使用 reader-core 导出的 `ReadingManifest` 类型读取已经通过发布门禁的不可变产物。
- 将 Manifest 和位置字段访问统一改为 camelCase。
- 用 `createManifestIndex` 查找节点。
- 不在消费阶段重复调用完整 Manifest 语义校验。
- 类型断言只允许存在于读取可信已发布产物的集中边界，不能在业务文件中继续定义局部 Manifest 类型。
- 运行该模块测试后单独提交。

不要修改 generation 状态机或数据库事务。

## R06：迁移 API

主要文件：

```text
apps/api/src/user-books.ts
apps/api/src/user-books/trial/service.ts
apps/api/src/user-books/context/setup-context.ts
apps/api/src/books.ts
apps/api/package.json
pnpm-lock.yaml
相关位置、统计和试读测试
```

工作：

- 删除本地 `ManifestBlock/ManifestNode/ReadingManifest`。
- 删除弱校验 `asManifest()`。
- `BookService.getManifest()` 返回 reader-core 的 `ReadingManifest | null`，并信任已经通过发布门禁的不可变产物。
- 将 API 内部对 Manifest 和位置对象的字段访问统一改为 camelCase；数据库列映射仍留在 repository/持久化边界。
- `ManifestMeta` 改为从 `ManifestIndex` 派生。
- `positionMatchesManifest`、range 校验、绝对字符位置计算使用 reader-core。
- API 不在加载时重复执行完整 Manifest 结构与语义校验。
- Manifest 缓存继续属于 API，不进入 reader-core。
- 不在这一步拆分 `user-books.ts`。
- 不修改 V1 状态机。

注意：缓存长期应以不可变 package ID/version 为 key，而不是只以 sharedBookId 为 key。但这是单独的行为更改，不应混入纯迁移提交。

## R07：迁移 Web

主要文件：

```text
apps/web/src/reader/api.ts
apps/web/src/reader/content.ts
apps/web/src/reader/block-consistency.test.ts
apps/web/src/reader/position.test.ts
apps/web/src/reader/highlights.test.ts
apps/web/package.json
pnpm-lock.yaml
```

工作：

- 删除 Web 本地 `ReadingManifest` 定义。
- 获取 Manifest 后直接使用 reader-core 的 `ReadingManifest` 类型，信任 API 返回的已发布产物。
- Web 不重复执行完整 Manifest 结构与语义校验。
- 将 Manifest 字段访问统一改为 camelCase。
- Web DOM adapter 输出 core `CanonicalReadingBlock[]`。
- selection/range 使用 core 类型和纯算法。
- DOM boundary、Range、geometry 逻辑继续留在 Web。
- 不重写 ReaderPage。
- 不改变用户界面。

现有 `block-consistency.test.ts` 保留，它仍负责验证：

```text
Cheerio adapter
Web DOM adapter
```

对相同 HTML 枚举出相同 block。

以后 Reader V2 直接依赖完成后的 reader-core。

## R08：清理重复定义

完成所有消费者迁移后才执行。

检查：

```bash
rg "type ReadingManifest|interface ReadingManifest" apps packages
rg "type ManifestNode|interface ManifestNode" apps packages
rg "JSON.parse.*as .*Manifest" apps packages
rg "function comparePoints" apps packages
rg "section_id|block_index|first_node_order|book_total_characters|node_absolute_start" apps packages
```

允许存在：

- reader-core 的权威定义
- 与特定页面展示有关、名字不同的 view model
- Python 生成器的数据类
- 读取可信已发布产物的集中边界中，针对 reader-core `ReadingManifest` 的单一类型断言
- 数据库 schema、SQL 映射和本次重构范围外的其他持久化 JSON 类型中的 snake_case 字段

不允许存在语义相同但独立维护的 Manifest 类型和坐标算法。

---

# 九、测试策略

## Manifest schema 测试

必须覆盖：

- 合法 `reading-nodes-1.0`
- 旧 snake_case Manifest 字段被拒绝
- 未知 Manifest 版本
- `firstNodeOrder` 为 null
- nodeCount 不一致
- node order 与数组位置不一致
- node key 重复
- blockIndex 不连续
- blockCount 不一致
- characterCount 不一致
- nodeAbsoluteStart 不一致
- blockAbsoluteStart 不一致
- bookTotalCharacters 不一致
- outline 指向不存在的 order
- tailoringEligible 与 exclusionReason 矛盾

## UTF-16 测试

至少包括：

```text
中文
ASCII
emoji
代理对字符
<br>
嵌套 inline 标签
```

JavaScript 中的长度必须与 Manifest 中 `blockUtf16Length` 一致。

## 跨环境一致性测试

相同 HTML 同时交给：

```text
Tailoring Cheerio adapter
Web DOM adapter
Python builder fixture
```

验证：

- block 数量一致
- block index 一致
- 标准文本一致
- UTF-16 长度一致

## 全量验证

每张迁移卡先运行局部测试，最后运行：

```bash
pnpm typecheck
pnpm test:ts
pnpm test:python
pnpm build
```

本次不修改数据库结构，因此不要求新增数据库 migration。

---

# 十、明确禁止事项

后续 AI 不得在 Reader Core 重构中：

- 重写 ReaderPage。
- 开发 Reading Setup V2。
- 拆分 V1 状态机。
- 删除 operation/lease/fencing。
- 修改数据库 schema。
- 修改 Manifest 版本。
- 修改 Python block v1 算法。
- 除已明确的 camelCase 字段改名外，改变裁读内容生成协议的语义。
- 修改 API URL。
- 顺手整理 `user-books.ts`。
- 引入通用 DDD 框架。
- 把 DOM 或 Cheerio 放进 reader-core。
- 一次迁移全部消费者。
- 为减少少量重复创建抽象工厂或复杂依赖注入。

项目尚未上线，不为开发环境旧产物添加兼容分支；旧产物不符合新 schema 时应重新生成。不得为了兼容本地旧文件擅自放宽所有校验。

---

# 十一、完成标准

Reader Core 重构完成时应满足：

- `packages/reader-core` 是 Manifest 类型的唯一权威来源。
- Reader Core 所有权范围内的 Manifest、位置和 Tailoring 跨模块契约统一使用 camelCase，不保留 snake_case 双写或双读。
- 所有生产 Manifest 在发布前经过运行时校验。
- 正式规范化、preset 和 fixture 发布路径都不能绕过同一个 Manifest 门禁。
- API、Worker、Web 不再定义局部 Manifest 类型，且不重复执行完整 Manifest 语义校验。
- contracts 的 point/range schema 来源于 reader-core。
- Tailoring 不再维护独立的 point/range 比较算法。
- Web DOM 和 Tailoring Cheerio 仍由各自 adapter 处理 HTML。
- Manifest/位置算法不依赖 React、Fastify、Drizzle、DOM 或 Cheerio。
- `reading-nodes-1.0` 的 Block v1、位置和裁读资格语义没有改变；字段命名统一为 camelCase。
- 开发和测试环境旧产物可以按新生成器重新生成，不保留历史兼容分支。
- 类型检查、TypeScript 测试、Python 测试和构建全部通过。
- Reader V2 可以直接以 reader-core 为基础开发。
