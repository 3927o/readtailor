# 阅读进度恢复准确性修复方案

> 本文件是一份可独立执行的修复规范。实现基线为提交 `612af72`；实现时用符号名定位，行号仅作辅助。

## 0. 目标与范围

本次只修正式阅读器的阅读位置保存与恢复，不改变 `reading_contract.md` 已冻结的
`section_id + segment + block_index + UTF-16 offset` 位置模型，也不引入分页、PDF 或新的阅读模式。

修复目标：

1. 正文内停止、刷新或跨设备重开后，恢复到同一段、尽量同一行。
2. 标题、导读、图片、段间空白等区域不能把已有精确位置覆盖成章节开头。
3. 嵌套列表、图注等祖先 block 与子 block 重叠时，保存到实际文本所属的最内层 block。
4. 多个保存请求乱序到达时，旧观察事件不能覆盖新位置。
5. 字体、图片和增强内容造成首屏回流时，恢复锚点保持稳定；用户主动操作后不再抢滚动。

不在本次范围：阅读百分比口径调整、已读节点规则、划线功能、阅读 session/统计、书籍包 block 算法升级。

## 1. 已确认根因

### 1.1 探针失败会破坏性回退到章节开头

`ReaderPage.tsx` 的 `computeAnchorRef` 只接受 `.reader-original` 内的 caret。探针落在章节标题、导读、
生成状态、节后助读、图片或空白时，会返回当前节点 `{ blockIndex: 1, offset: 0 }`。滚动防抖、首次
300ms 上报和 `visibilitychange/pagehide` 都可能把原有精确位置覆盖成该值。

### 1.2 block 归属选择了祖先 block

当前位置用 `blocks.find(block => block.contains(caret.node))` 取第一个匹配。block 按 DOM 顺序枚举，祖先
先于子孙，因此：

- 嵌套 `li` 的文本被保存到外层 `li`；
- `figcaption` 文本被保存到 `figure`。

外层 `li` 的标准文本投影又会跳过嵌套列表，导致保存 offset 与实际字符不在同一坐标系。

### 1.3 旧请求可以覆盖新请求

前端存在滚动防抖请求、目录跳转请求、首次请求和 page-hide keepalive 请求。`ReaderPosition` 没有
`clientObservedAt`，服务端按请求到达顺序无条件 upsert。较早观察到的位置如果较晚到达，就会成为数据库
中的“最新位置”，与 `reading_contract.md §10.2` 的合并规则不符。

### 1.4 首次恢复后仍会发生布局漂移

恢复只在首次 `useLayoutEffect` 中执行一次。远程字体、未定高宽的图片或随后到达的增强内容改变目标上方高度
后，已恢复字符会离开阅读锚线。`.reader-scroll { scroll-behavior: smooth }` 还可能让首次 300ms 上报采到
恢复动画的中间位置。

## 2. 设计决策

### 2.1 自动采样失败时不覆盖旧位置

自动保存遵循“精确锚点或不保存”：

- caret 命中原文字符时保存精确 block + offset；
- caret 未命中时，尝试从阅读锚线附近的原文 block 推导最近有效字符；
- 如果仍无法得到可靠原文锚点，返回 `null`，本次只允许上报粗粒度 focus，不写 `reader_states`；
- 只有用户明确点击目录跳转时，才允许主动保存目标节点首 block/offset 0。

禁止再次使用“当前节点 block 1”作为自动采样的通用 fallback。

### 2.2 order 与精确位置必须来自同一次采样

把采样结果由 `ReaderPosition | null` 改为：

```ts
interface ObservedReaderAnchor {
  order: number;
  position: ReaderPosition;
}
```

`order`、`sectionId`、`segment` 都从 caret/候选 block 所在的同一个 `[data-node-order]` 元素读取。
调用方不得再把 `currentOrderRef.current` 与另一节点的 position 拼在一起。服务端同时校验 order 对应的
manifest 节点与 `sectionId/segment` 一致；不一致时不保存位置，但不阻塞原文阅读。

### 2.3 使用客户端观察时间合并位置事件

`ReaderPosition` 增加必填 ISO 时间字段：

```ts
clientObservedAt: string // date-time
```

时间在读取 DOM 锚点时生成，目录跳转也在点击时生成；重试同一个事件时保留原时间，不能在发送时刷新时间。
服务端以 `client_observed_at` 做条件 upsert：只有新事件时间大于等于当前记录时才更新。

这不是复杂的多标签页协议，只落实契约已经要求的 last-observed-event-wins。服务端 `updated_at` 继续记录
实际写入时间，但不再作为事件新旧的权威。

### 2.4 恢复采用可中断的短期恢复协调器

“恢复协调器”是本次计划新增的前端临时状态机，不是常驻服务或 UI 组件。它只在首次恢复时运行，
负责把保存的字符 boundary 保持在 `READING_ANCHOR_TOP`，直到首屏布局稳定或用户开始主动操作。

协调器运行期间必须遵守**单一滚动控制权**：只有恢复协调器可以写 `scrollTop`。现有 layout-anchor
可以继续观察 enhancement 版本和记录快照，但不得独立执行滚动补偿；增强内容造成的布局变化也由恢复
协调器重新测量同一个字符 boundary 后统一补偿。否则两个机制可能对同一次 100px 布局变化各补偿一次，
产生 200px 的错误滚动。

恢复分两阶段：

1. DOM 首次可用时立即恢复，临时强制 `scroll-behavior: auto`，避免动画中间态。
2. 在有限稳定窗口内，用保存的 DOM boundary 反复校正到 `READING_ANCHOR_TOP`。

恢复协调器规则：

- 监听阅读内容容器的 `ResizeObserver`、`document.fonts.ready` 和目标之前相关图片的 `load/error`；
- 每次变化后在下一帧重新计算 boundary rect，只补偿 `rect.top - anchorTop`；
- 连续两个 animation frame 无位移，且字体/已知图片已结束后即可提前完成；最长 1500ms，避免无限占用；
- `wheel`、`touchstart`、`pointerdown`、导航键等用户主动输入立即取消协调器；
- 协调器完成或取消前，禁止 300ms warm report 和滚动防抖保存，防止把中间位置写回；
- 完成后只上报一次最终稳定锚点。

滚动控制权交接顺序固定为：

1. `restoring`：恢复协调器是唯一 scroll writer，layout-anchor 只观察、不补偿。
2. `settled`：协调器完成最后一次字符 boundary 校正并上报最终锚点，然后停止监听。
3. `cancelled`：用户主动操作后协调器立即停止，不再进行最后校正；本次用户滚动由正常滚动保存链路接管。
4. `normal`：现有 layout-anchor 恢复滚动补偿，只处理交接之后发生的 enhancement 布局变化。

现有 layout-anchor 逻辑继续保留，但不能与恢复协调器同时写滚动位置。恢复协调器以“具体字符 boundary”为锚，
不以整个 node 顶部为锚；交接完成后，layout-anchor 才继续使用现有节点快照策略。

## 3. 前端实现

### 3.1 抽出可测试的位置工具

在 `apps/web/src/reader/content.ts` 增加或导出以下纯工具：

```ts
readingBlockForDomPoint(blocks, node): HTMLElement | null
nearestReaderAnchor(contentRoots, anchorX, anchorY): ReaderDomAnchor | null
```

`readingBlockForDomPoint` 从 caret 节点向上遍历祖先，返回遇到的第一个 block 集合成员，而不是对 blocks 做
正向 `find(contains)`。这样内层 `li`、`figcaption`、段落内 inline 元素都归到最近 block。

`nearestReaderAnchor` 的顺序：

1. 优先使用浏览器 caret API 的精确命中。
2. 未命中时，收集阅读锚线附近的 `.reader-original` block，按锚线到 block rect 的垂直距离排序。
3. 对有标准文本的候选 block，用 `domBoundaryForOffset` + collapsed range rect 在 offset 空间二分，找最接近
   锚线的可见字符边界。
4. 对纯媒体 block 保存 offset 0，并以 block 顶部作为恢复几何位置。
5. 没有可靠 boundary/rect 时返回 `null`，不制造章首位置。

### 3.2 重构保存入口

`computeAnchorRef` 返回 `ObservedReaderAnchor | null`。滚动防抖、page-hide 和 warm report 共用同一结果：

- 有精确 anchor：发送 `{ order: anchor.order, position: anchor.position }`；
- 无精确 anchor：普通滚动/隐藏不写位置；如需维持生成窗口，可单独发送 `{ order: currentOrder }`，但必须
  避免高频重复；
- 目录跳转：立即生成目标首 block 的显式 anchor，并使用相同的 `clientObservedAt` 发送。

卸载时若无法采样，不发送破坏性 fallback；上一次成功保存的位置优于错误的新位置。

Reader 内增加明确的恢复阶段引用，例如 `restorePhaseRef`。layout-anchor effect 在阶段为 `restoring` 时不得
修改 `scrollTop`；enhancement 变化只触发恢复协调器下一帧重新测量。阶段进入 `settled`、`cancelled` 或
`normal` 后，layout-anchor 才能处理后续变化，避免两个 effect 同时补偿。

### 3.3 恢复与失效回退

恢复顺序对齐 `product_prd.md §11.5`：

1. 精确 node + block + offset；
2. 同一 node 的首个有效 block；
3. 按已存 `nodeOrder` 选择最近有效 manifest node；
4. 最后才回到书首。

为支持第 3 步，bootstrap 的恢复数据应带服务端保存的 `nodeOrder` 和 `manifestVersion` 元数据。若
`manifestVersion` 与当前 manifest 不同，不直接解释旧 block/offset，进入回退链并记录可观测日志。

## 4. 契约、数据库与 API

### 4.1 契约

修改 `packages/contracts/src/index.ts`：

- `ReaderPositionSchema` 增加 `clientObservedAt: Type.String({ format: 'date-time' })`；
- bootstrap 返回的 resume position 保留该字段；
- 如采用包装类型，新增 `ReaderResumePositionSchema`，额外带 `nodeOrder`、`manifestVersion`，不要把数据库
  元数据混入划线共用的通用 TextPosition。

### 4.2 数据迁移

新增迁移，不修改已经提交的 `0015`：

```sql
ALTER TABLE reader_states ADD COLUMN client_observed_at timestamptz;
UPDATE reader_states SET client_observed_at = updated_at WHERE client_observed_at IS NULL;
ALTER TABLE reader_states ALTER COLUMN client_observed_at SET NOT NULL;
```

同步 `packages/database/src/schema.ts`。现有记录用 `updated_at` 回填，保证升级后仍可恢复。

### 4.3 条件写入

位置 upsert 生成等价 SQL：

```sql
ON CONFLICT (user_book_id) DO UPDATE SET ...
WHERE excluded.client_observed_at >= reader_states.client_observed_at
```

保存前从当前 manifest 按 `order` 查节点，校验其 `section_id/segment` 与 position 一致。无效事件不覆盖
reader state；生成窗口维护仍可 best-effort 执行。

API 返回 bootstrap 时，旧请求即使较晚完成，也不能让 React Query 缓存倒退：前端比较
`resumePosition.clientObservedAt`，只接受不旧于当前缓存的响应，或把位置保存与 bootstrap 刷新拆成两个职责明确
的端点。首选前者，保持本次改动范围较小。

## 5. 测试计划

### 5.1 content 单元测试

补充 `apps/web/src/reader/position.test.ts`：

- 嵌套 `li` 的文本选择内层 block，并在保存/恢复后回到相同 offset；
- `figcaption` 文本选择 figcaption，不选择 figure；
- inline 元素仍归属外层段落 block；
- caret miss 时选择锚线最近的原文字符；
- 标题/导读/空白附近无可靠原文时返回 null，不返回 block 1；
- block 末尾 boundary 没有 rect 时使用最近有效字符边界，不退整段顶部。

### 5.2 Reader 行为测试

将恢复协调器抽为可注入 rect/时钟的 helper 或 hook，覆盖：

- 恢复时强制 instant scroll；
- 字体/图片回流后字符仍位于阅读锚线；
- 用户滚动立即取消补偿；
- 稳定结束前不触发位置保存，结束后只保存一次；
- 恢复窗口内 enhancement 到达时只有恢复协调器补偿一次，layout-anchor 不重复写 `scrollTop`；
- 协调器 settled/cancelled 后，后续 enhancement 才由 layout-anchor 接管；
- 位置失效按“同节点首 block → 最近节点 → 书首”回退。

### 5.3 API 与数据库测试

- 较新事件先写、较旧事件后到：最终保留较新事件；
- 较旧事件先写、较新事件后到：正常更新；
- 相同时间重试幂等；
- order 与 section/segment 不一致时不覆盖位置；
- 旧数据库记录迁移后 `client_observed_at` 等于原 `updated_at`；
- route schema 拒绝缺失或非法的 `clientObservedAt`。

### 5.4 技术检查

```text
pnpm exec vitest run apps/web/src/reader/position.test.ts apps/web/src/reader/content.test.ts
pnpm exec vitest run apps/api/src/user-books-routes.test.ts
pnpm --filter @readtailor/web typecheck
pnpm --filter @readtailor/api typecheck
pnpm build
```

按项目约定不使用浏览器自动化作为 UI 验收。

## 6. 实施顺序与提交拆分

1. `fix(reader): 修正阅读锚点采样与 block 归属`
   - content helper、非破坏性 fallback、order/position 同源、单元测试。
2. `fix(reader): 阻止旧位置事件覆盖新进度`
   - contract、数据库迁移、条件 upsert、API/数据库测试、缓存防倒退。
3. `fix(reader): 稳定首次阅读位置恢复`
   - instant restore、可中断恢复协调器、单一滚动控制权、保存抑制、失效回退、行为测试。

每个提交只包含对应 requirement，迁移与使用该迁移的代码放在同一个提交中。

## 7. 项目所有者手动验收

实现完成后需手动检查以下流程和状态：

1. 正文段落中部停留后刷新，桌面和手机宽度分别回到同一段、接近同一行。
2. 停在章节标题、导读、图片、段间空白和节后助读附近切后台，再打开不跳回章节开头。
3. 嵌套列表子项、图片图注中停留后刷新，恢复到对应子项/图注。
4. 网络慢或快速滚动后立即退出，再打开不会退回更早位置。
5. 首次打开时字体或图片晚加载，页面不在加载结束后明显漂移。
6. 恢复动画期间主动滚动，页面立即服从用户，不再被程序拉回。
7. 目录跳转后立即退出，重开恢复到目标章节开头。

验收失败时优先记录：保存前后的 `section/segment/block/offset/clientObservedAt`、viewport 尺寸、目标 block
标签，以及恢复期间是否发生字体/图片/enhancement 布局变化。
