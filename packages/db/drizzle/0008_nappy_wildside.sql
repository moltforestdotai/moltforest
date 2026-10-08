CREATE TABLE "app"."newsletter_subscriber" (
	"email" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'footer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "newsletter_subscriber_created_idx" ON "app"."newsletter_subscriber" USING btree ("created_at");