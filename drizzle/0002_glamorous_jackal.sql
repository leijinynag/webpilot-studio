ALTER TABLE "agent_runs" ADD COLUMN "execution_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "execution_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_project_active_uidx" ON "agent_runs" USING btree ("project_id") WHERE "agent_runs"."status" in ('queued', 'running', 'awaiting_client_tool', 'awaiting_async_job');--> statement-breakpoint
CREATE INDEX "agent_runs_lease_idx" ON "agent_runs" USING btree ("status","execution_lease_expires_at");