import { createAgentsExist, findHighestAgentId, type AgentsExist, type NetworkName } from "@moltforest/chain";

export interface ChainCheckResult {
  highestAgentId: string | null;
  checkedAt: Date | null;
  error: string | null;
}

export interface ChainChecker {
  highestAgentId(network: NetworkName, knownId: string | null): Promise<ChainCheckResult>;
}

interface Options {
  ttlMs: number;
  timeoutMs?: number;
  rpcUrls?: Partial<Record<NetworkName, string>>;
  existsFactory?: (network: NetworkName, rpcUrl?: string) => AgentsExist;
}

/**
 * Reconciler check: asks the chain for its highest agent id so /v1/sync-status
 * can report whether the index is missing agents. Results are cached per
 * network, concurrent callers share one in-flight probe, and once a result
 * exists it is served immediately while a stale one refreshes in the background.
 */
export function createChainChecker({ ttlMs, timeoutMs = 20_000, rpcUrls = {}, existsFactory = createAgentsExist }: Options): ChainChecker {
  const cache = new Map<NetworkName, ChainCheckResult>();
  const inFlight = new Map<NetworkName, Promise<ChainCheckResult>>();
  const existsByNetwork = new Map<NetworkName, AgentsExist>();

  async function probe(network: NetworkName, knownId: string | null): Promise<ChainCheckResult> {
    let exists = existsByNetwork.get(network);
    if (!exists) {
      exists = existsFactory(network, rpcUrls[network]);
      existsByNetwork.set(network, exists);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`chain check timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const highest = await Promise.race([findHighestAgentId(exists, knownId === null ? null : BigInt(knownId)), timeout]);
      return { highestAgentId: highest === null ? null : highest.toString(), checkedAt: new Date(), error: null };
    } catch (err) {
      const previous = cache.get(network);
      return {
        highestAgentId: previous?.highestAgentId ?? null,
        checkedAt: previous?.checkedAt ?? null,
        error: err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "chain check failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(network: NetworkName, knownId: string | null): Promise<ChainCheckResult> {
    let pending = inFlight.get(network);
    if (!pending) {
      // probe() never rejects, so background refreshes cannot leak unhandled rejections.
      pending = probe(network, knownId).then((result) => {
        cache.set(network, result);
        inFlight.delete(network);
        return result;
      });
      inFlight.set(network, pending);
    }
    return pending;
  }

  return {
    async highestAgentId(network, knownId) {
      const cached = cache.get(network);
      const fresh = cached?.checkedAt && !cached.error && Date.now() - cached.checkedAt.getTime() < ttlMs;
      if (cached && fresh) return cached;
      const pending = refresh(network, knownId);
      return cached ?? pending; // stale-while-revalidate; only the very first call waits
    },
  };
}
