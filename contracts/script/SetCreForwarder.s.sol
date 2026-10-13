// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";

/// @notice Cut CreScorePublisher between simulation MockForwarder and production KeystoneForwarder.
/// Env:
///   CRE_SCORE_PUBLISHER — consumer address
///   CRE_MODE — `production` (default) | `simulation`
///   CRE_FORWARDER — optional explicit override
///   DEPLOYER_PRIVATE_KEY — owner key (must be Ownable owner)
contract SetCreForwarder is Script {
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant TESTNET_MOCK_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
    address internal constant TESTNET_PROD_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    address internal constant MAINNET_MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant MAINNET_PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external {
        require(block.chainid == MONAD_TESTNET || block.chainid == MONAD_MAINNET, "not Monad");
        address publisher = vm.envAddress("CRE_SCORE_PUBLISHER");
        address forwarder = _resolveForwarder();

        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(deployerKey).length != 0) {
            if (bytes(deployerKey)[0] != "0") deployerKey = string.concat("0x", deployerKey);
            vm.startBroadcast(vm.parseUint(deployerKey));
        } else {
            vm.startBroadcast();
        }
        CreScorePublisher(publisher).setForwarderAddress(forwarder);
        vm.stopBroadcast();

        console.log("CreScorePublisher:", publisher);
        console.log("New forwarder:", forwarder);
    }

    function _resolveForwarder() internal view returns (address) {
        address overrideFwd = vm.envOr("CRE_FORWARDER", address(0));
        if (overrideFwd != address(0)) return overrideFwd;
        string memory mode = vm.envOr("CRE_MODE", string("production"));
        bool sim = keccak256(bytes(mode)) == keccak256(bytes("simulation"));
        if (block.chainid == MONAD_MAINNET) {
            return sim ? MAINNET_MOCK_FORWARDER : MAINNET_PROD_FORWARDER;
        }
        return sim ? TESTNET_MOCK_FORWARDER : TESTNET_PROD_FORWARDER;
    }
}
