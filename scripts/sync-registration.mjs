// Copies the shared registration parser into the indexer, which runs in Docker
// outside the pnpm workspace and cannot import workspace packages.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../packages/registration/src/index.ts", import.meta.url));
const to = fileURLToPath(new URL("../apps/indexer/src/lib/agentUri.ts", import.meta.url));
copyFileSync(from, to);
console.log("synced packages/registration/src/index.ts -> apps/indexer/src/lib/agentUri.ts");
