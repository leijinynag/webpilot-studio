CREATE TABLE "daily_budget_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_date" date NOT NULL,
	"limit_usd" numeric(12, 6) NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"consumed_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_budget_buckets_limit_check" CHECK ("daily_budget_buckets"."limit_usd" >= 0),
	CONSTRAINT "daily_budget_buckets_reserved_check" CHECK ("daily_budget_buckets"."reserved_usd" >= 0),
	CONSTRAINT "daily_budget_buckets_consumed_check" CHECK ("daily_budget_buckets"."consumed_usd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_budget_buckets_date_uidx" ON "daily_budget_buckets" USING btree ("bucket_date");