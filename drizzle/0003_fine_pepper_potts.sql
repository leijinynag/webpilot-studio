CREATE TYPE "public"."agent_evidence_kind" AS ENUM('build', 'runtime', 'console');--> statement-breakpoint
CREATE TABLE "agent_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" "agent_evidence_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_evidence_revision_check" CHECK ("agent_evidence"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_evidence" ADD CONSTRAINT "agent_evidence_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_evidence" ADD CONSTRAINT "agent_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evidence_run_call_kind_uidx" ON "agent_evidence" USING btree ("run_id","tool_call_id","kind");--> statement-breakpoint
CREATE INDEX "agent_evidence_project_revision_idx" ON "agent_evidence" USING btree ("project_id","revision","created_at");--> statement-breakpoint
CREATE INDEX "agent_evidence_owner_run_idx" ON "agent_evidence" USING btree ("owner_id","run_id","created_at");