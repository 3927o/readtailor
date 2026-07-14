CREATE TABLE "daily_reading_totals" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"effective_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_reading_totals_user_id_day_pk" PRIMARY KEY("user_id","day"),
	CONSTRAINT "daily_reading_totals_effective_nonneg" CHECK ("daily_reading_totals"."effective_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reading_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_interval_id" text NOT NULL,
	"day" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"effective_seconds" integer DEFAULT 0 NOT NULL,
	"forward_seconds" integer DEFAULT 0 NOT NULL,
	"forward_chars" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_sessions_effective_nonneg" CHECK ("reading_sessions"."effective_seconds" >= 0),
	CONSTRAINT "reading_sessions_forward_seconds_nonneg" CHECK ("reading_sessions"."forward_seconds" >= 0),
	CONSTRAINT "reading_sessions_forward_chars_nonneg" CHECK ("reading_sessions"."forward_chars" >= 0)
);
--> statement-breakpoint
ALTER TABLE "daily_reading_totals" ADD CONSTRAINT "daily_reading_totals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_sessions_client_interval_unique" ON "reading_sessions" USING btree ("client_interval_id");--> statement-breakpoint
CREATE INDEX "reading_sessions_user_book_idx" ON "reading_sessions" USING btree ("user_book_id");--> statement-breakpoint
CREATE INDEX "reading_sessions_user_day_idx" ON "reading_sessions" USING btree ("user_id","day");