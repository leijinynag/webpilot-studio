CREATE TYPE "public"."verification_run_source" AS ENUM('agent', 'replay');--> statement-breakpoint
CREATE TYPE "public"."verification_run_status" AS ENUM('pending', 'running', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verification_step_status" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" "verification_run_status" DEFAULT 'pending' NOT NULL,
	"source" "verification_run_source" NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"smoke_steps" jsonb NOT NULL,
	"accepted_network_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"build_evidence" jsonb,
	"runtime_evidence" jsonb,
	"console_evidence" jsonb,
	"browser_evidence" jsonb,
	"network_evidence" jsonb,
	"build_ok" boolean,
	"runtime_ok" boolean,
	"console_ok" boolean,
	"network_ok" boolean,
	"actions_ok" boolean,
	"assertions_ok" boolean,
	"revision_ok" boolean,
	"failed_step" integer,
	"summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_runs_revision_check" CHECK ("verification_runs"."revision" >= 0),
	CONSTRAINT "verification_runs_replay_count_check" CHECK ("verification_runs"."replay_count" >= 0),
	CONSTRAINT "verification_runs_failed_step_check" CHECK ("verification_runs"."failed_step" is null or "verification_runs"."failed_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verification_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"action" text NOT NULL,
	"target" jsonb,
	"status" "verification_step_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"message" text NOT NULL,
	"error" jsonb,
	CONSTRAINT "verification_steps_index_check" CHECK ("verification_steps"."step_index" >= 0),
	CONSTRAINT "verification_steps_duration_check" CHECK ("verification_steps"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_steps" ADD CONSTRAINT "verification_steps_verification_run_id_verification_runs_id_fk" FOREIGN KEY ("verification_run_id") REFERENCES "public"."verification_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_runs_run_call_uidx" ON "verification_runs" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "verification_runs_run_revision_idx" ON "verification_runs" USING btree ("run_id","revision","created_at");--> statement-breakpoint
CREATE INDEX "verification_runs_project_revision_idx" ON "verification_runs" USING btree ("project_id","revision","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_steps_run_index_uidx" ON "verification_steps" USING btree ("verification_run_id","step_index");--> statement-breakpoint
CREATE INDEX "verification_steps_run_status_idx" ON "verification_steps" USING btree ("verification_run_id","status","step_index");