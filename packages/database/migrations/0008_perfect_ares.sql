ALTER TABLE "normalization_attempts" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "normalization_attempts" ADD COLUMN "deadline_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "normalization_runs" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;