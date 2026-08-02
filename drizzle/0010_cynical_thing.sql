CREATE TYPE "public"."attachment_status" AS ENUM('ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."image_job_status" AS ENUM('queued', 'running', 'retryable', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."image_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_asset_kind" AS ENUM('uploaded_image', 'generated_image');--> statement-breakpoint
CREATE TYPE "public"."project_asset_source" AS ENUM('attachment', 'image_generation');--> statement-breakpoint
CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"blob_url" text NOT NULL,
	"width" integer,
	"height" integer,
	"status" "attachment_status" DEFAULT 'ready' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chat_attachments_byte_length_check" CHECK ("chat_attachments"."byte_length" > 0),
	CONSTRAINT "chat_attachments_sha256_check" CHECK (char_length("chat_attachments"."sha256") = 64),
	CONSTRAINT "chat_attachments_dimensions_check" CHECK (
        ("chat_attachments"."width" is null and "chat_attachments"."height" is null)
        or ("chat_attachments"."width" is not null and "chat_attachments"."width" > 0 and "chat_attachments"."height" is not null and "chat_attachments"."height" > 0)
      )
);
--> statement-breakpoint
CREATE TABLE "image_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_run_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "image_job_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_job_id" text,
	"next_attempt_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_jobs_attempt_check" CHECK ("image_jobs"."attempt" >= 0),
	CONSTRAINT "image_jobs_max_attempts_check" CHECK ("image_jobs"."max_attempts" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "image_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid,
	"parent_agent_run_id" uuid,
	"prompt" text NOT NULL,
	"requested_count" integer NOT NULL,
	"status" "image_run_status" DEFAULT 'queued' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"profile" text NOT NULL,
	"profile_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_runs_requested_count_check" CHECK ("image_runs"."requested_count" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "project_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"attachment_id" uuid,
	"image_run_id" uuid,
	"kind" "project_asset_kind" NOT NULL,
	"source" "project_asset_source" NOT NULL,
	"original_filename" text,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"blob_url" text NOT NULL,
	"width" integer,
	"height" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_assets_byte_length_check" CHECK ("project_assets"."byte_length" > 0),
	CONSTRAINT "project_assets_sha256_check" CHECK (char_length("project_assets"."sha256") = 64),
	CONSTRAINT "project_assets_dimensions_check" CHECK (
        ("project_assets"."width" is null and "project_assets"."height" is null)
        or ("project_assets"."width" is not null and "project_assets"."width" > 0 and "project_assets"."height" is not null and "project_assets"."height" > 0)
      )
);
--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_jobs" ADD CONSTRAINT "image_jobs_image_run_id_image_runs_id_fk" FOREIGN KEY ("image_run_id") REFERENCES "public"."image_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_jobs" ADD CONSTRAINT "image_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_runs" ADD CONSTRAINT "image_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_runs" ADD CONSTRAINT "image_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_runs" ADD CONSTRAINT "image_runs_parent_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_attachment_id_chat_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_image_run_id_image_runs_id_fk" FOREIGN KEY ("image_run_id") REFERENCES "public"."image_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachments_owner_project_idx" ON "chat_attachments" USING btree ("owner_id","project_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "chat_attachments_conversation_idx" ON "chat_attachments" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "image_jobs_idempotency_uidx" ON "image_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "image_jobs_image_run_uidx" ON "image_jobs" USING btree ("image_run_id");--> statement-breakpoint
CREATE INDEX "image_jobs_status_next_attempt_idx" ON "image_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "image_jobs_owner_project_idx" ON "image_jobs" USING btree ("owner_id","project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "image_runs_idempotency_uidx" ON "image_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "image_runs_owner_project_status_idx" ON "image_runs" USING btree ("owner_id","project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "image_runs_parent_agent_run_idx" ON "image_runs" USING btree ("parent_agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_assets_project_hash_active_uidx" ON "project_assets" USING btree ("project_id","sha256") WHERE "project_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "project_assets_owner_project_idx" ON "project_assets" USING btree ("owner_id","project_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "project_assets_image_run_idx" ON "project_assets" USING btree ("image_run_id");