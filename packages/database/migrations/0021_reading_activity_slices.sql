CREATE TABLE "reading_activity_slices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reading_session_id" uuid NOT NULL,
  "user_book_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "client_session_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "timezone" text NOT NULL,
  "day" date NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "start_order" integer NOT NULL,
  "start_section_id" text NOT NULL,
  "start_segment" integer NOT NULL,
  "start_block_index" integer NOT NULL,
  "start_offset" integer NOT NULL,
  "end_order" integer NOT NULL,
  "end_section_id" text NOT NULL,
  "end_segment" integer NOT NULL,
  "end_block_index" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "activity_area" text NOT NULL,
  "classification" text NOT NULL,
  "effective_seconds" integer DEFAULT 0 NOT NULL,
  "forward_seconds" integer DEFAULT 0 NOT NULL,
  "forward_chars" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reading_activity_slices_reading_session_id_reading_sessions_id_fk" FOREIGN KEY ("reading_session_id") REFERENCES "public"."reading_sessions"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "reading_activity_slices_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "reading_activity_slices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "reading_activity_slices_sequence_positive" CHECK ("reading_activity_slices"."sequence" > 0),
  CONSTRAINT "reading_activity_slices_time_order_valid" CHECK ("reading_activity_slices"."ended_at" >= "reading_activity_slices"."started_at"),
  CONSTRAINT "reading_activity_slices_effective_nonneg" CHECK ("reading_activity_slices"."effective_seconds" >= 0),
  CONSTRAINT "reading_activity_slices_forward_seconds_nonneg" CHECK ("reading_activity_slices"."forward_seconds" >= 0),
  CONSTRAINT "reading_activity_slices_forward_chars_nonneg" CHECK ("reading_activity_slices"."forward_chars" >= 0),
  CONSTRAINT "reading_activity_slices_forward_seconds_lte_effective" CHECK ("reading_activity_slices"."forward_seconds" <= "reading_activity_slices"."effective_seconds"),
  CONSTRAINT "reading_activity_slices_forward_only_original" CHECK ("reading_activity_slices"."classification" = 'original_forward' or ("reading_activity_slices"."forward_seconds" = 0 and "reading_activity_slices"."forward_chars" = 0)),
  CONSTRAINT "reading_activity_slices_activity_area_valid" CHECK ("reading_activity_slices"."activity_area" in ('original', 'assistance', 'reader_chrome')),
  CONSTRAINT "reading_activity_slices_classification_valid" CHECK ("reading_activity_slices"."classification" in ('original_forward', 'original_reread', 'original_jump', 'assistance', 'stationary')),
  CONSTRAINT "reading_activity_slices_order_positive" CHECK ("reading_activity_slices"."start_order" > 0 and "reading_activity_slices"."end_order" > 0),
  CONSTRAINT "reading_activity_slices_segment_positive" CHECK ("reading_activity_slices"."start_segment" > 0 and "reading_activity_slices"."end_segment" > 0),
  CONSTRAINT "reading_activity_slices_block_positive" CHECK ("reading_activity_slices"."start_block_index" > 0 and "reading_activity_slices"."end_block_index" > 0),
  CONSTRAINT "reading_activity_slices_offset_nonneg" CHECK ("reading_activity_slices"."start_offset" >= 0 and "reading_activity_slices"."end_offset" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reading_activity_slices_session_sequence_unique" ON "reading_activity_slices" USING btree ("user_id","client_session_id","sequence");
--> statement-breakpoint
CREATE INDEX "reading_activity_slices_user_day_idx" ON "reading_activity_slices" USING btree ("user_id","day");
--> statement-breakpoint
CREATE INDEX "reading_activity_slices_user_book_day_idx" ON "reading_activity_slices" USING btree ("user_book_id","day");
--> statement-breakpoint
CREATE TABLE "reading_daily_book_stats" (
  "user_id" uuid NOT NULL,
  "user_book_id" uuid NOT NULL,
  "day" date NOT NULL,
  "effective_seconds" integer DEFAULT 0 NOT NULL,
  "forward_seconds" integer DEFAULT 0 NOT NULL,
  "forward_chars" integer DEFAULT 0 NOT NULL,
  "last_read_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reading_daily_book_stats_user_id_user_book_id_day_pk" PRIMARY KEY("user_id","user_book_id","day"),
  CONSTRAINT "reading_daily_book_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "reading_daily_book_stats_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "reading_daily_book_stats_effective_nonneg" CHECK ("reading_daily_book_stats"."effective_seconds" >= 0),
  CONSTRAINT "reading_daily_book_stats_forward_seconds_nonneg" CHECK ("reading_daily_book_stats"."forward_seconds" >= 0),
  CONSTRAINT "reading_daily_book_stats_forward_chars_nonneg" CHECK ("reading_daily_book_stats"."forward_chars" >= 0),
  CONSTRAINT "reading_daily_book_stats_forward_seconds_lte_effective" CHECK ("reading_daily_book_stats"."forward_seconds" <= "reading_daily_book_stats"."effective_seconds")
);
--> statement-breakpoint
CREATE INDEX "reading_daily_book_stats_user_book_idx" ON "reading_daily_book_stats" USING btree ("user_book_id");
--> statement-breakpoint
CREATE TABLE "book_reading_stats" (
  "user_book_id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "effective_seconds" integer DEFAULT 0 NOT NULL,
  "forward_seconds" integer DEFAULT 0 NOT NULL,
  "forward_chars" integer DEFAULT 0 NOT NULL,
  "last_read_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "book_reading_stats_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "book_reading_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "book_reading_stats_effective_nonneg" CHECK ("book_reading_stats"."effective_seconds" >= 0),
  CONSTRAINT "book_reading_stats_forward_seconds_nonneg" CHECK ("book_reading_stats"."forward_seconds" >= 0),
  CONSTRAINT "book_reading_stats_forward_chars_nonneg" CHECK ("book_reading_stats"."forward_chars" >= 0),
  CONSTRAINT "book_reading_stats_forward_seconds_lte_effective" CHECK ("book_reading_stats"."forward_seconds" <= "book_reading_stats"."effective_seconds")
);
--> statement-breakpoint
CREATE INDEX "book_reading_stats_user_idx" ON "book_reading_stats" USING btree ("user_id");
