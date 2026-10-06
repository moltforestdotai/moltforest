ALTER TABLE "app"."wallet_funding" ADD COLUMN "cluster_root" text;--> statement-breakpoint
CREATE INDEX "wallet_funding_cluster_idx" ON "app"."wallet_funding" USING btree ("chain_id","cluster_root");