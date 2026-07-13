# ReadTailor 文档

## 目录

```text
docs/
  product/       产品目标、用户行为和 MVP 范围
  contracts/     规范化书籍与阅读数据契约
  architecture/  Agent 与技术架构
  project/       当前实施基线和项目决策
```

## 阅读顺序

1. [`project/implementation_baseline.md`](project/implementation_baseline.md)：当前目标、环境和实施顺序。
2. [`product/product_prd.md`](product/product_prd.md)：用户可见行为和验收基线。
3. [`contracts/reading_contract.md`](contracts/reading_contract.md)：阅读节点、block、range、进度和统计。
4. [`contracts/normalized_book_spec.md`](contracts/normalized_book_spec.md)：规范化书籍 `nb-1.0` 契约。
5. [`architecture/agent_design.md`](architecture/agent_design.md)：Agent 职责、工具和权限。
6. [`architecture/technical_architecture_v2.md`](architecture/technical_architecture_v2.md)：当前实现方案。
7. [`architecture/technical_architecture.md`](architecture/technical_architecture.md)：未来系统加固参考。

`product/product_mvp_plan.md` 保存产品方向和背景说明。用户可见行为发生冲突时，以
`product/product_prd.md` 为准。

## 文档优先级

1. 产品行为以 `product/product_prd.md` 为准。
2. 阅读位置和统计以 `contracts/reading_contract.md` 为准。
3. 规范化产物以 `contracts/normalized_book_spec.md` 为准。
4. Agent 边界以 `architecture/agent_design.md` 为准。
5. 当前工程实现以 `architecture/technical_architecture_v2.md` 和
   `project/implementation_baseline.md` 为准。
6. 未标记为当前基线的旧方案只作为背景或未来参考。
