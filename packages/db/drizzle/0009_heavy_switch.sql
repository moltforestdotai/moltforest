CREATE TABLE "app"."score_epoch" (
	"chain_id" integer NOT NULL,
	"epoch_id" bigint NOT NULL,
	"inputs_root" text NOT NULL,
	"scores_root" text NOT NULL,
	"algo_hash" text NOT NULL,
	"score_registry" text NOT NULL,
	"publish_tx" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_epoch_chain_id_epoch_id_pk" PRIMARY KEY("chain_id","epoch_id")
);
--> statement-breakpoint
CREATE TABLE "app"."score_epoch_agent" (
	"chain_id" integer NOT NULL,
	"epoch_id" bigint NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"score_bps" integer NOT NULL,
	"confidence_bps" integer NOT NULL,
	"paid_reviews" integer NOT NULL,
	"independent_clusters" integer NOT NULL,
	"total_paid_volume" numeric(78, 0) NOT NULL,
	CONSTRAINT "score_epoch_agent_chain_id_epoch_id_agent_id_pk" PRIMARY KEY("chain_id","epoch_id","agent_id")
);
--> statement-breakpoint
CREATE INDEX "score_epoch_agent_agent_idx" ON "app"."score_epoch_agent" USING btree ("chain_id","agent_id","epoch_id");