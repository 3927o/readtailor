DROP INDEX IF EXISTS "reading_sessions_client_interval_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "reading_sessions_user_book_interval_unique" ON "reading_sessions" USING btree ("user_id","user_book_id","client_interval_id");
