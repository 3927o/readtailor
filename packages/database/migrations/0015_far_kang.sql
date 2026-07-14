CREATE TABLE "reader_read_nodes" (
	"user_book_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"segment" integer NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_read_nodes_user_book_id_section_id_segment_pk" PRIMARY KEY("user_book_id","section_id","segment"),
	CONSTRAINT "reader_read_nodes_segment_positive" CHECK ("reader_read_nodes"."segment" > 0),
	CONSTRAINT "reader_read_nodes_section_nonempty" CHECK (length(btrim("reader_read_nodes"."section_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reader_states" (
	"user_book_id" uuid PRIMARY KEY NOT NULL,
	"section_id" text NOT NULL,
	"segment" integer NOT NULL,
	"block_index" integer NOT NULL,
	"offset" integer NOT NULL,
	"node_order" integer NOT NULL,
	"manifest_version" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_states_segment_positive" CHECK ("reader_states"."segment" > 0),
	CONSTRAINT "reader_states_block_index_positive" CHECK ("reader_states"."block_index" > 0),
	CONSTRAINT "reader_states_offset_nonneg" CHECK ("reader_states"."offset" >= 0),
	CONSTRAINT "reader_states_node_order_positive" CHECK ("reader_states"."node_order" > 0),
	CONSTRAINT "reader_states_section_nonempty" CHECK (length(btrim("reader_states"."section_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user_reading_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reader_read_nodes" ADD CONSTRAINT "reader_read_nodes_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_states" ADD CONSTRAINT "reader_states_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reading_settings" ADD CONSTRAINT "user_reading_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;