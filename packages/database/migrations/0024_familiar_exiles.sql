CREATE TABLE "strategy_change_proposal_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_change_proposal_actions_action_valid" CHECK ("strategy_change_proposal_actions"."action" in ('feedback', 'confirm', 'reject')),
	CONSTRAINT "strategy_change_proposal_actions_idempotency_nonempty" CHECK (length(btrim("strategy_change_proposal_actions"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "strategy_change_proposal_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"triggering_message_id" uuid NOT NULL,
	"strategy_draft_version_id" uuid NOT NULL,
	"public_summary" text NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_change_proposal_revisions_revision_positive" CHECK ("strategy_change_proposal_revisions"."revision" > 0),
	CONSTRAINT "strategy_change_proposal_revisions_summary_nonempty" CHECK (length(btrim("strategy_change_proposal_revisions"."public_summary")) > 0)
);
--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" DROP CONSTRAINT "strategy_draft_versions_approval_valid";--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD COLUMN "source_qa_session_id" uuid;--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD COLUMN "source_qa_message_id" uuid;--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD COLUMN "change_reason" text;--> statement-breakpoint
ALTER TABLE "reader_read_nodes" ADD COLUMN "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "current_strategy_draft_version_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "base_strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "origin_section_id" text;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "origin_segment" integer;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD COLUMN "origin_node_order" integer;--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD COLUMN "source_qa_message_id" uuid;--> statement-breakpoint
UPDATE "reader_read_nodes" AS read_node
SET "strategy_version_id" = user_book."current_strategy_version_id"
FROM "user_books" AS user_book
WHERE user_book."id" = read_node."user_book_id";--> statement-breakpoint
CREATE TEMP TABLE "_phase6_proposal_backfill" (
	"proposal_id" uuid PRIMARY KEY,
	"draft_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"base_strategy_version_id" uuid NOT NULL,
	"book_reader_profile_version_id" uuid NOT NULL,
	"source_draft_version_id" uuid NOT NULL,
	"triggering_message_id" uuid NOT NULL,
	"origin_section_id" text NOT NULL,
	"origin_segment" integer NOT NULL,
	"origin_node_order" integer NOT NULL
);--> statement-breakpoint
WITH ranked AS (
	SELECT
		proposal."id" AS proposal_id,
		gen_random_uuid() AS draft_id,
		gen_random_uuid() AS revision_id,
		coalesce(maximum."version", 0) + row_number() over (
			PARTITION BY proposal."user_book_id" ORDER BY proposal."created_at", proposal."id"
		)::integer AS draft_version,
		user_book."current_strategy_version_id" AS base_strategy_version_id,
		user_book."current_book_reader_profile_version_id" AS book_reader_profile_version_id,
		strategy."source_draft_version_id" AS source_draft_version_id,
		coalesce(proposal."triggering_message_id", answer."id") AS triggering_message_id,
		coalesce(session."question_context"->>'sectionId', state."section_id", 'unknown') AS origin_section_id,
		coalesce((session."question_context"->>'segment')::integer, state."segment", 1) AS origin_segment,
		coalesce((session."question_context"->>'nodeOrder')::integer, state."node_order", 1) AS origin_node_order
	FROM "strategy_change_proposals" AS proposal
	JOIN "user_books" AS user_book ON user_book."id" = proposal."user_book_id"
	JOIN "strategy_versions" AS strategy ON strategy."id" = user_book."current_strategy_version_id"
	JOIN "qa_sessions" AS session ON session."id" = proposal."qa_session_id"
	LEFT JOIN "reader_states" AS state ON state."user_book_id" = proposal."user_book_id"
	LEFT JOIN LATERAL (
		SELECT message."id" FROM "qa_messages" AS message
		WHERE message."qa_session_id" = proposal."qa_session_id" AND message."kind" = 'answer'
		ORDER BY message."sequence" DESC LIMIT 1
	) AS answer ON true
	LEFT JOIN LATERAL (
		SELECT max(draft."version")::integer AS version FROM "strategy_draft_versions" AS draft
		WHERE draft."user_book_id" = proposal."user_book_id"
	) AS maximum ON true
)
INSERT INTO "_phase6_proposal_backfill" SELECT * FROM ranked;--> statement-breakpoint
INSERT INTO "strategy_draft_versions" (
	"id", "user_book_id", "book_reader_profile_version_id", "source_qa_message_id", "version",
	"status", "reading_briefing", "user_facing_summary", "strategy", "confirmed_at",
	"superseded_at", "created_at"
)
SELECT
	backfill."draft_id", proposal."user_book_id", backfill."book_reader_profile_version_id",
	backfill."triggering_message_id", backfill."draft_version",
	CASE WHEN proposal."status" = 'confirmed' THEN 'confirmed'
		WHEN proposal."status" = 'pending' THEN 'draft' ELSE 'superseded' END,
	source_draft."reading_briefing", proposal."public_summary",
	proposal."proposed_strategy" || jsonb_build_object(
		'trialCandidates', coalesce(base_strategy."strategy"->'trialCandidates', '[]'::jsonb)
	),
	CASE WHEN proposal."status" = 'confirmed' THEN coalesce(proposal."confirmed_at", proposal."updated_at") ELSE NULL END,
	CASE WHEN proposal."status" IN ('rejected', 'superseded') THEN coalesce(proposal."rejected_at", proposal."superseded_at", proposal."updated_at") ELSE NULL END,
	proposal."created_at"
FROM "_phase6_proposal_backfill" AS backfill
JOIN "strategy_change_proposals" AS proposal ON proposal."id" = backfill."proposal_id"
JOIN "strategy_draft_versions" AS source_draft ON source_draft."id" = backfill."source_draft_version_id"
JOIN "strategy_versions" AS base_strategy ON base_strategy."id" = backfill."base_strategy_version_id";--> statement-breakpoint
INSERT INTO "strategy_change_proposal_revisions" (
	"id", "proposal_id", "revision", "triggering_message_id", "strategy_draft_version_id",
	"public_summary", "changed_fields", "reason", "evidence", "created_at"
)
SELECT backfill."revision_id", proposal."id", 1, backfill."triggering_message_id", backfill."draft_id",
	proposal."public_summary", '[]'::jsonb, proposal."public_summary", '历史建议迁移', proposal."created_at"
FROM "_phase6_proposal_backfill" AS backfill
JOIN "strategy_change_proposals" AS proposal ON proposal."id" = backfill."proposal_id";--> statement-breakpoint
UPDATE "strategy_change_proposals" AS proposal
SET "current_revision_id" = backfill."revision_id",
	"current_strategy_draft_version_id" = backfill."draft_id",
	"base_strategy_version_id" = backfill."base_strategy_version_id",
	"origin_section_id" = backfill."origin_section_id",
	"origin_segment" = backfill."origin_segment",
	"origin_node_order" = backfill."origin_node_order"
FROM "_phase6_proposal_backfill" AS backfill
WHERE backfill."proposal_id" = proposal."id";--> statement-breakpoint
DROP TABLE "_phase6_proposal_backfill";--> statement-breakpoint
ALTER TABLE "reader_read_nodes" ALTER COLUMN "strategy_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ALTER COLUMN "current_strategy_draft_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ALTER COLUMN "base_strategy_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ALTER COLUMN "origin_section_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ALTER COLUMN "origin_segment" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ALTER COLUMN "origin_node_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_change_proposal_actions" ADD CONSTRAINT "strategy_change_proposal_actions_proposal_id_strategy_change_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."strategy_change_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposal_actions" ADD CONSTRAINT "strategy_change_proposal_actions_revision_id_strategy_change_proposal_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."strategy_change_proposal_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposal_revisions" ADD CONSTRAINT "strategy_change_proposal_revisions_proposal_id_strategy_change_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."strategy_change_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposal_revisions" ADD CONSTRAINT "strategy_change_proposal_revisions_triggering_message_id_qa_messages_id_fk" FOREIGN KEY ("triggering_message_id") REFERENCES "public"."qa_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposal_revisions" ADD CONSTRAINT "strategy_change_proposal_revisions_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_change_proposal_actions_idempotency_unique" ON "strategy_change_proposal_actions" USING btree ("proposal_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_change_proposal_revisions_proposal_revision_unique" ON "strategy_change_proposal_revisions" USING btree ("proposal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_change_proposal_revisions_draft_unique" ON "strategy_change_proposal_revisions" USING btree ("strategy_draft_version_id");--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD CONSTRAINT "reader_profile_versions_source_qa_session_id_qa_sessions_id_fk" FOREIGN KEY ("source_qa_session_id") REFERENCES "public"."qa_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD CONSTRAINT "reader_profile_versions_source_qa_message_id_qa_messages_id_fk" FOREIGN KEY ("source_qa_message_id") REFERENCES "public"."qa_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_read_nodes" ADD CONSTRAINT "reader_read_nodes_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_current_revision_id_strategy_change_proposal_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."strategy_change_proposal_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_current_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("current_strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_base_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("base_strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_source_qa_message_id_qa_messages_id_fk" FOREIGN KEY ("source_qa_message_id") REFERENCES "public"."qa_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_change_proposals_resulting_strategy_unique" ON "strategy_change_proposals" USING btree ("resulting_strategy_version_id") WHERE "strategy_change_proposals"."resulting_strategy_version_id" is not null;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_revision_positive" CHECK ("strategy_change_proposals"."revision" > 0);--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_origin_valid" CHECK ("strategy_change_proposals"."origin_segment" > 0 and "strategy_change_proposals"."origin_node_order" > 0 and length(btrim("strategy_change_proposals"."origin_section_id")) > 0);--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_approval_valid" CHECK ("strategy_draft_versions"."status" <> 'approved_for_trial' or "strategy_draft_versions"."approved_for_trial_at" is not null);
