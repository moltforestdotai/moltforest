// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseERC8183Hook} from "./erc8183/BaseERC8183Hook.sol";
import {IERC8183} from "./erc8183/IERC8183.sol";
import {ScoreRegistry} from "./ScoreRegistry.sol";

/// @title ScoreGateHook
/// @notice ERC-8183 hook: on `fund()`, require the provider's published score to clear thresholds,
///         and reject jobs where client / provider / evaluator share a funding cluster.
///
/// `fund` optParams ABI:
///   (uint64 epochId, ScoreRegistry.Score score, bytes32[] scoreProof,
///    bytes32 clientCluster, bytes32 providerCluster, bytes32 evaluatorCluster)
///
/// Cluster roots come from MoltForest's off-chain union-find (same values shown in the dashboard).
/// For the hackathon demo they are passed in optParams; a future epoch may Merkle-commit them too.
/// If score verification fails, the call reverts (safe fallback: never silent pass).
///
/// Deploy on Monad testnet against a testnet ERC-8183 instance (we deploy our own; there is no
/// official QNTX 8183 on testnet — mainnet-only at 0xE8c4…0725).
contract ScoreGateHook is BaseERC8183Hook {
    ScoreRegistry public immutable scoreRegistry;

    uint16 public immutable minScoreBps;
    uint16 public immutable minConfidenceBps;
    uint32 public immutable minIndependentClusters;

    error ScoreTooLow(uint16 scoreBps, uint16 minScoreBps_);
    error ConfidenceTooLow(uint16 confidenceBps, uint16 minConfidenceBps_);
    error NotEnoughClusters(uint32 clusters, uint32 minClusters);
    error AgentIdMismatch(uint256 expected, uint256 got);
    error InvalidScoreProof();
    error ColludingCluster();
    error BadOptParams();

    constructor(
        address erc8183_,
        ScoreRegistry scoreRegistry_,
        uint16 minScoreBps_,
        uint16 minConfidenceBps_,
        uint32 minIndependentClusters_
    ) BaseERC8183Hook(erc8183_) {
        if (address(scoreRegistry_) == address(0)) revert ZeroAddress();
        scoreRegistry = scoreRegistry_;
        minScoreBps = minScoreBps_;
        minConfidenceBps = minConfidenceBps_;
        minIndependentClusters = minIndependentClusters_;
    }

    /// @inheritdoc BaseERC8183Hook
    function _preFund(
        uint256 jobId,
        address,
        /* caller */
        bytes memory optParams
    )
        internal
        view
        override
    {
        if (optParams.length == 0) revert BadOptParams();

        (
            uint64 epochId,
            ScoreRegistry.Score memory score,
            bytes32[] memory scoreProof,
            bytes32 clientCluster,
            bytes32 providerCluster,
            bytes32 evaluatorCluster
        ) = abi.decode(optParams, (uint64, ScoreRegistry.Score, bytes32[], bytes32, bytes32, bytes32));

        IERC8183.Job memory job = IERC8183(erc8183Contract).getJob(jobId);
        if (score.agentId != job.providerAgentId) revert AgentIdMismatch(job.providerAgentId, score.agentId);

        if (!scoreRegistry.verifyScore(epochId, score, scoreProof)) revert InvalidScoreProof();

        if (score.scoreBps < minScoreBps) revert ScoreTooLow(score.scoreBps, minScoreBps);
        if (score.confidenceBps < minConfidenceBps) revert ConfidenceTooLow(score.confidenceBps, minConfidenceBps);
        if (score.independentClusters < minIndependentClusters) {
            revert NotEnoughClusters(score.independentClusters, minIndependentClusters);
        }

        // Independence check: same non-zero cluster root ⇒ treat as one actor behind multiple roles.
        if (
            (clientCluster != bytes32(0) && clientCluster == providerCluster)
                || (providerCluster != bytes32(0) && providerCluster == evaluatorCluster)
                || (clientCluster != bytes32(0) && clientCluster == evaluatorCluster)
        ) {
            revert ColludingCluster();
        }
    }
}
