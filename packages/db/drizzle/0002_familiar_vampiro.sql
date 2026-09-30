CREATE TABLE "app"."receipt" (
	"receipt_hash" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"registry" text NOT NULL,
	"task_id" text NOT NULL,
	"client_agent_id" numeric(78, 0) NOT NULL,
	"provider_agent_id" numeric(78, 0) NOT NULL,
	"request_hash" text NOT NULL,
	"result_hash" text NOT NULL,
	"payment_ref" text NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint NOT NULL,
	"proof_type" smallint NOT NULL,
	"proof_ref" text NOT NULL,
	"level" smallint NOT NULL,
	"provider_signature" text NOT NULL,
	"client_signature" text,
	"provider_signer" text NOT NULL,
	"client_signer" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anchor_status" text DEFAULT 'queued' NOT NULL,
	"anchor_level" smallint,
	"anchor_tx" text,
	"anchor_block" bigint,
	"anchored_at" timestamp with time zone,
	"anchor_attempts" integer DEFAULT 0 NOT NULL,
	"anchor_error" text,
	"next_anchor_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "receipt_provider_idx" ON "app"."receipt" USING btree ("chain_id","provider_agent_id","submitted_at");--> statement-breakpoint
CREATE INDEX "receipt_client_idx" ON "app"."receipt" USING btree ("chain_id","client_agent_id","submitted_at");--> statement-breakpoint
CREATE INDEX "receipt_anchor_queue_idx" ON "app"."receipt" USING btree ("next_anchor_at") WHERE anchor_status IN ('queued', 'sending');