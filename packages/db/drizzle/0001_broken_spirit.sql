CREATE TABLE "app"."endpoint_status" (
	"url" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"payment_required" boolean DEFAULT false NOT NULL,
	"error" text,
	"first_checked_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"last_up_at" timestamp with time zone,
	"next_check_at" timestamp with time zone NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."endpoint_uptime_daily" (
	"url" text NOT NULL,
	"day" date NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"up" integer DEFAULT 0 NOT NULL,
	"latency_ms_sum" bigint DEFAULT 0 NOT NULL,
	"latency_ms_max" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "endpoint_uptime_daily_url_day_pk" PRIMARY KEY("url","day")
);
--> statement-breakpoint
CREATE INDEX "endpoint_status_next_check_idx" ON "app"."endpoint_status" USING btree ("next_check_at");