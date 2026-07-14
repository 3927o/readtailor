CREATE TABLE "auth_password_credentials" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_password_credentials_hash_nonempty" CHECK (length(btrim("auth_password_credentials"."password_hash")) > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_identities" DROP CONSTRAINT "auth_identities_provider_valid";--> statement-breakpoint
ALTER TABLE "auth_password_credentials" ADD CONSTRAINT "auth_password_credentials_identity_id_auth_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_provider_valid" CHECK ("auth_identities"."provider" in ('google', 'password', 'development'));