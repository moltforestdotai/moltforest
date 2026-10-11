// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {ScoreRegistry} from "./ScoreRegistry.sol";

/// @title CreScorePublisher — CRE consumer that publishes ScoreRegistry epochs
/// @notice Neutral on-chain publisher for Floor 3. CRE (via Keystone Forwarder) delivers a
///         report containing epoch roots + 2-of-3 verifier signatures; this contract calls
///         `ScoreRegistry.publishEpoch`. Scoring still happens off-chain; CRE is the clock + courier.
///
/// Report ABI (must stay in sync with `cre/epoch-publisher` workflow):
///   (uint64 epochId, bytes32 inputsRoot, bytes32 scoresRoot, bytes32 algoHash, bytes sig0, bytes sig1)
///
/// Network: Monad testnet. Use MockKeystoneForwarder for `cre workflow simulate --broadcast`,
/// production KeystoneForwarder after deploy (see FLOOR3.md / Chainlink Forwarder Directory).
contract CreScorePublisher is ReceiverTemplate {
    ScoreRegistry public immutable scoreRegistry;

    event EpochPublishRequested(uint64 indexed epochId, bytes32 scoresRoot);

    error ZeroRegistry();

    constructor(address forwarder_, address scoreRegistry_) ReceiverTemplate(forwarder_) {
        if (scoreRegistry_ == address(0)) revert ZeroRegistry();
        scoreRegistry = ScoreRegistry(scoreRegistry_);
    }

    /// @inheritdoc ReceiverTemplate
    function _processReport(bytes calldata report) internal override {
        (
            uint64 epochId,
            bytes32 inputsRoot,
            bytes32 scoresRoot,
            bytes32 algoHash,
            bytes memory sig0,
            bytes memory sig1
        ) = abi.decode(report, (uint64, bytes32, bytes32, bytes32, bytes, bytes));

        bytes[2] memory signatures;
        signatures[0] = sig0;
        signatures[1] = sig1;

        emit EpochPublishRequested(epochId, scoresRoot);
        scoreRegistry.publishEpoch(epochId, inputsRoot, scoresRoot, algoHash, signatures);
    }
}
