import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Abi } from "viem";
import { formatAbiItem } from "viem/utils";
import { receiptRegistryAbi } from "../src/receiptRegistry.js";

const compiled = JSON.parse(
  readFileSync(new URL("../../../apps/indexer/abis/ReceiptRegistry.json", import.meta.url), "utf8"),
) as Abi;

type Item = Extract<Abi[number], { type: "function" | "event" | "error" }>;
const isItem = (item: Abi[number]): item is Item => ["function", "event", "error"].includes(item.type);

// formatAbiItem omits `indexed` and outputs, so those are compared as well.
const signature = (item: Item) => {
  const extra =
    item.type === "event"
      ? item.inputs.map((i) => (i.indexed ? 1 : 0)).join("")
      : item.type === "function"
        ? `${item.stateMutability} -> ${item.outputs.map((o) => o.type).join(",")}`
        : "";
  return `${formatAbiItem(item)} ${extra}`;
};

describe("receiptRegistryAbi", () => {
  it("matches the compiled contract ABI item by item", () => {
    const compiledSignatures = new Set(compiled.filter(isItem).map(signature));
    for (const item of receiptRegistryAbi.filter(isItem)) {
      expect(compiledSignatures, signature(item)).toContain(signature(item));
    }
  });
});
