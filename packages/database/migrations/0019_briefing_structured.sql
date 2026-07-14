-- briefing_structured: 读前简报从自由文本升级为结构化对象（这是一本什么书 / 全书怎么走 /
-- 假设你已经知道 / 建议你的读法）。既有纯文本不是合法 JSON，故用 jsonb_build_object 无损迁入
-- bookIdentity，其余三段留空串（读侧宽松、只按有内容的段渲染），迁移不丢数据也不因非法 JSON 失败。
ALTER TABLE "strategy_draft_versions" DROP CONSTRAINT "strategy_draft_versions_content_nonempty";--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ALTER COLUMN "reading_briefing" SET DATA TYPE jsonb USING jsonb_build_object('bookIdentity', "reading_briefing", 'arc', '', 'assumedKnowledge', '', 'readingAdvice', '');--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_content_nonempty" CHECK (jsonb_typeof("strategy_draft_versions"."reading_briefing") = 'object' and length(btrim("strategy_draft_versions"."user_facing_summary")) > 0);