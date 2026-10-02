/** Read and submit calls to the MoltForest API. */
import type {
  AgentDetail,
  AgentListResponse,
  AgentPaymentsResponse,
  AgentReceiptsResponse,
  NetworkName,
  ReceiptSubmitResponse,
  ReceiptView,
} from "@moltforest/types";
import type { Hex } from "viem";
import type { ReceiptJson } from "@moltforest/receipts";
import { KitError } from "./net.js";

export interface FindAgentsQuery {
  network: NetworkName;
  q?: string;
  payments?: "any" | "received" | "sent";
  includeIncomplete?: boolean;
  limit: number;
}

export interface ReceiptSubmission {
  network: "testnet";
  receipt: ReceiptJson;
  providerSignature: Hex;
  clientSignature?: Hex;
}

export class MoltForestApi {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  findAgents(query: FindAgentsQuery): Promise<AgentListResponse> {
    const params = new URLSearchParams({ network: query.network, limit: String(query.limit) });
    if (query.q) params.set("q", query.q);
    if (query.payments) params.set("payments", query.payments);
    if (query.includeIncomplete) params.set("includeIncomplete", "true");
    return this.get(`/v1/agents?${params}`);
  }

  agent(network: NetworkName, agentId: string): Promise<AgentDetail> {
    return this.get(`/v1/agents/${network}/${agentId}`);
  }

  receipts(network: NetworkName, agentId: string, limit = 10): Promise<AgentReceiptsResponse> {
    return this.get(`/v1/agents/${network}/${agentId}/receipts?role=any&limit=${limit}`);
  }

  payments(network: NetworkName, agentId: string, limit = 10): Promise<AgentPaymentsResponse> {
    return this.get(`/v1/agents/${network}/${agentId}/payments?direction=any&limit=${limit}`);
  }

  async receipt(receiptHash: Hex): Promise<ReceiptView | null> {
    try {
      return await this.get<ReceiptView>(`/v1/receipts/${receiptHash}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async submitReceipt(body: ReceiptSubmission): Promise<ReceiptSubmitResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/receipts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return this.parse<ReceiptSubmitResponse>(res);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return body as T;
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new ApiError(res.status, `MoltForest API: ${typeof message === "string" ? message : `HTTP ${res.status}`}`);
  }
}

export class ApiError extends KitError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
