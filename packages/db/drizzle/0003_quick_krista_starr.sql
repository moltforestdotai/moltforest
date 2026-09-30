CREATE TABLE "app"."payment_address" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"caught_up" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_address_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "app"."payment_cursor" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."x402_payment" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"asset" text NOT NULL,
	"payer" text NOT NULL,
	"payee" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"facilitator" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x402_payment_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "payment_address_pending_idx" ON "app"."payment_address" USING btree ("chain_id") WHERE NOT caught_up;--> statement-breakpoint
CREATE INDEX "x402_payment_payer_idx" ON "app"."x402_payment" USING btree ("chain_id","payer","block_number");--> statement-breakpoint
CREATE INDEX "x402_payment_payee_idx" ON "app"."x402_payment" USING btree ("chain_id","payee","block_number");