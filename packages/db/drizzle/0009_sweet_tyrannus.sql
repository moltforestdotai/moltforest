CREATE TABLE "app"."nansen_relation" (
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
CREATE TABLE "app"."nansen_wallet" (
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
CREATE INDEX "nansen_relation_related_idx" ON "app"."nansen_relation" USING btree ("chain_id","related");--> statement-breakpoint
CREATE INDEX "nansen_wallet_fetched_idx" ON "app"."nansen_wallet" USING btree ("chain_id","fetched_at");