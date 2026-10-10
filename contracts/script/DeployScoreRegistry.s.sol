// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";

/// @notice Deploys ScoreRegistry on Monad testnet (chain id 10143) with three verifier EOAs.
/// Env:
///   VERIFIER_1, VERIFIER_2, VERIFIER_3 — distinct addresses (required)
///   DEPLOYER_PRIVATE_KEY — set to broadcast; omit to simulate
contract DeployScoreRegistry is Script {
    uint256 internal constant MONAD_TESTNET = 10143;

    function run() external returns (ScoreRegistry registry) {
        require(block.chainid == MONAD_TESTNET, "not Monad testnet");

        address v1 = vm.envAddress("VERIFIER_1");
        address v2 = vm.envAddress("VERIFIER_2");
        address v3 = vm.envAddress("VERIFIER_3");
        address[3] memory verifiers = [v1, v2, v3];

        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(deployerKey).length != 0) vm.startBroadcast(vm.parseUint(deployerKey));
        else vm.startBroadcast();
        registry = new ScoreRegistry(verifiers);
        vm.stopBroadcast();

        console.log("ScoreRegistry:", address(registry));
        console.log("Verifier 0:", registry.verifiers(0));
        console.log("Verifier 1:", registry.verifiers(1));
        console.log("Verifier 2:", registry.verifiers(2));
        console.log("Chain id:", block.chainid);
    }
}
