CREATE TABLE "normalization_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalization_attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "normalization_artifacts_revision_positive" CHECK ("normalization_artifacts"."revision" > 0),
	CONSTRAINT "normalization_artifacts_byte_size_nonnegative" CHECK ("normalization_artifacts"."byte_size" >= 0),
	CONSTRAINT "normalization_artifacts_sha256_valid" CHECK ("normalization_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "normalization_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalization_run_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" text NOT NULL,
	"sandbox_provider" text NOT NULL,
	"sandbox_id" text,
	"agent_session_id" text NOT NULL,
	"agent_model" text NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"script_sha256" text,
	"output_inventory_sha256" text,
	"validator_version" text,
	"validation_report_sha256" text,
	"host_output_inventory_sha256" text,
	"host_validator_version" text,
	"host_validation_report_sha256" text,
	"blocking_error_count" integer,
	"warning_count" integer,
	"error_class" text,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "normalization_attempts_number_positive" CHECK ("normalization_attempts"."attempt_no" > 0),
	CONSTRAINT "normalization_attempts_status_valid" CHECK ("normalization_attempts"."status" in ('running', 'succeeded', 'failed', 'abandoned')),
	CONSTRAINT "normalization_attempts_completion_valid" CHECK ((("normalization_attempts"."status" = 'running' and "normalization_attempts"."completed_at" is null) or ("normalization_attempts"."status" in ('succeeded', 'failed', 'abandoned') and "normalization_attempts"."completed_at" is not null))),
	CONSTRAINT "normalization_attempts_finish_binding_complete" CHECK (("normalization_attempts"."script_sha256" is null and "normalization_attempts"."output_inventory_sha256" is null and "normalization_attempts"."validator_version" is null and "normalization_attempts"."validation_report_sha256" is null) or ("normalization_attempts"."script_sha256" is not null and "normalization_attempts"."output_inventory_sha256" is not null and "normalization_attempts"."validator_version" is not null and "normalization_attempts"."validation_report_sha256" is not null))
);
--> statement-breakpoint
CREATE TABLE "normalization_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalization_attempt_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"invocation_no" integer NOT NULL,
	"validator_version" text NOT NULL,
	"script_sha256" text NOT NULL,
	"output_inventory_sha256" text NOT NULL,
	"report_sha256" text NOT NULL,
	"report_object_key" text NOT NULL,
	"exit_code" integer NOT NULL,
	"outcome" text NOT NULL,
	"blocking_error_count" integer NOT NULL,
	"warning_count" integer NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "normalization_validations_phase_valid" CHECK ("normalization_validations"."phase" in ('agent', 'worker_final', 'package')),
	CONSTRAINT "normalization_validations_outcome_valid" CHECK ("normalization_validations"."outcome" in ('passed', 'passed_with_warnings', 'failed')),
	CONSTRAINT "normalization_validations_invocation_positive" CHECK ("normalization_validations"."invocation_no" > 0),
	CONSTRAINT "normalization_validations_errors_nonnegative" CHECK ("normalization_validations"."blocking_error_count" >= 0),
	CONSTRAINT "normalization_validations_warnings_nonnegative" CHECK ("normalization_validations"."warning_count" >= 0),
	CONSTRAINT "normalization_validations_script_sha_valid" CHECK ("normalization_validations"."script_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "normalization_validations_output_sha_valid" CHECK ("normalization_validations"."output_inventory_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "normalization_validations_report_sha_valid" CHECK ("normalization_validations"."report_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "shared_books" DROP CONSTRAINT "shared_books_status_valid";--> statement-breakpoint
ALTER TABLE "book_packages" ADD COLUMN "producer_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "book_packages" ADD COLUMN "package_manifest_object_key" text;--> statement-breakpoint
ALTER TABLE "book_packages" ADD COLUMN "package_manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "normalization_artifacts" ADD CONSTRAINT "normalization_artifacts_normalization_attempt_id_normalization_attempts_id_fk" FOREIGN KEY ("normalization_attempt_id") REFERENCES "public"."normalization_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_attempts" ADD CONSTRAINT "normalization_attempts_normalization_run_id_normalization_runs_id_fk" FOREIGN KEY ("normalization_run_id") REFERENCES "public"."normalization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_validations" ADD CONSTRAINT "normalization_validations_normalization_attempt_id_normalization_attempts_id_fk" FOREIGN KEY ("normalization_attempt_id") REFERENCES "public"."normalization_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_artifacts_attempt_kind_revision_unique" ON "normalization_artifacts" USING btree ("normalization_attempt_id","kind","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_artifacts_object_key_unique" ON "normalization_artifacts" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_attempts_run_number_unique" ON "normalization_attempts" USING btree ("normalization_run_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_attempts_one_running_per_run" ON "normalization_attempts" USING btree ("normalization_run_id") WHERE "normalization_attempts"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_validations_attempt_phase_invocation_unique" ON "normalization_validations" USING btree ("normalization_attempt_id","phase","invocation_no");--> statement-breakpoint
ALTER TABLE "book_packages" ADD CONSTRAINT "book_packages_producer_attempt_id_normalization_attempts_id_fk" FOREIGN KEY ("producer_attempt_id") REFERENCES "public"."normalization_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_books" ADD CONSTRAINT "shared_books_status_valid" CHECK ("shared_books"."status" in ('queued', 'normalizing', 'validating', 'indexing', 'analyzing', 'ready', 'failed'));