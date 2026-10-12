import { describe, expect, it } from "vitest";
import { computeScore } from "../src/compute.js";
import { loadScoresFromDb, scoreInputsFromSummaryRows, scoresFromSummaryRows } from "../src/fromDb.js";

describe("scoreInputsFromSummaryRows", () => {
  it("maps review summary rows to ScoreInputs and AgentScore", () => {
    const rows = [
      { agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: "30000" },
      { agentId: "42", verifiedReviews: 1, countedReviewers: 1, totalPaidVolume: 0 },
    ];
    expect(scoreInputsFromSummaryRows(rows)).toEqual([
      { agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: "30000" },
      { agentId: "42", verifiedReviews: 1, countedReviewers: 1, totalPaidVolume: 0 },
    ]);
    expect(scoresFromSummaryRows(rows)[0]).toEqual(
      computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: "30000" }),
    );
  });
});

describe("loadScoresFromDb", () => {
  it("builds scores from a SQL result set", async () => {
    const db = {
      async query(_text: string, values?: unknown[]) {
        expect(values).toEqual([10143]);
        return {
          rows: [
            {
              agent_id: "7",
              verified_reviews: 3,
              counted_reviewers: 2,
              total_paid_volume: "30000",
            },
            {
              agent_id: "100",
              verified_reviews: 0,
              counted_reviewers: 1,
              total_paid_volume: "0",
            },
          ],
        };
      },
    };
    const scores = await loadScoresFromDb({ db, chainId: 10143 });
    expect(scores).toHaveLength(2);
    expect(scores[0]).toEqual(
      computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: "30000" }),
    );
    expect(scores[1]!.independentClusters).toBe(1);
  });

  it("throws when no rows match", async () => {
    const db = {
      async query() {
        return { rows: [] };
      },
    };
    await expect(loadScoresFromDb({ db, chainId: 10143 })).rejects.toThrow(/No agent_review_summary/);
  });

  it("loads every indexed Agent with zero scores when allAgents", async () => {
    const db = {
      async query(text: string, values?: unknown[]) {
        expect(values).toEqual([10143]);
        expect(text).toMatch(/"Agent"/);
        expect(text).toMatch(/LEFT JOIN/);
        return {
          rows: [
            { agent_id: "1", verified_reviews: 0, counted_reviewers: 0, total_paid_volume: "0" },
            { agent_id: "7", verified_reviews: 3, counted_reviewers: 2, total_paid_volume: "30000" },
          ],
        };
      },
    };
    const scores = await loadScoresFromDb({ db, chainId: 10143, allAgents: true });
    expect(scores).toHaveLength(2);
    expect(scores[0]).toEqual(computeScore({ agentId: "1", verifiedReviews: 0, countedReviewers: 0 }));
    expect(scores[1]!.scoreBps).toBeGreaterThan(0);
  });
});
