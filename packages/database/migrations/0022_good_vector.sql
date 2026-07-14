CREATE TABLE "agent_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"prompt_chars" integer,
	"output_chars" integer,
	"turn_count" integer,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_call_logs_duration_nonnegative" CHECK ("agent_call_logs"."duration_ms" >= 0),
	CONSTRAINT "agent_call_logs_status_valid" CHECK ("agent_call_logs"."status" in ('ok', 'error')),
	CONSTRAINT "agent_call_logs_source_valid" CHECK ("agent_call_logs"."source" in ('api', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "http_request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "http_request_logs_duration_nonnegative" CHECK ("http_request_logs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "agent_call_logs_created_at_idx" ON "agent_call_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_call_logs_kind_created_at_idx" ON "agent_call_logs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "http_request_logs_created_at_idx" ON "http_request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "http_request_logs_route_created_at_idx" ON "http_request_logs" USING btree ("route","created_at");