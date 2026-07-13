CREATE TABLE "book_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shared_book_id" uuid NOT NULL,
	"version" text NOT NULL,
	"contract_version" text NOT NULL,
	"manifest_version" text NOT NULL,
	"object_prefix" text NOT NULL,
	"file_hashes" jsonb NOT NULL,
	"validation_summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalization_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shared_book_id" uuid NOT NULL,
	"source_upload_id" uuid NOT NULL,
	"status" text NOT NULL,
	"step" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shared_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"epub_sha256" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb NOT NULL,
	"language" text NOT NULL,
	"cover_path" text,
	"identifiers" jsonb NOT NULL,
	"publisher" text,
	"published_date" text,
	"source_filename" text NOT NULL,
	"current_package_id" uuid,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shared_book_id" uuid,
	"source_object_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"epub_sha256" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_packages" ADD CONSTRAINT "book_packages_shared_book_id_shared_books_id_fk" FOREIGN KEY ("shared_book_id") REFERENCES "public"."shared_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_profiles" ADD CONSTRAINT "book_profiles_package_id_book_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."book_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_runs" ADD CONSTRAINT "normalization_runs_shared_book_id_shared_books_id_fk" FOREIGN KEY ("shared_book_id") REFERENCES "public"."shared_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_runs" ADD CONSTRAINT "normalization_runs_source_upload_id_source_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."source_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_uploads" ADD CONSTRAINT "source_uploads_shared_book_id_shared_books_id_fk" FOREIGN KEY ("shared_book_id") REFERENCES "public"."shared_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_packages_book_version_unique" ON "book_packages" USING btree ("shared_book_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "book_packages_object_prefix_unique" ON "book_packages" USING btree ("object_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "book_profiles_package_unique" ON "book_profiles" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_books_epub_sha256_unique" ON "shared_books" USING btree ("epub_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "source_uploads_object_key_unique" ON "source_uploads" USING btree ("source_object_key");