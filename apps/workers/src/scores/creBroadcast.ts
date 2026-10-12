import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

export interface CreBroadcastResult {
  ok: boolean;
  txHash: `0x${string}` | null;
  skipped: boolean;
  output: string;
  error?: string;
}

/**
 * Run `cre workflow simulate epoch-publisher --broadcast` on the VPS.
 * Requires CRE CLI on PATH, auth (`cre login` or CRE_API_KEY), and cre/.env with CRE_ETH_PRIVATE_KEY.
 */
export async function runCreSimulateBroadcast(opts: {
  creDir: string;
  target?: string;
  timeoutMs?: number;
}): Promise<CreBroadcastResult> {
  const creDir = resolve(opts.creDir);
  const target = opts.target ?? "local-simulation";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  try {
    await access(resolve(creDir, "project.yaml"));
  } catch {
    return { ok: false, txHash: null, skipped: false, output: "", error: `CRE project not found at ${creDir}` };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(
      "cre",
      ["workflow", "simulate", "epoch-publisher", "--target", target, "--broadcast", "-e", ".env"],
      {
        cwd: creDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    const onData = (buf: Buffer) => {
      output += buf.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({
        ok: false,
        txHash: null,
        skipped: false,
        output,
        error: `CRE simulate timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        txHash: null,
        skipped: false,
        output,
        error: err.message.includes("ENOENT")
          ? "cre CLI not found on PATH (install ≥ 1.30 and add ~/.cre/bin)"
          : err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const skipped = /"skipped"\s*:\s*true/.test(output) || /already published/i.test(output);
      const txMatch = output.match(/CreScorePublisher write tx:\s*(0x[a-fA-F0-9]{64})/);
      const jsonTx = output.match(/"txHash"\s*:\s*"(0x[a-fA-F0-9]{64})"/);
      const raw = (txMatch?.[1] ?? jsonTx?.[1] ?? null) as `0x${string}` | null;
      const txHash = raw && raw !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? raw : null;
      resolvePromise({
        ok: code === 0 && (skipped || !!txHash),
        txHash,
        skipped,
        output,
        error: code === 0 ? undefined : `cre exited ${code}`,
      });
    });
  });
}
