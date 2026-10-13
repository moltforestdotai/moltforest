// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";

/// @notice Deploys CreScorePublisher on Monad testnet (10143) or mainnet (143).
/// Env:
///   SCORE_REGISTRY — existing ScoreRegistry (required)
///   CRE_FORWARDER  — optional; defaults: testnet MockForwarder / mainnet prod KeystoneForwarder
///   DEPLOYER_PRIVATE_KEY — set to broadcast
///
/// Forwarders (Chainlink CRE directory):
///   testnet mock:  0xB9F79d863261869B234c481D1f9A7af84AeAd192
///   testnet prod:  0xF8344CFd5c43616a4366C34E3EEE75af79a74482
///   mainnet mock:  0x9eF6468C5f37b976E57d52054c693269479A784d  (simulate --broadcast)
///   mainnet prod:  0x76c9cf548b4179F8901cda1f8623568b58215E62
///
/// Defaults to MockForwarder on both nets so CRE simulate works. Set CRE_MODE=production
/// or CRE_FORWARDER=… for live DON.
contract DeployCreScorePublisher is Script {
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant TESTNET_MOCK_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
    address internal constant TESTNET_PROD_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    address internal constant MAINNET_MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant MAINNET_PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external returns (CreScorePublisher publisher) {
        require(block.chainid == MONAD_TESTNET || block.chainid == MONAD_MAINNET, "not Monad");

        address registry = vm.envAddress("SCORE_REGISTRY");
        address forwarder = _resolveForwarder();

        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(deployerKey).length != 0) {
            // Accept hex with or without 0x (forge parseUint requires the prefix).
            if (bytes(deployerKey)[0] != "0") {
                deployerKey = string.concat("0x", deployerKey);
            }
            vm.startBroadcast(vm.parseUint(deployerKey));
        } else {
            vm.startBroadcast();
        }
        publisher = new CreScorePublisher(forwarder, registry);
        vm.stopBroadcast();

        console.log("CreScorePublisher:", address(publisher));
        console.log("ScoreRegistry:", registry);
        console.log("Forwarder:", forwarder);
        console.log("Chain id:", block.chainid);
    }

    function _resolveForwarder() internal view returns (address) {
        address overrideFwd = vm.envOr("CRE_FORWARDER", address(0));
        if (overrideFwd != address(0)) return overrideFwd;
        string memory mode = vm.envOr("CRE_MODE", string("simulation"));
        bool prod = keccak256(bytes(mode)) == keccak256(bytes("production"));
        if (block.chainid == MONAD_MAINNET) {
            return prod ? MAINNET_PROD_FORWARDER : MAINNET_MOCK_FORWARDER;
        }
        return prod ? TESTNET_PROD_FORWARDER : TESTNET_MOCK_FORWARDER;
    }
}
