CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_valid" CHECK ("auth_identities"."provider" in ('google', 'development')),
	CONSTRAINT "auth_identities_subject_nonempty" CHECK (length(btrim("auth_identities"."provider_subject")) > 0)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_nonempty" CHECK (length("auth_sessions"."token_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "reader_profile_onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"mapping_version" text NOT NULL,
	"knowledge_option_ids" jsonb NOT NULL,
	"knowledge_free_text" text,
	"explanation_option_ids" jsonb NOT NULL,
	"explanation_free_text" text,
	"background_depth_option_id" text NOT NULL,
	"extraction_status" text DEFAULT 'not_requested' NOT NULL,
	"model_config_id" text,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_profile_onboardings_extraction_status_valid" CHECK ("reader_profile_onboardings"."extraction_status" in ('not_requested', 'completed', 'failed'))
);
--> statement-breakpoint
INSERT INTO "auth_identities" (
	"user_id",
	"provider",
	"provider_subject",
	"email_verified"
)
SELECT
	"id",
	"auth_provider",
	"auth_subject",
	CASE WHEN "auth_provider" = 'development' THEN true ELSE false END
FROM "users";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_auth_provider_valid";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_auth_subject_nonempty";--> statement-breakpoint
DROP INDEX "users_auth_identity_unique";--> statement-breakpoint
ALTER TABLE "source_uploads" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_profile_onboardings" ADD CONSTRAINT "reader_profile_onboardings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_unique" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_active_expiry_idx" ON "auth_sessions" USING btree ("expires_at") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reader_profile_onboardings_user_unique" ON "reader_profile_onboardings" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "source_uploads" ADD CONSTRAINT "source_uploads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auth_provider";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auth_subject";
