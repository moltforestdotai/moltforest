CREATE TABLE "app"."chain_scan_cursor" (
	"name" text NOT NULL,
	"chain_id" integer NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_scan_cursor_name_chain_id_pk" PRIMARY KEY("name","chain_id")
);
--> statement-breakpoint
ALTER TABLE "app"."receipt" ADD COLUMN "source" text DEFAULT 'api' NOT NULL;