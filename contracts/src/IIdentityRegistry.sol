// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of the ERC-8004 Identity Registry (v2.0.0) that ReceiptRegistry reads.
/// @dev Verified on Monad testnet 2026-09-29: `getAgentWallet` returns address(0) when no wallet is set
///      (also for unknown agents), while `ownerOf` reverts for unknown agents.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}
