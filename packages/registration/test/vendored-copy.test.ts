import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

describe("indexer copy of the registration parser", () => {
  it("is identical to the source (run `pnpm sync:registration` after editing)", () => {
    expect(read("../../../apps/indexer/src/lib/agentUri.ts")).toBe(read("../src/index.ts"));
  });
});
