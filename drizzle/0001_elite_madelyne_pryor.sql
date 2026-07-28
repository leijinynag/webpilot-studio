CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'awaiting_client_tool', 'awaiting_async_job', 'succeeded', 'failed', 'cancelled', 'budget_exhausted', 'conflicted');--> statement-breakpoint
CREATE TYPE "public"."tool_execution_domain" AS ENUM('server', 'client', 'async_worker');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_status" AS ENUM('created', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."transcript_message_kind" AS ENUM('user_message', 'assistant_message', 'tool_call', 'tool_result', 'system_event');--> statement-breakpoint
CREATE TYPE "public"."transcript_message_role" AS ENUM('user', 'assistant', 'tool', 'system');--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "agent_run_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"start_revision" integer NOT NULL,
	"current_revision" integer NOT NULL,
	"locale" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_profile" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"toolset_profile" text NOT NULL,
	"toolset_digest" text NOT NULL,
	"model_profile" text NOT NULL,
	"repository_capability" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"cancellation_requested_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_start_revision_check" CHECK ("agent_runs"."start_revision" >= 0),
	CONSTRAINT "agent_runs_current_revision_check" CHECK ("agent_runs"."current_revision" >= "agent_runs"."start_revision")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conversations_title_length_check" CHECK (char_length("conversations"."title") between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"execution_domain" "tool_execution_domain" NOT NULL,
	"status" "tool_invocation_status" DEFAULT 'created' NOT NULL,
	"arguments_json" jsonb NOT NULL,
	"result_json" jsonb,
	"idempotency_key" text NOT NULL,
	"revision_before" integer,
	"revision_after" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcript_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "transcript_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"role" "transcript_message_role" NOT NULL,
	"kind" "transcript_message_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_messages" ADD CONSTRAINT "transcript_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_messages" ADD CONSTRAINT "transcript_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_sequence_uidx" ON "agent_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_run_events_run_created_idx" ON "agent_run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_correlation_uidx" ON "agent_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "agent_runs_owner_status_idx" ON "agent_runs" USING btree ("owner_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_runs_project_status_idx" ON "agent_runs" USING btree ("project_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_owner_project_idx" ON "conversations" USING btree ("owner_id","project_id","deleted_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_invocations_run_call_uidx" ON "tool_invocations" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_invocations_idempotency_uidx" ON "tool_invocations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_status_idx" ON "tool_invocations" USING btree ("run_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_messages_conversation_seq_uidx" ON "transcript_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "transcript_messages_run_seq_idx" ON "transcript_messages" USING btree ("run_id","seq");