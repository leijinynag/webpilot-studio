CREATE TYPE "public"."quota_lease_status" AS ENUM('active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."quota_resource" AS ENUM('agent_run', 'image_generation', 'attachment_upload');--> statement-breakpoint
CREATE TYPE "public"."quota_subject_type" AS ENUM('ip', 'owner', 'global');--> statement-breakpoint
CREATE TYPE "public"."usage_ledger_status" AS ENUM('reserved', 'settled', 'released');--> statement-breakpoint
CREATE TABLE "quota_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" "quota_resource" NOT NULL,
	"subject_type" "quota_subject_type" NOT NULL,
	"subject_key" text NOT NULL,
	"bucket_date" date NOT NULL,
	"quota_limit" integer NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_buckets_limit_check" CHECK ("quota_buckets"."quota_limit" >= 0),
	CONSTRAINT "quota_buckets_consumed_check" CHECK ("quota_buckets"."consumed" >= 0 and "quota_buckets"."consumed" <= "quota_buckets"."quota_limit")
);
--> statement-breakpoint
CREATE TABLE "quota_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" "quota_resource" NOT NULL,
	"owner_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"status" "quota_lease_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"correlation_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"resource" "quota_resource" NOT NULL,
	"agent_run_id" uuid,
	"image_run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "usage_ledger_status" DEFAULT 'reserved' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reserved_input_tokens" integer DEFAULT 0 NOT NULL,
	"reserved_output_tokens" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_reserved_tokens_check" CHECK ("usage_ledger"."reserved_input_tokens" >= 0 and "usage_ledger"."reserved_output_tokens" >= 0),
	CONSTRAINT "usage_ledger_tokens_check" CHECK ("usage_ledger"."input_tokens" >= 0 and "usage_ledger"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_image_run_id_image_runs_id_fk" FOREIGN KEY ("image_run_id") REFERENCES "public"."image_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_buckets_subject_uidx" ON "quota_buckets" USING btree ("resource","subject_type","subject_key","bucket_date");--> statement-breakpoint
CREATE INDEX "quota_buckets_date_idx" ON "quota_buckets" USING btree ("bucket_date","resource");--> statement-breakpoint
CREATE INDEX "quota_leases_owner_status_idx" ON "quota_leases" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "quota_leases_resource_status_idx" ON "quota_leases" USING btree ("resource","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_idempotency_uidx" ON "usage_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_owner_created_idx" ON "usage_ledger" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_resource_status_idx" ON "usage_ledger" USING btree ("resource","status","created_at");