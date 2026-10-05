CREATE TABLE "app"."feedback_file" (
	"chain_id" integer NOT NULL,
	"agent_id" numeric(78, 0) NOT NULL,
	"client" text NOT NULL,
	"feedback_index" numeric(78, 0) NOT NULL,
	"uri" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_fetch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"proof_tx" text,
	"proof_chain_id" text,
	"proof_from" text,
	"proof_to" text,
	"receipt_hash" text,
	"endpoint" text,
	"error" text,
	CONSTRAINT "feedback_file_chain_id_agent_id_client_feedback_index_pk" PRIMARY KEY("chain_id","agent_id","client","feedback_index")
);
--> statement-breakpoint
ALTER TABLE "app"."agent_review_summary" ADD COLUMN "verified_reviews" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."review_assessment" ADD COLUMN "link" jsonb;--> statement-breakpoint
ALTER TABLE "app"."review_assessment" ADD COLUMN "paid_unattached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_file_due_idx" ON "app"."feedback_file" USING btree ("next_fetch_at") WHERE status IN ('pending', 'unreachable');