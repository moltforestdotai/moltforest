// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityRegistry} from "../../src/IIdentityRegistry.sol";

/// @dev Mirrors the live registry: unknown agents have a zero wallet and `ownerOf` reverts.
contract MockIdentityRegistry is IIdentityRegistry {
    error ERC721NonexistentToken(uint256 tokenId);

    mapping(uint256 => address) internal owners;
    mapping(uint256 => address) internal wallets;

    function setAgent(uint256 agentId, address owner, address wallet) external {
        owners[agentId] = owner;
        wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }
}
