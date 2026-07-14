DROP INDEX "node_generations_cache_key_unique";--> statement-breakpoint
CREATE INDEX "node_generations_cache_key_idx" ON "node_generations" USING btree ("cache_key");