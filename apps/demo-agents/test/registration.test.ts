import { describe, expect, it } from "vitest";
import { parseAgentUri } from "@moltforest/registration";
import { registrationDataUri } from "@moltforest/chain";
import { emailVerifierRegistration } from "../src/registration.js";

describe("emailVerifierRegistration", () => {
  it("parses cleanly with MoltForest's own registration parser", () => {
    const file = emailVerifierRegistration({ publicUrl: "https://api.moltforest.ai", webUrl: "https://www.moltforest.ai", agentId: 1962n });
    const parsed = parseAgentUri(registrationDataUri(file));
    expect(parsed).toMatchObject({
      uriKind: "data",
      metadataStatus: "ok",
      name: "MoltForest Email Verifier",
      image: "https://www.moltforest.ai/logo.svg",
      services: [{ name: "web", endpoint: "https://api.moltforest.ai/demo/email-verifier" }],
      x402Support: true,
      active: true,
      supportedTrust: ["reputation"],
    });
    expect(file.registrations).toEqual([{ agentId: 1962, agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e" }]);
  });

  it("lists no registration before the agent id is known", () => {
    expect(emailVerifierRegistration({ publicUrl: "https://a.test", webUrl: "https://w.test" }).registrations).toEqual([]);
  });
});
