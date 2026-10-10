// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IERC8183 — Agentic Commerce Protocol (trimmed to what MoltForest needs)
/// @dev Field layout matches qntx/market-contract. Full ABI is not vendored; only the job view
///      and fund selector used by ScoreGateHook.
interface IERC8183 {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        JobStatus status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
        uint256 settledAmount;
        address payoutReceiver;
    }

    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams) external;

    function getJob(uint256 jobId) external view returns (Job memory);
}
