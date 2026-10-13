// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";
import {IIdentityRegistry} from "../src/IIdentityRegistry.sol";

/// @notice Deploys ReceiptRegistry against the chain's ERC-8004 Identity Registry.
/// Defaults: Monad testnet `10143` or mainnet `143` Identity Registry. Override with IDENTITY_REGISTRY (e.g. Anvil).
/// The deployer key comes from DEPLOYER_PRIVATE_KEY (see scripts/deploy-receipt-registry.sh), never the command line.
/// Without it the script only simulates.
contract DeployReceiptRegistry is Script {
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant IDENTITY_REGISTRY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant IDENTITY_REGISTRY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external returns (ReceiptRegistry registry) {
        address identity = vm.envOr("IDENTITY_REGISTRY", address(0));
        if (identity == address(0)) {
            if (block.chainid == MONAD_TESTNET) identity = IDENTITY_REGISTRY_TESTNET;
            else if (block.chainid == MONAD_MAINNET) identity = IDENTITY_REGISTRY_MAINNET;
            else revert("unknown chain: set IDENTITY_REGISTRY");
        }
        require(identity.code.length > 0, "IDENTITY_REGISTRY has no code on this chain");

        // Read as a string so a malformed key reverts instead of silently falling back to the default sender.
        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(deployerKey).length != 0) vm.startBroadcast(vm.parseUint(deployerKey));
        else vm.startBroadcast();
        registry = new ReceiptRegistry(IIdentityRegistry(identity));
        vm.stopBroadcast();

        console.log("ReceiptRegistry:", address(registry));
        console.log("IdentityRegistry:", identity);
        console.log("Chain id:", block.chainid);
    }
}
