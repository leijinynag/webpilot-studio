ALTER TABLE "image_jobs" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "image_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "image_jobs_lease_idx" ON "image_jobs" USING btree ("status","lease_expires_at");