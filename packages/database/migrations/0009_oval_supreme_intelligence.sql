CREATE TABLE "book_reader_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"interview_session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_reader_profile_versions_version_positive" CHECK ("book_reader_profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "interview_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_session_id" uuid NOT NULL,
	"question_message_id" uuid NOT NULL,
	"selected_option_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_text" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_answers_has_content" CHECK (jsonb_array_length("interview_answers"."selected_option_ids") > 0 or length(btrim(coalesce("interview_answers"."free_text", ''))) > 0),
	CONSTRAINT "interview_answers_idempotency_nonempty" CHECK (length(btrim("interview_answers"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "interview_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_messages_sequence_positive" CHECK ("interview_messages"."sequence" > 0),
	CONSTRAINT "interview_messages_role_valid" CHECK ("interview_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "interview_messages_kind_valid" CHECK ("interview_messages"."kind" in ('question', 'answer', 'feedback', 'summary')),
	CONSTRAINT "interview_messages_content_nonempty" CHECK (length(btrim("interview_messages"."content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"conversation_version" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_sessions_status_valid" CHECK ("interview_sessions"."status" in ('active', 'completed', 'cancelled')),
	CONSTRAINT "interview_sessions_question_count_valid" CHECK ("interview_sessions"."question_count" between 0 and 7),
	CONSTRAINT "interview_sessions_conversation_version_nonnegative" CHECK ("interview_sessions"."conversation_version" >= 0),
	CONSTRAINT "interview_sessions_completion_valid" CHECK (("interview_sessions"."status" = 'completed' and "interview_sessions"."completed_at" is not null) or ("interview_sessions"."status" <> 'completed' and "interview_sessions"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "node_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"generation_scope" text NOT NULL,
	"trial_segment_id" uuid,
	"strategy_draft_version_id" uuid,
	"strategy_version_id" uuid,
	"section_id" text NOT NULL,
	"segment" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result" jsonb,
	"model_config_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"cache_key" text NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_generations_scope_valid" CHECK ("node_generations"."generation_scope" in ('trial', 'formal')),
	CONSTRAINT "node_generations_scope_references_valid" CHECK (("node_generations"."generation_scope" = 'trial' and "node_generations"."trial_segment_id" is not null and "node_generations"."strategy_draft_version_id" is not null and "node_generations"."strategy_version_id" is null) or ("node_generations"."generation_scope" = 'formal' and "node_generations"."trial_segment_id" is null and "node_generations"."strategy_draft_version_id" is null and "node_generations"."strategy_version_id" is not null)),
	CONSTRAINT "node_generations_status_valid" CHECK ("node_generations"."status" in ('queued', 'generating', 'ready', 'failed', 'retrying', 'superseded')),
	CONSTRAINT "node_generations_segment_positive" CHECK ("node_generations"."segment" > 0),
	CONSTRAINT "node_generations_attempts_valid" CHECK ("node_generations"."max_attempts" > 0 and "node_generations"."attempt_count" between 0 and "node_generations"."max_attempts"),
	CONSTRAINT "node_generations_result_valid" CHECK (("node_generations"."status" = 'ready') = ("node_generations"."result" is not null)),
	CONSTRAINT "node_generations_completion_valid" CHECK (("node_generations"."status" in ('ready', 'failed', 'superseded') and "node_generations"."completed_at" is not null) or ("node_generations"."status" in ('queued', 'generating', 'retrying') and "node_generations"."completed_at" is null)),
	CONSTRAINT "node_generations_section_nonempty" CHECK (length(btrim("node_generations"."section_id")) > 0),
	CONSTRAINT "node_generations_config_nonempty" CHECK (length(btrim("node_generations"."model_config_id")) > 0 and length(btrim("node_generations"."prompt_version")) > 0 and length(btrim("node_generations"."cache_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reader_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reader_profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"change_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_profile_versions_version_positive" CHECK ("reader_profile_versions"."version" > 0),
	CONSTRAINT "reader_profile_versions_change_source_valid" CHECK ("reader_profile_versions"."change_source" in ('onboarding', 'interview', 'question_answer', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "reader_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_draft_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"book_reader_profile_version_id" uuid NOT NULL,
	"source_message_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reading_briefing" text NOT NULL,
	"user_facing_summary" text NOT NULL,
	"strategy" jsonb NOT NULL,
	"approved_for_trial_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_draft_versions_version_positive" CHECK ("strategy_draft_versions"."version" > 0),
	CONSTRAINT "strategy_draft_versions_status_valid" CHECK ("strategy_draft_versions"."status" in ('draft', 'approved_for_trial', 'confirmed', 'superseded')),
	CONSTRAINT "strategy_draft_versions_approval_valid" CHECK ("strategy_draft_versions"."status" not in ('approved_for_trial', 'confirmed') or "strategy_draft_versions"."approved_for_trial_at" is not null),
	CONSTRAINT "strategy_draft_versions_confirmation_valid" CHECK ("strategy_draft_versions"."status" <> 'confirmed' or "strategy_draft_versions"."confirmed_at" is not null),
	CONSTRAINT "strategy_draft_versions_superseded_valid" CHECK ("strategy_draft_versions"."status" <> 'superseded' or "strategy_draft_versions"."superseded_at" is not null),
	CONSTRAINT "strategy_draft_versions_content_nonempty" CHECK (length(btrim("strategy_draft_versions"."reading_briefing")) > 0 and length(btrim("strategy_draft_versions"."user_facing_summary")) > 0)
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"source_draft_version_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"user_facing_summary" text NOT NULL,
	"strategy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_versions_version_positive" CHECK ("strategy_versions"."version" > 0),
	CONSTRAINT "strategy_versions_summary_nonempty" CHECK (length(btrim("strategy_versions"."user_facing_summary")) > 0)
);
--> statement-breakpoint
CREATE TABLE "trial_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"strategy_draft_version_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"failure_summary" text,
	"published_at" timestamp with time zone,
	"adopted_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_revisions_revision_positive" CHECK ("trial_revisions"."revision" > 0),
	CONSTRAINT "trial_revisions_status_valid" CHECK ("trial_revisions"."status" in ('draft', 'generating', 'ready', 'published', 'adopted', 'failed', 'superseded')),
	CONSTRAINT "trial_revisions_published_valid" CHECK ("trial_revisions"."status" not in ('published', 'adopted') or "trial_revisions"."published_at" is not null),
	CONSTRAINT "trial_revisions_adopted_valid" CHECK ("trial_revisions"."status" <> 'adopted' or "trial_revisions"."adopted_at" is not null),
	CONSTRAINT "trial_revisions_failed_valid" CHECK ("trial_revisions"."status" <> 'failed' or ("trial_revisions"."failed_at" is not null and length(btrim(coalesce("trial_revisions"."failure_summary", ''))) > 0)),
	CONSTRAINT "trial_revisions_superseded_valid" CHECK ("trial_revisions"."status" <> 'superseded' or "trial_revisions"."superseded_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "trial_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"section_id" text NOT NULL,
	"segment" integer NOT NULL,
	"start_block_index" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_block_index" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"selection_reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_segments_ordinal_valid" CHECK ("trial_segments"."ordinal" between 1 and 3),
	CONSTRAINT "trial_segments_segment_positive" CHECK ("trial_segments"."segment" > 0),
	CONSTRAINT "trial_segments_block_indexes_positive" CHECK ("trial_segments"."start_block_index" > 0 and "trial_segments"."end_block_index" > 0),
	CONSTRAINT "trial_segments_offsets_nonnegative" CHECK ("trial_segments"."start_offset" >= 0 and "trial_segments"."end_offset" >= 0),
	CONSTRAINT "trial_segments_range_order_valid" CHECK ("trial_segments"."start_block_index" < "trial_segments"."end_block_index" or ("trial_segments"."start_block_index" = "trial_segments"."end_block_index" and "trial_segments"."start_offset" < "trial_segments"."end_offset")),
	CONSTRAINT "trial_segments_status_valid" CHECK ("trial_segments"."status" in ('pending', 'generating', 'ready', 'failed')),
	CONSTRAINT "trial_segments_section_nonempty" CHECK (length(btrim("trial_segments"."section_id")) > 0),
	CONSTRAINT "trial_segments_selection_reason_nonempty" CHECK (length(btrim("trial_segments"."selection_reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shared_book_id" uuid NOT NULL,
	"workflow_status" text DEFAULT 'on_shelf' NOT NULL,
	"adjustment_count" integer DEFAULT 0 NOT NULL,
	"current_interview_session_id" uuid,
	"current_book_reader_profile_version_id" uuid,
	"current_strategy_draft_version_id" uuid,
	"current_strategy_version_id" uuid,
	"current_trial_revision_id" uuid,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_books_workflow_status_valid" CHECK ("user_books"."workflow_status" in ('on_shelf', 'interviewing', 'strategy_review', 'trial_generating', 'trial_generation_failed', 'trial_review', 'active_reading')),
	CONSTRAINT "user_books_adjustment_count_valid" CHECK ("user_books"."adjustment_count" between 0 and 5),
	CONSTRAINT "user_books_delete_window_complete" CHECK (("user_books"."deleted_at" is null and "user_books"."purge_after" is null) or ("user_books"."deleted_at" is not null and "user_books"."purge_after" is not null and "user_books"."purge_after" > "user_books"."deleted_at")),
	CONSTRAINT "user_books_interview_pointer_present" CHECK ("user_books"."workflow_status" <> 'interviewing' or "user_books"."current_interview_session_id" is not null),
	CONSTRAINT "user_books_strategy_pointer_present" CHECK ("user_books"."workflow_status" <> 'strategy_review' or "user_books"."current_strategy_draft_version_id" is not null),
	CONSTRAINT "user_books_trial_pointers_present" CHECK ("user_books"."workflow_status" not in ('trial_generating', 'trial_generation_failed', 'trial_review') or ("user_books"."current_strategy_draft_version_id" is not null and "user_books"."current_trial_revision_id" is not null)),
	CONSTRAINT "user_books_formal_strategy_pointer_present" CHECK ("user_books"."workflow_status" <> 'active_reading' or "user_books"."current_strategy_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider" text NOT NULL,
	"auth_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"reader_profile_completed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_provider_valid" CHECK ("users"."auth_provider" in ('google', 'development')),
	CONSTRAINT "users_auth_subject_nonempty" CHECK (length(btrim("users"."auth_subject")) > 0),
	CONSTRAINT "users_display_name_nonempty" CHECK (length(btrim("users"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "book_reader_profile_versions" ADD CONSTRAINT "book_reader_profile_versions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_reader_profile_versions" ADD CONSTRAINT "book_reader_profile_versions_interview_session_id_interview_sessions_id_fk" FOREIGN KEY ("interview_session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_interview_session_id_interview_sessions_id_fk" FOREIGN KEY ("interview_session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_question_message_id_interview_messages_id_fk" FOREIGN KEY ("question_message_id") REFERENCES "public"."interview_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_interview_session_id_interview_sessions_id_fk" FOREIGN KEY ("interview_session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_generations" ADD CONSTRAINT "node_generations_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_generations" ADD CONSTRAINT "node_generations_trial_segment_id_trial_segments_id_fk" FOREIGN KEY ("trial_segment_id") REFERENCES "public"."trial_segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_generations" ADD CONSTRAINT "node_generations_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_generations" ADD CONSTRAINT "node_generations_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_profile_versions" ADD CONSTRAINT "reader_profile_versions_reader_profile_id_reader_profiles_id_fk" FOREIGN KEY ("reader_profile_id") REFERENCES "public"."reader_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_profiles" ADD CONSTRAINT "reader_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_profiles" ADD CONSTRAINT "reader_profiles_current_version_id_reader_profile_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."reader_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_book_reader_profile_version_id_book_reader_profile_versions_id_fk" FOREIGN KEY ("book_reader_profile_version_id") REFERENCES "public"."book_reader_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_draft_versions" ADD CONSTRAINT "strategy_draft_versions_source_message_id_interview_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."interview_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_source_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("source_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_revisions" ADD CONSTRAINT "trial_revisions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_revisions" ADD CONSTRAINT "trial_revisions_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_segments" ADD CONSTRAINT "trial_segments_trial_revision_id_trial_revisions_id_fk" FOREIGN KEY ("trial_revision_id") REFERENCES "public"."trial_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_shared_book_id_shared_books_id_fk" FOREIGN KEY ("shared_book_id") REFERENCES "public"."shared_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_current_interview_session_id_interview_sessions_id_fk" FOREIGN KEY ("current_interview_session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_current_book_reader_profile_version_id_book_reader_profile_versions_id_fk" FOREIGN KEY ("current_book_reader_profile_version_id") REFERENCES "public"."book_reader_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_current_strategy_draft_version_id_strategy_draft_versions_id_fk" FOREIGN KEY ("current_strategy_draft_version_id") REFERENCES "public"."strategy_draft_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_current_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("current_strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_books" ADD CONSTRAINT "user_books_current_trial_revision_id_trial_revisions_id_fk" FOREIGN KEY ("current_trial_revision_id") REFERENCES "public"."trial_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_reader_profile_versions_book_version_unique" ON "book_reader_profile_versions" USING btree ("user_book_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_answers_session_question_unique" ON "interview_answers" USING btree ("interview_session_id","question_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_answers_session_idempotency_unique" ON "interview_answers" USING btree ("interview_session_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_messages_session_sequence_unique" ON "interview_messages" USING btree ("interview_session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_sessions_user_book_unique" ON "interview_sessions" USING btree ("user_book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_generations_cache_key_unique" ON "node_generations" USING btree ("cache_key");--> statement-breakpoint
CREATE UNIQUE INDEX "node_generations_trial_segment_unique" ON "node_generations" USING btree ("trial_segment_id") WHERE "node_generations"."generation_scope" = 'trial';--> statement-breakpoint
CREATE UNIQUE INDEX "node_generations_formal_node_strategy_unique" ON "node_generations" USING btree ("user_book_id","strategy_version_id","section_id","segment") WHERE "node_generations"."generation_scope" = 'formal';--> statement-breakpoint
CREATE UNIQUE INDEX "reader_profile_versions_profile_version_unique" ON "reader_profile_versions" USING btree ("reader_profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "reader_profiles_user_unique" ON "reader_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_draft_versions_book_version_unique" ON "strategy_draft_versions" USING btree ("user_book_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_draft_versions_one_approved_per_book" ON "strategy_draft_versions" USING btree ("user_book_id") WHERE "strategy_draft_versions"."status" = 'approved_for_trial';--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_book_version_unique" ON "strategy_versions" USING btree ("user_book_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_source_draft_unique" ON "strategy_versions" USING btree ("source_draft_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_revisions_book_revision_unique" ON "trial_revisions" USING btree ("user_book_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_revisions_one_active_per_book" ON "trial_revisions" USING btree ("user_book_id") WHERE "trial_revisions"."status" in ('draft', 'generating', 'ready', 'published', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "trial_segments_revision_ordinal_unique" ON "trial_segments" USING btree ("trial_revision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "user_books_user_shared_book_unique" ON "user_books" USING btree ("user_id","shared_book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_identity_unique" ON "users" USING btree ("auth_provider","auth_subject");