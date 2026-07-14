-- reader_position_restore_fix §4.2: add the client-observed event time used to merge position
-- events last-observed-wins. Add nullable, backfill existing rows from updated_at (so an upgraded
-- book still resumes), then enforce NOT NULL to match the schema.
ALTER TABLE "reader_states" ADD COLUMN "client_observed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "reader_states" SET "client_observed_at" = "updated_at" WHERE "client_observed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "reader_states" ALTER COLUMN "client_observed_at" SET NOT NULL;
