CREATE TABLE "app"."score_epoch_pending" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"epoch_id" bigint NOT NULL,
	"inputs_root" text NOT NULL,
	"scores_root" text NOT NULL,
	"algo_hash" text NOT NULL,
	"signature_0" text NOT NULL,
	"signature_1" text NOT NULL,
	"signer_0" text NOT NULL,
	"signer_1" text NOT NULL,
	"score_registry" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL
);
