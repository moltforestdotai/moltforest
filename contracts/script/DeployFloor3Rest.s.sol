// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ScoreGateHook} from "../src/ScoreGateHook.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";

/// @notice Deploys ERC-8183 (QNTX kernel) + ScoreGateHook on Monad testnet, then
///         allowlists testnet USDC and whitelists the hook.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY — broadcast key
///   SCORE_REGISTRY — optional override (defaults to the live testnet deploy)
///   TREASURY — optional (defaults to deployer)
///   MIN_SCORE_BPS / MIN_CONFIDENCE_BPS / MIN_INDEPENDENT_CLUSTERS — optional gate thresholds
contract DeployFloor3Rest is Script {
    uint256 internal constant MONAD_TESTNET = 10143;
    address internal constant USDC_TESTNET = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    address internal constant SCORE_REGISTRY_TESTNET = 0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785;

    function run() external returns (ERC8183 market, ScoreGateHook hook) {
        require(block.chainid == MONAD_TESTNET, "not Monad testnet");

        address scoreRegistryAddr = vm.envOr("SCORE_REGISTRY", SCORE_REGISTRY_TESTNET);
        require(scoreRegistryAddr.code.length > 0, "ScoreRegistry has no code");

        address treasury = vm.envOr("TREASURY", address(0));
        uint16 minScoreBps = uint16(vm.envOr("MIN_SCORE_BPS", uint256(5_000)));
        uint16 minConfidenceBps = uint16(vm.envOr("MIN_CONFIDENCE_BPS", uint256(2_000)));
        uint32 minClusters = uint32(vm.envOr("MIN_INDEPENDENT_CLUSTERS", uint256(1)));

        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        address deployer;
        if (bytes(deployerKey).length != 0) {
            uint256 pk = vm.parseUint(deployerKey);
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
            deployer = msg.sender;
        }

        if (treasury == address(0)) treasury = deployer;

        // 0 platform / 0 evaluator fee for the hackathon demo.
        market = new ERC8183(0, 0, treasury, deployer);
        market.setPaymentTokenAllowed(USDC_TESTNET, true);

        hook = new ScoreGateHook(
            address(market), ScoreRegistry(scoreRegistryAddr), minScoreBps, minConfidenceBps, minClusters
        );
        market.setHookWhitelist(address(hook), true);

        vm.stopBroadcast();

        console.log("ERC8183:", address(market));
        console.log("ScoreGateHook:", address(hook));
        console.log("ScoreRegistry:", scoreRegistryAddr);
        console.log("USDC allowlisted:", USDC_TESTNET);
        console.log("Treasury:", treasury);
        console.log("minScoreBps:", minScoreBps);
        console.log("minConfidenceBps:", minConfidenceBps);
        console.log("minIndependentClusters:", minClusters);
        console.log("Chain id:", block.chainid);
    }
}
