CREATE TYPE "public"."project_revision_kind" AS ENUM('initial', 'write', 'delete', 'rename', 'checkpoint', 'restore');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('creating', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "public"."project_storage_kind" AS ENUM('database', 'browser_git');--> statement-breakpoint
CREATE TABLE "project_file_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_file_blobs_hash_check" CHECK (char_length("project_file_blobs"."hash") = 64),
	CONSTRAINT "project_file_blobs_byte_length_check" CHECK ("project_file_blobs"."byte_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_revision_files" (
	"revision_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_hash" text NOT NULL,
	CONSTRAINT "project_revision_files_pk" PRIMARY KEY("revision_id","path")
);
--> statement-breakpoint
CREATE TABLE "project_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" "project_revision_kind" NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_revisions_revision_check" CHECK ("project_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"storage_kind" "project_storage_kind" DEFAULT 'database' NOT NULL,
	"status" "project_status" DEFAULT 'creating' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "projects_name_length_check" CHECK (char_length("projects"."name") between 1 and 120),
	CONSTRAINT "projects_revision_check" CHECK ("projects"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_blob_hash_project_file_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "public"."project_file_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revision_files" ADD CONSTRAINT "project_revision_files_revision_id_project_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."project_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revision_files" ADD CONSTRAINT "project_revision_files_blob_hash_project_file_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "public"."project_file_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_project_path_uidx" ON "project_files" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "project_files_project_active_idx" ON "project_files" USING btree ("project_id","deleted_at","path");--> statement-breakpoint
CREATE INDEX "project_revision_files_blob_idx" ON "project_revision_files" USING btree ("blob_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_revisions_project_revision_uidx" ON "project_revisions" USING btree ("project_id","revision");--> statement-breakpoint
CREATE INDEX "project_revisions_project_created_idx" ON "project_revisions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_owner_updated_idx" ON "projects" USING btree ("owner_id","deleted_at","updated_at");