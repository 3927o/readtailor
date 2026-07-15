ALTER TABLE "shared_books" ADD COLUMN "is_preset" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "shared_books_preset_idx" ON "shared_books" USING btree ("id") WHERE "shared_books"."is_preset";--> statement-breakpoint
-- Seed the initial preset set: 局外人 / 菊与刀 / 呐喊 (the three ready shared books). Idempotent —
-- affects only these rows, no-op if a row is absent or already flagged. Flip is_preset on any shared
-- book to change the preset set later; no code change needed (apps/api/src/preset-books.ts).
UPDATE "shared_books" SET "is_preset" = true WHERE "id" IN (
	'1845f204-4807-41ab-9e92-ec08c3659e9f',
	'c372af36-9fb3-4da8-9fce-35f3b224be0b',
	'b12c5db1-3e20-43ec-8f5a-0e9e79f33a68'
);