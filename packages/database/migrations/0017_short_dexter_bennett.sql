CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_book_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"segment" integer NOT NULL,
	"start_block_index" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_block_index" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"manifest_version" text,
	"note" text,
	"quote_snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlights_segment_positive" CHECK ("highlights"."segment" > 0),
	CONSTRAINT "highlights_block_indexes_positive" CHECK ("highlights"."start_block_index" > 0 and "highlights"."end_block_index" > 0),
	CONSTRAINT "highlights_offsets_nonneg" CHECK ("highlights"."start_offset" >= 0 and "highlights"."end_offset" >= 0),
	CONSTRAINT "highlights_range_order_valid" CHECK ("highlights"."start_block_index" < "highlights"."end_block_index" or ("highlights"."start_block_index" = "highlights"."end_block_index" and "highlights"."start_offset" < "highlights"."end_offset")),
	CONSTRAINT "highlights_section_nonempty" CHECK (length(btrim("highlights"."section_id")) > 0),
	CONSTRAINT "highlights_note_nonempty" CHECK ("highlights"."note" is null or length(btrim("highlights"."note")) > 0)
);
--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "highlights_user_book_idx" ON "highlights" USING btree ("user_book_id");