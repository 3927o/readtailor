# 阶段 4：补齐日常阅读能力（实施方案）

> 本文件是一份**可独立执行的实施规范**。新会话拿到它即可开工，不依赖任何对话上下文。
> 行号锚点为撰写当时状态，实现前请以实际代码为准（用符号名定位，行号仅辅助）。

## 0. 元信息

- **范围**：`implementation_baseline.md §4「阶段 4：补齐日常阅读能力」`的四条落地——
  1. 目录、连续滚动、阅读设置和**位置恢复**；
  2. 原书注、裁读注、**划线和划线笔记**；
  3. **阅读 session、有效活动、基础统计和预计剩余时间**；
  4. 当前节点和后续三个可裁读节点的**生成调度**。

  其中「目录 / 连续滚动 / 两类注释 / 生成调度」核心链路已实现（见 §1 盘点），本方案的活集中在
  **位置恢复、阅读设置持久化、划线与笔记、阅读统计**四块空地。**不含**问 AI（阶段 6）、用户上传
  规范化（阶段 5）。
- **真源头优先级**（沿用 `docs/README.md` 与 `implementation_baseline.md §1`）：用户可见行为以
  `product/product_prd.md` 为准（本方案主要对齐 **§3.10 / §11.4–§11.10**）；阅读位置 / block / range /
  进度 / 统计口径以 `contracts/reading_contract.md §2` 为准；工程实现以
  `architecture/technical_architecture_v2.md` + 本文件。
- **前置阅读**：`product_prd.md §11.4`（已读标记）`§11.5`（位置进度）`§11.6`（设置）`§11.7`（划线笔记）
  `§11.8`（有效时间）`§11.9`（统计）`§11.10`（剩余时间）`§3.10`（阅读记录与统计）；
  `reading_contract.md §2.3/§2.4/§2.5`（Block、枚举算法、标准文本与 offset）、开头「manifest 算法版本
  冻结」约束（:29-30）。
- **已锁定的决策**（本次讨论产出，不再重开）：
  1. **阅读设置**存**服务端 per-user（全局）+ 本地缓存**：跨书、跨设备一致（`PRD §11.6` 要求跨设备
     同步），localStorage 只作即时应用的缓存，避免首屏闪烁。设置**不**挂进 `reader_profiles`（那是知识
     背景/解释偏好的长期画像，语义不同）。
  2. **位置恢复精确到 `block_index + UTF-16 offset`**（`PRD §11.5` 明令、验收 :1465「保存并跨设备
     恢复到 block + offset」），与用户划线、AI 注释**共用同一套 `section_id + segment + range` 位置模型**
     （`reading_contract §2.5`、`PRD §11.7`）。
  3. **§6.1 前后端 block 枚举统一**（`core_flow_refactor.md §6.1`，当前 `content.ts` 未提交改动）已
     基本完成，确认后并入，**作为本批活的地基先落地**（理由见 §2）。

---

## 1. 现状盘点（对着 baseline §4 四条）

| 阶段 4 条目 | 现状 | 判定 |
|---|---|---|
| 目录 / 连续滚动 | `ReaderPage.tsx` `TocDrawer` + IntersectionObserver 当前节点高亮 | ✅ 已有 |
| 阅读设置（字号/行距/版心/主题） | UI 全在（`SettingsPanel`），但只是 `useState(defaultSettings)`，**不持久化、不跨设备** | ⚠️ 差持久化 |
| 位置恢复 | `currentOrder` 恒从 `nodes[0]` 起；`user_books` 无位置列；`reportReaderFocus` 只驱动生成、**不存"读到哪"** | ❌ 空地 |
| 原书注 / 裁读注 | noteref 弹窗 + 绿点下划线弹窗（`content.ts` `applyAnnotationMarks`、`NotePopover`） | ✅ 已有 |
| 划线 / 划线笔记 | 完全没有：无选区处理、无 highlights 表、无渲染 | ❌ 空地 |
| 阅读 session / 有效活动 / 统计 / 剩余时间 | 完全没有（`reader/api.ts` 只有 `estimatedRemainingSeconds` 早期占位注释） | ❌ 空地 |
| 当前+后续 3 个可裁读节点生成调度 | `ensureFormalWindow` + `reportReaderFocus`（`user-books.ts`，= `core_flow_refactor §6.2 / P4`）已实现 | ✅ 已完成（仅验证） |

**结论**：第 4 条不重做，只排一次验证（§6）。真正的工程是**位置恢复、设置持久化、划线笔记、
阅读统计**四块，且前三者共用同一根「位置模型」脊椎（§2）。

---

## 2. 位置模型：这批活的共用脊椎（先读，决定顺序）

位置恢复、划线、（统计的稳定阅读位置）本质上都落在**同一个 `section_id + segment + block_index +
UTF-16 offset` 位置模型**上——`reading_contract §2.5`、`PRD §11.5/§11.7` 明确三者同源。

`content.ts` 已经有了这套机器的**正向**：

- `annotationBlocks(container)`——按 `reading_contract §2.4` v1 规则枚举 block、打 `data-block-index`。
- `boundaryAt(root, targetOffset, bias)`——把 block 内 UTF-16 字符偏移映射回**具体 DOM 边界**（container
  + offset），用于浏览器创建 Range（正是 `reading_contract §2.5 :109` 要求保留的「标准文本字符 → DOM
  Text 节点位置」映射）。
- `applyAnnotationMarks(html, annotations)`——把 range 包成 `<mark>`。

本批活要补的是**反向**与**复用**：

- **反向（划线用）**：DOM `Selection` → `{block_index, offset}`。必须**严格复用** `annotationBlocks` 的
  同一套投影规则（`<br>`=`\n`、跳嵌套列表、media 不计字符、不做 Unicode 规范化/trim/空白折叠），否则划线
  锚点与注释锚点会在同一段原文上算出不同 offset。
- **复用（位置恢复用）**：用 `boundaryAt` 把保存的锚点复位到具体段落。

> **两个直接推论**：
>
> 1. **§6.1 必须先落地。** 划线与位置锚点都建在 block 枚举上。若建在还没统一的枚举上（前端把
>    `div[data-role="separator"]` 也当 block、后端不当，`reading_contract §2.4 规则 6`），会继承同款
>    「静默错位一格 / 丢锚点」bug——而且这次错位的是**用户自己存的划线**，比错位一条 AI 注释更严重。
>    `reading_contract` 开头（:29-30）把「已有划线/笔记的书籍包上不得破坏 block/offset」列为**必须显式
>    迁移**的红线。§6.1 是这条红线的前提。
> 2. **`reportReaderFocus` 是位置恢复的天然落点。** 它已在滚动（防抖）和跳转时触发、走同一条 mutation，
>    现在只带 `{order}`、只驱动生成窗口、**不落库**。把 payload 扩到完整锚点并 upsert 存储，位置恢复几乎
>    白捡——「报告焦点驱动生成」与「保存位置用于恢复」本是同一信号的粗/细两种粒度，无需第二条链路。

---

## 3. 4A · 位置 + 设置持久化（骨架，先做）

### 3.1 数据模型

```text
reader_states          -- per user-book，最后阅读位置（§11.5）
  user_book_id  uuid pk/fk -> user_books.id
  section_id    text
  segment       int
  block_index   int
  offset        int          -- UTF-16 code unit，[start] 单点即可
  node_order    int          -- manifest 冗余，便于窗口/进度快速判断，非权威
  updated_at    timestamptz

user_reading_settings  -- per user（全局），表现层设置（§11.6）
  user_id     uuid pk/fk -> users.id
  settings    jsonb        -- { fontSize, lineHeight, contentWidth, theme }
  updated_at  timestamptz

reader_read_nodes      -- 已读节点标记（§11.4），一旦已读不回退
  user_book_id  uuid  fk -> user_books.id
  section_id    text
  segment       int
  marked_at     timestamptz
  pk(user_book_id, section_id, segment)
```

- `reader_states` 一本书一行，`updated_at` 用于跨设备 last-write-wins（`PRD` 多标签页口径「最后一次
  成功写入」:1399；≤5 用户，不做向量时钟）。
- **迁移约束**（`reading_contract :29-30`）：`reader_states` / `highlights` 的 `block_index/offset` 绑定
  书籍包的 manifest 算法版本；未来升级 Block/manifest 算法必须写显式迁移，不能静默改动已存锚点。为此建议
  在 `reader_states`（及 §4 `highlights`）加 `manifest_version`（从 `reading_manifest.version` 落），供
  将来迁移识别。

### 3.2 端点与契约

- **扩 `POST /v1/user-books/:id/reader/focus`**（`app.ts:824`，或另开 `/reader/position` 语义更清晰）：
  - 请求 `ReaderFocusRequest` `{order}` → `ReaderPositionRequest`
    `{ order, sectionId, segment, blockIndex, offset }`。
  - handler `reportReaderFocus`（`user-books.ts`）：`order` 变化时维护生成窗口（现有 `ensureFormalWindow`），
    **每次都 upsert `reader_states`**（best-effort，失败不阻塞阅读，`§14.3`）。
  - **去重坑**：前端现有 `reportedOrder.current === order` 去重会吞掉**节点内**滚动。改为每次防抖 tick
    上报完整锚点；后端「order 变了才动窗口、位置总是存」。
- **`GET /v1/user-books/:id/reader`（bootstrap）** 补两个字段：
  - `resumePosition: { sectionId, segment, blockIndex, offset } | null`
  - `settings: ReadingSettings`（用户全局设置，随 bootstrap 下发，避免额外往返）
- **设置写入 `PUT /v1/me/reading-settings`**：body `ReadingSettings`；upsert `user_reading_settings`。
- **已读标记 `POST /v1/user-books/:id/reader/read-nodes`**：body `{sectionId, segment}`，幂等插入。
  （也可并入 focus 上报，但语义上「已读」是单调集合，单独端点更清晰。）
- 契约（`packages/contracts/src/index.ts`）：新增 `ReadingSettingsSchema`、`ReaderPositionRequestSchema`；
  `ReaderBootstrap` 扩 `resumePosition` / `settings`。`reader` 端点当前 schema 若仍是 `Type.Unknown()`
  （`core_flow_refactor §5` 已提），一并补正式 `ReaderBootstrap` schema。

### 3.3 前端

- **恢复**（`ReaderPage.tsx`）：首帧不再从 `nodes[0]` 起。加载后按 `resumePosition`：
  1. 定位 `section_id+segment` 节点 → 用 `boundaryAt` 在该节点内定位到 `blockIndex/offset` 的 DOM 边界 →
     `scrollIntoView`。
  2. **回退链**（`PRD §11.5`）：位置失效 → 同一节点首个有效 block → 再失败 → 最近有效节点。
  3. 恢复要在内容与 enhancement 首次 commit 后执行，且**不与现有 layout-anchor 抢滚动**（先恢复，再交给
     anchor 维持稳定）。
- **保存节流**（`PRD §11.5`）：滚动期间防抖保存；**切换节点、`visibilitychange` 隐藏、返回书架前**立即
  保存（`beforeunload` / `pagehide` 兜底）。
- **设置**：bootstrap 下发的 `settings` 为准，写入 localStorage 作下次首屏即时缓存；改设置 → 即时预览 +
  防抖 `PUT`。设置**只影响表现层**，严禁参与 block 枚举/offset/进度计算（`PRD §11.6`）。
- **已读标记**（`PRD §11.4`）：节点原文进入可视区 **且** 页面可见 → 标记已读（复用现有
  IntersectionObserver），单调、幂等上报。

### 3.4 验收（4A）

- 章中刷新 → 回到**同一段落**（block+offset 命中，`PRD §11.5`、验收 :1465）；A 设备改字号/主题 → B 设备
  refetch 生效（`§11.6`、验收 :1515）；恢复后生成窗口仍随位置续上（§6 不回归）。
- 位置失效时按回退链落到同节点首 block / 最近节点，不白屏。

---

## 4. 4B · 划线 + 划线笔记（大头，风险集中）

### 4.1 数据模型

```text
highlights             -- per user-book，一个划线可选关联一条笔记（§11.7）
  id            uuid pk
  user_book_id  uuid fk -> user_books.id
  section_id    text            -- 同一阅读节点内（§11.7：不跨节点）
  segment       int
  range         jsonb           -- { start:{block_index,offset}, end:{block_index,offset} }（§2.5，[start,end)）
  manifest_version text          -- 锚点所绑定的 manifest 算法版本（迁移用）
  note          text null        -- 划线笔记，可空
  quote_snapshot text            -- 划线时的标准文本快照，便于列表展示与锚点漂移时的兜底
  created_at    timestamptz
  updated_at    timestamptz
```

- **只有基于划线的笔记**：无 `note` 的独立行 = 纯划线；`note` 非空 = 划线+笔记。**不建**书签表、不建独立
  笔记表（`PRD §11.7`、验收 :1469）。
- 删除语义（`PRD §11.7`）：删笔记 = `note` 置空、保留划线；删划线 = 删整行（含当前 `note`）。**都不得**影响
  由该划线发起的历史问 AI 会话（阶段 6 的会话表通过 `origin_range` 快照而非外键引用 highlight，见 §12
  开放问题）。

### 4.2 端点与契约

- CRUD：
  - `GET /v1/user-books/:id/highlights` → 列表（bootstrap 也可顺带下发首屏可见节点的划线）。
  - `POST /v1/user-books/:id/highlights` `{sectionId, segment, range, note?}` → 校验后落库，返回稳定 id
    （`PRD :1383` 要求笔记/划线由服务端返回稳定 id）。
  - `PATCH /v1/user-books/:id/highlights/:hid` `{note}` → 编辑/清空笔记。
  - `DELETE /v1/user-books/:id/highlights/:hid` → 删划线。
- 服务端校验：`range` 起止在**同一 `section_id+segment`** 内、`block_index` 落在该节点 block 范围、
  `start <= end`、`offset` 非负。不做模糊匹配，越界整条拒绝（与注释锚点解析一致，`reading_contract §6`）。
- 契约新增 `HighlightSchema`（复用 `TextRangeSchema`，`contracts:384`）、CRUD 请求/响应类型。

### 4.3 前端

- **选区 → range**（`content.ts` 新增导出，如 `rangeFromSelection(nodeRoot, selection)`）：
  - 校验选区两端在**同一阅读节点**内（跨节点则禁用「保存划线」，`PRD §11.7`）。
  - 用 `annotationBlocks` 的同一投影把 DOM 边界折回 `{block_index, offset}`；跨 block 选区取
    `start.block < end.block`。这是 `boundaryAt` 的反函数，**必须与之对称**（同一套 `<br>/嵌套列表/media`
    规则），否则存进去的划线复位时会漂。
- **渲染**：把高亮并入 `applyAnnotationMarks` 的**同一趟 mark pass**（新增高亮 mark 类型），而非独立
  absolute overlay：
  - 好处：天然进 `prepareBookContent` memo，被现有 layout-anchor（`ReaderPage.tsx` 的 `useLayoutEffect`
    防滚动跳变）覆盖；随字号/版心重排自动跟随；主题切换无需重算坐标。
  - **难点（本片主要风险）**：高亮与裁读注 `<mark>` 的**重叠**与**跨块**。需按 offset 切分成不重叠的
    区段，逐段决定叠加样式（高亮底色 + 注释绿点下划线可共存于同一字符）。加**重叠 + 跨块 + 与注释同段**的
    单测。
- **交互**：
  - 选区浮起工具条：`问 AI`（阶段 6 占位/禁用）/ `划线` / `划线+笔记`。
  - 点已有高亮 → 复用 `NotePopover` 看/改/删笔记、删划线。
  - 划线列表：书籍菜单（`BookInfoPanel` 旁）加入口，列出本书划线（`quote_snapshot` + 笔记），点击跳回
    原文 range（复用 4A 的 `boundaryAt` 复位 + `scrollIntoView`）。
- **重渲染稳定性**：新增/删除划线导致内容重排时，沿用 4A/enhancement 的 anchor 快照逻辑，保持当前段落
  视觉不跳。

### 4.4 验收（4B）

- 跨 block 选区 → 落库 → 刷新原位重现（验收 :1517「划线加笔记后重开回到对应原文位置」）；一个划线可单独
  存也可关联可编辑/可删的笔记（验收 :1470）；删笔记保留划线、删划线连带删笔记但不删历史会话（`§11.7`）；
  高亮与注释在同段重叠时两者都正确渲染；无书签、无独立笔记入口（验收 :1469）。

---

## 5. 4C · 阅读 session / 有效活动 / 统计 / 剩余时间

### 5.1 数据模型

```text
reading_sessions       -- 有效阅读区间（§11.8）
  id            uuid pk
  user_book_id  uuid fk -> user_books.id
  user_id       uuid fk -> users.id
  started_at    timestamptz
  ended_at      timestamptz null
  effective_seconds int not null default 0   -- 只累计有效区间，不补记空闲
  forward_chars int not null default 0        -- 仅"正常向前读原文"的字符推进量（§11.10 分子/分母）
  updated_at    timestamptz

daily_reading_totals   -- 每日有效时长汇总（§11.9 连续天数 + PRD :1205 隐私口径）
  user_id      uuid
  day          date            -- 用户时区自然日
  effective_seconds int
  pk(user_id, day)             -- 只存 user/day/秒，不含书名/位置/笔记
```

- **有效时间口径**（`PRD §11.8`，严格照做）：仅当「在正式阅读器 + 页面前台可见 + 近期有滚动/触摸/点击/
  键盘/位置变化」时累计；进后台/失活/空闲超阈值 → 暂停并结束当前区间，恢复活动开新区间，**不补记空闲**。
  客户端周期 heartbeat，节点切换/页面隐藏/返回书架/正常退出时立即提交；**网络重试不得重复累计同一区间**
  （用客户端区间 id 幂等）。
- **速度口径**（`PRD §11.10`）：`forward_chars` 只在「用户正常向前读原文」时累加；回读、目录跳转、停留
  不动、读导读/注释/助读的时间计入 `effective_seconds` 但**不进** `forward_chars`/其对应时间；目录大跳
  不得当作读完中间。→ 需要客户端把「有效时间」与「前进阅读时间/字符」分开上报。

### 5.2 端点与契约

- `POST /v1/user-books/:id/reading-sessions/heartbeat`：`{ clientIntervalId, effectiveSeconds,
  forwardChars, at }`，服务端按 `clientIntervalId` 幂等累加到当前 session；顺带滚动进 `daily_reading_totals`。
- `GET /v1/me/reading-stats`（全局）：今日 / 本周 / 累计有效时长 + 连续阅读天数（`§11.9`）。
- `GET /v1/user-books/:id/reading-stats`（按书）：累计时长 / 最近阅读时间 / 全书进度 / 预计剩余时间。
- **剩余时间**（`§11.10`）在按书 stats 内计算：`剩余原文字符 / 有效阅读速度`。剩余原文字符 = manifest
  原文总字符 − 当前稳定位置之前字符（复用 `ReaderPage` 现有 `charactersBefore/totalCharacters` 口径，只算
  原文）。速度：样本不足 → 按语言配置默认速度、展示为近似（「约 X 小时」）；样本足够 → 切该书个人速度。
  阈值/默认速度/异常过滤为实现参数，不进普通 UI。
- 契约新增 `ReadingStatsGlobal` / `ReadingStatsPerBook` / `HeartbeatRequest`。`reader/api.ts` 早期占位的
  `estimatedRemainingSeconds` 用真实值填上。

### 5.3 前端

- **活动探测**（`ReaderPage.tsx` 或抽 `reader/session.ts`）：监听滚动/pointer/键盘/位置变化 → 维持
  「活跃」；`visibilitychange` + 空闲计时器（阈值实现参数）→ 暂停。区间累计有效秒与前进字符，heartbeat
  周期提交，`pagehide`/返回时 flush。前进字符量：由 `currentOrder` 单调前进跨过的原文字符估算（跳转/回读
  不计）。
- **展示**：按书剩余时间 + 进度挂进度条旁与 `BookInfoPanel`；新增阅读统计视图（`PRD` MVP 页 :368「阅读
  统计页或统计视图」）：全局今日/本周/累计/连续天数 + 按书列表。

### 5.4 验收（4C）

- 活动 2 分 + 挂机 5 分 → 有效 ≈ 2 分，不补记空闲（`§11.8`）；断网重试不重复累计；统计展示今日/本周/
  累计/连续天数（验收 :1472）；数据不足用默认速度显示近似剩余、样本足够改用个人速度（验收 :1474）；结束
  一次有效阅读后再进统计视图立即看到已提交数据（`§11.9`）。

---

## 6. 第 4 条：生成调度（已完成，仅验证）

`ensureFormalWindow` + `reportReaderFocus`（`user-books.ts`）已实现「当前 + 后续 3 个可裁读节点」窗口与
跳转提权（= `core_flow_refactor §6.2 / P4`，`PRD §11.3`）。**不排开发**，只排一次回归验证，且要确认与 4A
的位置持久化**共用同一次 focus 上报**、互不破坏：

- reload 后按 `resumePosition` 恢复 → focus 上报 → 窗口在恢复位置附近续上 ready/generating。
- 跳转任意节点 → 立即显示原文 + 目标节点及后 3 个提权；附加层就绪不改变滚动位置（`PRD §11.3`）。

---

## 7. 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/database/src/schema.ts` | 新增 `reader_states` `user_reading_settings` `reader_read_nodes`（4A）；`highlights`（4B）；`reading_sessions` `daily_reading_totals`（4C）+ Drizzle migration |
| `packages/contracts/src/index.ts` | `ReadingSettingsSchema`、`ReaderPositionRequestSchema`、`ReaderBootstrap`+`resumePosition`/`settings`、`HighlightSchema` + CRUD、`ReadingStats*`/`HeartbeatRequest`；补 `reader` 端点正式 schema |
| `apps/api/src/user-books.ts` | `reportReaderFocus` 落 `reader_states`（4A）；`buildReaderBootstrap` 加 `resumePosition`/`settings`；highlight CRUD + 校验（4B）；session heartbeat + stats + 剩余时间服务（4C）；已读标记 |
| `apps/api/src/app.ts` | 扩 `/reader/focus`；新增 `/reader/read-nodes`、`/me/reading-settings`、`/highlights` CRUD、`/reading-sessions/heartbeat`、`/me/reading-stats`、`/user-books/:id/reading-stats` |
| `apps/web/src/reader/content.ts` | 新增 `rangeFromSelection`（选区→range，`boundaryAt` 反函数）；高亮并入 `applyAnnotationMarks` mark pass；恢复用 `boundaryAt` 复位（§6.1 统一枚举为前提） |
| `apps/web/src/reader/ReaderPage.tsx` | 位置恢复 + 节流保存 + 已读标记（4A）；选区工具条 + 高亮渲染 + 划线列表（4B）；活动探测 + heartbeat + 剩余时间/统计展示（4C）；设置读服务端+localStorage |
| `apps/web/src/reader/api.ts` | position/settings/highlights/session/stats 客户端；`estimatedRemainingSeconds` 填真值 |
| `apps/web/src/reader/session.ts`（新） | 有效活动探测与 heartbeat 累计（可选拆分） |
| 阅读统计视图（新页/侧栏） | 全局 + 按书统计（`PRD` MVP 页 :368） |

---

## 8. 建议实施顺序

分期落，每期可独立验收、可回滚。

1. **前置 · §6.1 block 枚举统一并入**（`core_flow_refactor §6.1`，已基本完成）——所有精确锚点的地基。
2. **4A · 位置 + 设置持久化**——最小、日均价值最高，且把「锚点存取 / `boundaryAt` 复位」机器跑通，为 4B
   铺路降险。含已读标记与进度口径。
3. **4B · 划线 + 划线笔记**——在 4A 的锚点机器上加「选区→range」反向与高亮渲染。风险最集中，留足测试。
4. **4C · session / 有效活动 / 统计 / 剩余时间**——耦合最低，放最后。
5. **第 4 条生成调度**——只做一次回归验证（§6），穿插在 4A 之后确认与位置持久化协同。

---

## 9. 验收标准（对着 doc 条款）

- **4A**：章中刷新与跨设备恢复到 **block + offset**（`PRD §11.5`、验收 :1465）；位置失效走「同节点首
  block → 最近节点」回退链；设置即时预览且跨设备同步、只作用表现层不改 block/offset/进度（`§11.6`、
  验收 :1515）；节点有效停留标记已读且不回退（`§11.4`）。
- **4B**：同一节点内可跨 block 选区并保存划线；一个划线可单独存或关联可编辑/可删笔记（验收 :1470）；删
  笔记保留划线、删划线连带删当前笔记但不删历史问 AI 会话（`§11.7`）；划线加笔记后重开回到对应原文位置
  （验收 :1517）；无书签、无独立笔记（验收 :1469）；高亮与注释同段重叠均正确渲染。
- **4C**：有效时间口径正确（活动累计、空闲不补记、断网不重复计）（`§11.8`）；全局统计含今日/本周/累计/
  连续天数、按书含累计/最近/进度/剩余（`§11.9`、验收 :1472）；剩余时间数据不足用默认速度近似、足够改个人
  速度（`§11.10`、验收 :1474）；只有正常向前读原文进入速度分子/分母（`§11.10`）。
- **第 4 条**：读到第 5+ 个可裁读节点其增强已 ready 或在生成；恢复位置后窗口续上；跳转提权且不改滚动
  位置（`§11.3`）。

---

## 10. 开放问题（需要确认，不阻塞开工）

1. **划线与问 AI 会话解耦**：`PRD §11.7` 要求「删划线不得删由它发起的历史问 AI 会话」。建议阶段 6 的问
   AI 会话保存**发起时的 `origin_range` 快照**（值拷贝），不以外键引用 `highlights.id`，从根上避免级联。
   本方案 `highlights` 不预留反向引用。
2. **多标签页/跨设备冲突**：`reader_states` 与 `highlights` 采用「最后一次成功写入」（`PRD` :1399），
   不做合并。位置事件按服务端时间 + 客户端位置综合（`PRD` :1385）即可，≤5 用户不建向量时钟。
3. **连续阅读天数的时区**：`daily_reading_totals.day` 按用户时区自然日；首发是否需要用户可配时区，还是取
   浏览器时区即可？建议取浏览器时区、随 heartbeat 上报。
4. **默认阅读速度按语言配置**：`§11.10` 要求语言级默认速度与样本阈值为实现参数。首发是否只配中/英两档
   即可？建议是，其他语言回退到一个通用默认。
5. **设置存储位置**：已决 `user_reading_settings`（新表，per user）。若倾向更省表，可挂 `users` 的一个
   `reading_settings jsonb` 列——两者皆可，新表更利于将来扩展，本方案默认新表。
