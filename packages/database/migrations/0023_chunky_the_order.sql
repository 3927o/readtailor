CREATE TABLE "qa_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qa_session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_messages_sequence_positive" CHECK ("qa_messages"."sequence" > 0),
	CONSTRAINT "qa_messages_role_valid" CHECK ("qa_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "qa_messages_kind_valid" CHECK ("qa_messages"."kind" in ('question', 'answer')),
	CONSTRAINT "qa_messages_content_nonempty" CHECK (length(btrim("qa_messages"."content")) > 0),
	CONSTRAINT "qa_messages_idempotency_nonempty" CHECK ("qa_messages"."idempotency_key" is null or length(btrim("qa_messages"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "qa_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"conversation_version" integer DEFAULT 0 NOT NULL,
	"question_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_sessions_status_valid" CHECK ("qa_sessions"."status" in ('active', 'closed')),
	CONSTRAINT "qa_sessions_conversation_version_nonnegative" CHECK ("qa_sessions"."conversation_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "strategy_change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"qa_session_id" uuid NOT NULL,
	"triggering_message_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"public_summary" text NOT NULL,
	"proposed_strategy" jsonb NOT NULL,
	"feedback" text,
	"resulting_strategy_version_id" uuid,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_change_proposals_status_valid" CHECK ("strategy_change_proposals"."status" in ('pending', 'confirmed', 'rejected', 'superseded')),
	CONSTRAINT "strategy_change_proposals_summary_nonempty" CHECK (length(btrim("strategy_change_proposals"."public_summary")) > 0),
	CONSTRAINT "strategy_change_proposals_confirmed_valid" CHECK ("strategy_change_proposals"."status" <> 'confirmed' or ("strategy_change_proposals"."confirmed_at" is not null and "strategy_change_proposals"."resulting_strategy_version_id" is not null)),
	CONSTRAINT "strategy_change_proposals_rejected_valid" CHECK ("strategy_change_proposals"."status" <> 'rejected' or "strategy_change_proposals"."rejected_at" is not null),
	CONSTRAINT "strategy_change_proposals_superseded_valid" CHECK ("strategy_change_proposals"."status" <> 'superseded' or "strategy_change_proposals"."superseded_at" is not null),
	CONSTRAINT "strategy_change_proposals_feedback_nonempty" CHECK ("strategy_change_proposals"."feedback" is null or length(btrim("strategy_change_proposals"."feedback")) > 0)
);
--> statement-breakpoint
ALTER TABLE "qa_messages" ADD CONSTRAINT "qa_messages_qa_session_id_qa_sessions_id_fk" FOREIGN KEY ("qa_session_id") REFERENCES "public"."qa_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_sessions" ADD CONSTRAINT "qa_sessions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_qa_session_id_qa_sessions_id_fk" FOREIGN KEY ("qa_session_id") REFERENCES "public"."qa_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_triggering_message_id_qa_messages_id_fk" FOREIGN KEY ("triggering_message_id") REFERENCES "public"."qa_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_change_proposals" ADD CONSTRAINT "strategy_change_proposals_resulting_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("resulting_strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_messages_session_sequence_unique" ON "qa_messages" USING btree ("qa_session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_messages_question_idempotency_unique" ON "qa_messages" USING btree ("qa_session_id","idempotency_key") WHERE "qa_messages"."kind" = 'question';--> statement-breakpoint
CREATE INDEX "qa_sessions_user_book_idx" ON "qa_sessions" USING btree ("user_book_id");--> statement-breakpoint
CREATE INDEX "strategy_change_proposals_user_book_idx" ON "strategy_change_proposals" USING btree ("user_book_id");--> statement-breakpoint
CREATE INDEX "strategy_change_proposals_qa_session_idx" ON "strategy_change_proposals" USING btree ("qa_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_change_proposals_one_pending_per_book" ON "strategy_change_proposals" USING btree ("user_book_id") WHERE "strategy_change_proposals"."status" = 'pending';