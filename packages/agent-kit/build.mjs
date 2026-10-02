// Bundles the kit into one file that Claude Desktop can start with plain `node`.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/agent-kit.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Some dependencies are CommonJS and call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "info",
});
