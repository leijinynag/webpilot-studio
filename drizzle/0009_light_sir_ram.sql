CREATE TYPE "public"."showcase_artifact_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."showcase_case_status" AS ENUM('draft', 'published', 'revoked');--> statement-breakpoint
CREATE TABLE "showcase_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"status" "showcase_artifact_status" DEFAULT 'active' NOT NULL,
	"blob_prefix" text NOT NULL,
	"entry_path" text DEFAULT 'index.html' NOT NULL,
	"manifest" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "showcase_artifacts_source_revision_check" CHECK ("showcase_artifacts"."source_revision" >= 0),
	CONSTRAINT "showcase_artifacts_file_count_check" CHECK ("showcase_artifacts"."file_count" > 0),
	CONSTRAINT "showcase_artifacts_total_bytes_check" CHECK ("showcase_artifacts"."total_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "showcase_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"cover_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "showcase_case_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "showcase_cases_title_length_check" CHECK (char_length("showcase_cases"."title") between 1 and 160),
	CONSTRAINT "showcase_cases_slug_format_check" CHECK ("showcase_cases"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "showcase_artifacts" ADD CONSTRAINT "showcase_artifacts_case_id_showcase_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."showcase_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_cases" ADD CONSTRAINT "showcase_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_artifacts_case_revision_uidx" ON "showcase_artifacts" USING btree ("case_id","source_revision","created_at");--> statement-breakpoint
CREATE INDEX "showcase_artifacts_case_status_idx" ON "showcase_artifacts" USING btree ("case_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_cases_slug_uidx" ON "showcase_cases" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "showcase_cases_public_sort_idx" ON "showcase_cases" USING btree ("status","sort_order","updated_at");