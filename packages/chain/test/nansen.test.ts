import { describe, expect, it } from "vitest";
import { isNansenServiceLabel, nansenLinkKind } from "../src/nansen.js";

describe("nansenLinkKind", () => {
  it("uses first funders as funding links and signers or multisigs as control links", () => {
    expect(nansenLinkKind("First Funder")).toBe("funding");
    expect(nansenLinkKind(" signer ")).toBe("control");
    expect(nansenLinkKind("Previous Signer")).toBe("control");
    expect(nansenLinkKind("Multisig Signer of")).toBe("control");
    expect(nansenLinkKind("Previous Multisig Signer of")).toBe("control");
  });

  it("ignores deployment relations, which link unrelated accounts through factories and bundlers", () => {
    for (const relation of ["Deployed via", "Deployed by", "Deployed Contract", "Created Contract", "Created by", "Something New"]) {
      expect(nansenLinkKind(relation)).toBeNull();
    }
  });
});

describe("isNansenServiceLabel", () => {
  it("recognises exchanges, bridges and faucets", () => {
    for (const label of ["Binance 14", "Coinbase: Hot Wallet", "OKX", "Bybit Deposit", "gate.io", "Crypto.com 3", "Wormhole: Token Bridge", "Monad Testnet Faucet", "Some CEX Hot Wallet", "Across Protocol: Spoke Pool"]) {
      expect(isNansenServiceLabel(label), label).toBe(true);
    }
  });

  it("leaves people, funds and bots alone", () => {
    for (const label of ["Smart Trader", "vitalik.eth", "Fund: Paradigm", "MEV Bot", "Token Millionaire", "Bridgewater fan", "Gemini2 deployer", ""]) {
      expect(isNansenServiceLabel(label), label).toBe(false);
    }
    expect(isNansenServiceLabel(null)).toBe(false);
  });
});
