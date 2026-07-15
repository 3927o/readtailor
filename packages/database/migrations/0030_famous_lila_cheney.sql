CREATE TABLE "reading_setup_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"base_strategy_draft_version_id" uuid NOT NULL,
	"base_trial_revision_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"lease_claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"result_strategy_draft_version_id" uuid,
	"result_trial_revision_id" uuid,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "reading_setup_operations_kind_valid" CHECK ("reading_setup_operations"."kind" in ('strategy_revision', 'trial_selection')),
	CONSTRAINT "reading_setup_operations_source_valid" CHECK ("reading_setup_operations"."source" in ('strategy_feedback', 'trial_feedback', 'strategy_approve')),
	CONSTRAINT "reading_setup_operations_kind_source_valid" CHECK (("reading_setup_operations"."kind" = 'strategy_revision' and "reading_setup_operations"."source" in ('strategy_feedback', 'trial_feedback')) or ("reading_setup_operations"."kind" = 'trial_selection' and "reading_setup_operations"."source" = 'strategy_approve')),
	CONSTRAINT "reading_setup_operations_base_trial_valid" CHECK (("reading_setup_operations"."source" = 'trial_feedback') = ("reading_setup_operations"."base_trial_revision_id" is not null)),
	CONSTRAINT "reading_setup_operations_idempotency_nonempty" CHECK (length(btrim("reading_setup_operations"."idempotency_key")) > 0),
	CONSTRAINT "reading_setup_operations_request_hash_valid" CHECK ("reading_setup_operations"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reading_setup_operations_payload_object" CHECK (jsonb_typeof("reading_setup_operations"."payload") = 'object'),
	CONSTRAINT "reading_setup_operations_status_valid" CHECK ("reading_setup_operations"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "reading_setup_operations_attempt_count_nonnegative" CHECK ("reading_setup_operations"."attempt_count" >= 0),
	CONSTRAINT "reading_setup_operations_lease_complete" CHECK (("reading_setup_operations"."lease_id" is null and "reading_setup_operations"."lease_claimed_at" is null and "reading_setup_operations"."lease_expires_at" is null) or ("reading_setup_operations"."lease_id" is not null and "reading_setup_operations"."lease_claimed_at" is not null and "reading_setup_operations"."lease_expires_at" is not null)),
	CONSTRAINT "reading_setup_operations_lease_status_valid" CHECK (("reading_setup_operations"."status" = 'running') = ("reading_setup_operations"."lease_id" is not null)),
	CONSTRAINT "reading_setup_operations_lease_window_valid" CHECK ("reading_setup_operations"."lease_expires_at" is null or "reading_setup_operations"."lease_expires_at" > "reading_setup_operations"."lease_claimed_at"),
	CONSTRAINT "reading_setup_operations_result_valid" CHECK (("reading_setup_operations"."status" = 'completed' and (("reading_setup_operations"."kind" = 'strategy_revision' and "reading_setup_operations"."result_strategy_draft_version_id" is not null and "reading_setup_operations"."result_trial_revision_id" is null) or ("reading_setup_operations"."kind" = 'trial_selection' and "reading_setup_operations"."result_strategy_draft_version_id" is null and "reading_setup_operations"."result_trial_revision_id" is not null))) or ("reading_setup_operations"."status" <> 'completed' and "reading_setup_operations"."result_strategy_draft_version_id" is null and "reading_setup_operations"."result_trial_revision_id" is null)),
	CONSTRAINT "reading_setup_operations_error_valid" CHECK (("reading_setup_operations"."status" = 'failed' and length(btrim(coalesce("reading_setup_operations"."error_summary", ''))) > 0) or ("reading_setup_operations"."status" <> 'failed' and "reading_setup_operations"."error_summary" is null)),
	CONSTRAINT "reading_setup_operations_completion_valid" CHECK (("reading_setup_operations"."status" in ('completed', 'failed')) = ("reading_setup_operations"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "reading_setup_operations" ADD CONSTRAINT "reading_setup_operations_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_setup_operations" ADD CONSTRAINT "reading_setup_operations_base_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("base_strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_setup_operations" ADD CONSTRAINT "reading_setup_operations_base_trial_revision_id_trial_revisions_id_fk" FOREIGN KEY ("base_trial_revision_id") REFERENCES "public"."trial_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_setup_operations" ADD CONSTRAINT "reading_setup_operations_result_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("result_strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_setup_operations" ADD CONSTRAINT "reading_setup_operations_result_trial_revision_id_trial_revisions_id_fk" FOREIGN KEY ("result_trial_revision_id") REFERENCES "public"."trial_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_setup_operations_book_idempotency_unique" ON "reading_setup_operations" USING btree ("user_book_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_setup_operations_one_active_per_book" ON "reading_setup_operations" USING btree ("user_book_id") WHERE "reading_setup_operations"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "reading_setup_operations_book_updated_idx" ON "reading_setup_operations" USING btree ("user_book_id","updated_at");