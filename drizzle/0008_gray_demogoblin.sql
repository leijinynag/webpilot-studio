CREATE TYPE "public"."browser_git_migration_status" AS ENUM('prepared', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "browser_git_migration_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"source_revision" integer NOT NULL,
	"candidate_repository_id" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"expected_head" text,
	"status" "browser_git_migration_status" DEFAULT 'prepared' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "browser_git_migrations_source_revision_check" CHECK ("browser_git_migration_sessions"."source_revision" >= 0),
	CONSTRAINT "browser_git_migrations_token_hash_check" CHECK (char_length("browser_git_migration_sessions"."token_hash") = 64),
	CONSTRAINT "browser_git_migrations_manifest_hash_check" CHECK (char_length("browser_git_migration_sessions"."manifest_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "browser_git_migration_sessions" ADD CONSTRAINT "browser_git_migration_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_git_migrations_candidate_uidx" ON "browser_git_migration_sessions" USING btree ("candidate_repository_id");--> statement-breakpoint
CREATE INDEX "browser_git_migrations_owner_project_idx" ON "browser_git_migration_sessions" USING btree ("owner_id","project_id","status","created_at");