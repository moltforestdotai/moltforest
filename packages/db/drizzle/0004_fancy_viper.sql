CREATE TABLE "app"."agent_review_summary" (
	"chain_id" integer NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"counted_reviews" integer NOT NULL,
	"counted_reviewers" integer NOT NULL,
	"excluded" jsonb NOT NULL,
	"pending_reviewers" integer NOT NULL,
	"assessment_hash" text NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_summary_chain_id_agent_id_pk" PRIMARY KEY("chain_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "app"."review_assessment" (
	"chain_id" integer NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"client" text NOT NULL,
	"feedback_index" numeric(78, 0) NOT NULL,
	"counted" boolean NOT NULL,
	"reason" text,
	"evidence" jsonb,
	CONSTRAINT "review_assessment_chain_id_agent_id_client_feedback_index_pk" PRIMARY KEY("chain_id","agent_id","client","feedback_index")
);
--> statement-breakpoint
CREATE TABLE "app"."wallet_funding" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"funder" text,
	"funding_tx" text,
	"funding_block" bigint,
	"funding_value" numeric(78, 0),
	"sweep_tx" text,
	"sent_tx_count" integer,
	"checked_block" bigint,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "wallet_funding_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE INDEX "wallet_funding_pending_idx" ON "app"."wallet_funding" USING btree ("chain_id") WHERE status = 'pending';