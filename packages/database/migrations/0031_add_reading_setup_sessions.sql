CREATE TABLE "reading_setup_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"agent_state" jsonb NOT NULL,
	"active_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_setup_sessions_agent_state_object" CHECK (jsonb_typeof("reading_setup_sessions"."agent_state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "reading_setup_sessions" ADD CONSTRAINT "reading_setup_sessions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_setup_sessions_user_book_unique" ON "reading_setup_sessions" USING btree ("user_book_id");