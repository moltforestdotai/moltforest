CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "app"."agent_profile" (
	"chain_id" integer NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"uri" text NOT NULL,
	"uri_kind" text NOT NULL,
	"fetch_url" text,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"content_hash" text,
	"name" text,
	"description" text,
	"image" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_count" integer DEFAULT 0 NOT NULL,
	"x402_support" boolean,
	"active" boolean,
	"supported_trust" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_fetched_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"change_count" integer DEFAULT 0 NOT NULL,
	"last_changed_at" timestamp with time zone,
	CONSTRAINT "agent_profile_chain_id_agent_id_pk" PRIMARY KEY("chain_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_profile_snapshot" (
	"chain_id" integer NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"content_hash" text NOT NULL,
	"uri" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "agent_profile_snapshot_chain_id_agent_id_content_hash_pk" PRIMARY KEY("chain_id","agent_id","content_hash")
);
--> statement-breakpoint
CREATE INDEX "agent_profile_next_fetch_idx" ON "app"."agent_profile" USING btree ("next_fetch_at");