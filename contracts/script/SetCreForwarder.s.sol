// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";

/// @notice Cut CreScorePublisher over to production KeystoneForwarder (or back to mock).
/// Env:
///   CRE_SCORE_PUBLISHER — consumer address
///   CRE_FORWARDER — new forwarder (defaults to Monad testnet production KeystoneForwarder)
///   DEPLOYER_PRIVATE_KEY — owner key (must be Ownable owner)
contract SetCreForwarder is Script {
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant TESTNET_PROD_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    address internal constant MAINNET_PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external {
        require(block.chainid == MONAD_TESTNET || block.chainid == MONAD_MAINNET, "not Monad");
        address publisher = vm.envAddress("CRE_SCORE_PUBLISHER");
        address defaultFwd = block.chainid == MONAD_MAINNET ? MAINNET_PROD_FORWARDER : TESTNET_PROD_FORWARDER;
        address forwarder = vm.envOr("CRE_FORWARDER", defaultFwd);

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
}
