ALTER TYPE "public"."quota_resource" ADD VALUE 'context_checkpoint' BEFORE 'image_generation';--> statement-breakpoint
ALTER TYPE "public"."quota_resource" ADD VALUE 'code_completion' BEFORE 'image_generation';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "context_checkpoint_summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "context_checkpoint_transcript_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "context_checkpoint_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "context_checkpoint_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_checkpoint_seq_check" CHECK ("conversations"."context_checkpoint_transcript_seq" >= 0);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_checkpoint_version_check" CHECK ("conversations"."context_checkpoint_version" >= 0);