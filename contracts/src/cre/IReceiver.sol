// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver — Keystone / CRE report receiver (Chainlink CRE)
/// @notice Implementations must advertise this interface via ERC-165.
interface IReceiver is IERC165 {
    /// @notice Handles an incoming Keystone report from the CRE Forwarder.
    /// @param metadata Workflow identity (workflowId, name, owner); unused in simulation.
    /// @param report ABI-encoded payload from the workflow.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
