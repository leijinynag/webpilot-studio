CREATE TYPE "public"."project_change_operation" AS ENUM('create', 'update', 'delete', 'rename');--> statement-breakpoint
CREATE TYPE "public"."project_checkpoint_kind" AS ENUM('agent_start', 'agent_success', 'restore');--> statement-breakpoint
CREATE TABLE "project_change_set_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_set_id" uuid NOT NULL,
	"operation" "project_change_operation" NOT NULL,
	"path_before" text,
	"path_after" text,
	"before_hash" text,
	"after_hash" text,
	"sort_order" integer NOT NULL,
	CONSTRAINT "project_change_set_files_sort_order_check" CHECK ("project_change_set_files"."sort_order" >= 0),
	CONSTRAINT "project_change_set_files_shape_check" CHECK (
        ("project_change_set_files"."operation" = 'create' and "project_change_set_files"."path_before" is null and "project_change_set_files"."path_after" is not null and "project_change_set_files"."before_hash" is null and "project_change_set_files"."after_hash" is not null)
        or ("project_change_set_files"."operation" = 'update' and "project_change_set_files"."path_before" is not null and "project_change_set_files"."path_after" is not null and "project_change_set_files"."before_hash" is not null and "project_change_set_files"."after_hash" is not null)
        or ("project_change_set_files"."operation" = 'delete' and "project_change_set_files"."path_before" is not null and "project_change_set_files"."path_after" is null and "project_change_set_files"."before_hash" is not null and "project_change_set_files"."after_hash" is null)
        or ("project_change_set_files"."operation" = 'rename' and "project_change_set_files"."path_before" is not null and "project_change_set_files"."path_after" is not null and "project_change_set_files"."before_hash" is not null and "project_change_set_files"."after_hash" is not null)
      )
);
--> statement-breakpoint
CREATE TABLE "project_change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"base_checkpoint_id" uuid NOT NULL,
	"result_checkpoint_id" uuid NOT NULL,
	"base_revision" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_change_sets_revision_order_check" CHECK ("project_change_sets"."base_revision" <= "project_change_sets"."result_revision")
);
--> statement-breakpoint
CREATE TABLE "project_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "project_checkpoint_kind" NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_change_set_files" ADD CONSTRAINT "project_change_set_files_change_set_id_project_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."project_change_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_set_files" ADD CONSTRAINT "project_change_set_files_before_hash_project_file_blobs_hash_fk" FOREIGN KEY ("before_hash") REFERENCES "public"."project_file_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_set_files" ADD CONSTRAINT "project_change_set_files_after_hash_project_file_blobs_hash_fk" FOREIGN KEY ("after_hash") REFERENCES "public"."project_file_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_sets" ADD CONSTRAINT "project_change_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_sets" ADD CONSTRAINT "project_change_sets_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_sets" ADD CONSTRAINT "project_change_sets_base_checkpoint_id_project_checkpoints_id_fk" FOREIGN KEY ("base_checkpoint_id") REFERENCES "public"."project_checkpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_sets" ADD CONSTRAINT "project_change_sets_result_checkpoint_id_project_checkpoints_id_fk" FOREIGN KEY ("result_checkpoint_id") REFERENCES "public"."project_checkpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkpoints" ADD CONSTRAINT "project_checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkpoints" ADD CONSTRAINT "project_checkpoints_revision_id_project_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."project_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkpoints" ADD CONSTRAINT "project_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_change_set_files_order_uidx" ON "project_change_set_files" USING btree ("change_set_id","sort_order");--> statement-breakpoint
CREATE INDEX "project_change_set_files_change_idx" ON "project_change_set_files" USING btree ("change_set_id","operation");--> statement-breakpoint
CREATE UNIQUE INDEX "project_change_sets_run_uidx" ON "project_change_sets" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "project_change_sets_project_created_idx" ON "project_change_sets" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_checkpoints_run_kind_uidx" ON "project_checkpoints" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "project_checkpoints_project_created_idx" ON "project_checkpoints" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_checkpoints_revision_idx" ON "project_checkpoints" USING btree ("revision_id");