import { describe, expect, it } from "vitest";
import { HostLimiter } from "../src/net/hostLimiter.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HostLimiter", () => {
  it("caps concurrent requests per host", async () => {
    const limiter = new HostLimiter(2, 0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run("a.example", async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(10);
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("spaces request starts per host but not across hosts", async () => {
    const limiter = new HostLimiter(10, 50);
    const starts: Record<string, number[]> = { a: [], b: [] };
    const t0 = Date.now();
    await Promise.all(
      ["a", "a", "a", "b", "b", "b"].map((h) => limiter.run(h, async () => void starts[h]!.push(Date.now() - t0))),
    );
    for (const h of ["a", "b"]) {
      const s = starts[h]!.sort((x, y) => x - y);
      expect(s[1]! - s[0]!).toBeGreaterThanOrEqual(45);
      expect(s[2]! - s[1]!).toBeGreaterThanOrEqual(45);
    }
    // Hosts run in parallel: the whole thing takes ~100ms, not ~250ms.
    expect(Math.max(...starts.a!, ...starts.b!)).toBeLessThan(200);
  });

  it("releases the slot when the task throws", async () => {
    const limiter = new HostLimiter(1, 0);
    await expect(limiter.run("h", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limiter.run("h", async () => "next")).resolves.toBe("next");
  });
});
