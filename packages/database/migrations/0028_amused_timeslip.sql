ALTER TABLE "agent_call_logs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "agent_call_logs" ADD COLUMN "conversation_version" integer;--> statement-breakpoint
ALTER TABLE "agent_call_logs" ADD COLUMN "trace_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_call_logs_request_id_idx" ON "agent_call_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "agent_call_logs_session_id_created_at_idx" ON "agent_call_logs" USING btree ("session_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_call_logs" ADD CONSTRAINT "agent_call_logs_conversation_version_nonnegative" CHECK ("agent_call_logs"."conversation_version" is null or "agent_call_logs"."conversation_version" >= 0);