-- The Nansen tables (decision D47) were first created by 0009_sweet_tyrannus, which a merge then
-- dropped from the journal. IF NOT EXISTS makes this a no-op where that migration already ran
-- (production) and creates the tables everywhere else.
CREATE TABLE IF NOT EXISTS "app"."nansen_relation" (
	"chain_id" integer NOT NULL,
	"wallet" text NOT NULL,
	"related" text NOT NULL,
	"relation" text NOT NULL,
	"label" text,
	"tx_hash" text,
	"block_time" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "nansen_relation_chain_id_wallet_related_relation_pk" PRIMARY KEY("chain_id","wallet","related","relation")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."nansen_wallet" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"relation_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"next_fetch_at" timestamp with time zone NOT NULL,
	CONSTRAINT "nansen_wallet_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nansen_relation_related_idx" ON "app"."nansen_relation" USING btree ("chain_id","related");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nansen_wallet_fetched_idx" ON "app"."nansen_wallet" USING btree ("chain_id","fetched_at");
